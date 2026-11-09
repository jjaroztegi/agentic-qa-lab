// Control room: collects events from n8n, CI, agents, tests and the lab; serves them live (SSE)
// and afterwards (runs, events, files), plus the web UI built into dist/.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseBody, safeSegment, SOURCES, type QaEvent, type Source } from "./shared/contract.ts";
import { openStore } from "./store.ts";
import { loadCatalog } from "./catalog.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DATA = resolve(process.env.DATA_DIR ?? here("../data"));
const FILES = join(DATA, "files");
const DIST = here("../dist");
const REPO = here("../../../");
const catalogOpts = {
  catalogDir: process.env.CATALOG_DIR ?? join(REPO, "catalog/cases"),
  draftsDir: process.env.DRAFTS_DIR ?? join(REPO, "docs/drafts/cases"),
  testsDir: process.env.TESTS_DIR ?? join(REPO, "tests"),
};

const store = openStore(process.env.CONTROL_DB ?? join(DATA, "control.db"));
const listeners = new Set<(events: QaEvent[]) => void>();
function ingest(events: QaEvent[]): QaEvent[] {
  const stored = store.append(events);
  if (stored.length) for (const l of listeners) l(stored);
  return stored;
}

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

app.post("/api/events", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ errors: ["body must be JSON"] }, 400);
  const { events, errors } = parseBody(body);
  if (errors.length) return c.json({ errors }, 400);
  const stored = ingest(events);
  return c.json({ accepted: events.length, stored: stored.length, ids: stored.map((e) => e.id) }, 202);
});

app.get("/api/runs", (c) => c.json(store.runs(Number(c.req.query("limit") ?? 200))));
app.get("/api/runs/:run", (c) => {
  const r = store.run(c.req.param("run"));
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});
app.get("/api/runs/:run/events", (c) => c.json(store.events(c.req.param("run"), Number(c.req.query("after") ?? 0))));

// Files: the run's screen recording, reports, screenshots. Raw body in, Range-capable out.
app.put("/api/runs/:run/files/:name", async (c) => {
  const run = c.req.param("run");
  const name = safeSegment(basename(c.req.param("name")));
  const source = (c.req.query("source") ?? "ci") as Source;
  if (!SOURCES.includes(source)) return c.json({ errors: [`source: one of ${SOURCES.join("|")}`] }, 400);
  if (!c.req.raw.body) return c.json({ errors: ["empty body"] }, 400);
  const dir = join(FILES, safeSegment(run));
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.part`);
  await pipeline(Readable.fromWeb(c.req.raw.body as any), createWriteStream(tmp));
  renameSync(tmp, join(dir, name));
  const size = statSync(join(dir, name)).size;
  const url = `/api/runs/${encodeURIComponent(run)}/files/${encodeURIComponent(name)}`;
  const [ev] = ingest([{ ts: new Date().toISOString(), run, source, kind: "artifact", title: name, data: { name, url, size } }]);
  return c.json({ name, url, size, id: ev?.id }, 201);
});
app.get("/api/runs/:run/files/:name", (c, next) => {
  const path = join(FILES, safeSegment(c.req.param("run")), safeSegment(basename(c.req.param("name"))));
  if (!existsSync(path)) return c.json({ error: "not found" }, 404);
  return serveStatic({ path })(c, next);
});

app.get("/api/catalog", (c) => c.json(loadCatalog(catalogOpts)));

// Live: every new event, in order. Reconnects resume from Last-Event-ID (or ?after=<id>).
app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    let chain = Promise.resolve();
    const send = (events: QaEvent[]) => {
      chain = chain.then(async () => { for (const e of events) await stream.writeSSE({ id: String(e.id), data: JSON.stringify(e) }); }).catch(() => {});
    };
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after"));
    if (Number.isFinite(after)) send(store.since(after));
    listeners.add(send);
    stream.onAbort(() => listeners.delete(send));
    while (!stream.aborted) {
      await stream.sleep(15_000);
      chain = chain.then(() => stream.writeSSE({ event: "ping", data: "" })).catch(() => {});
    }
    listeners.delete(send);
  }),
);

// Web UI (vite build). Assets are relative, so pages under /runs/... get a <base href="/">.
app.use("/assets/*", serveStatic({ root: DIST }));
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("*", (c) => {
  const index = join(DIST, "index.html");
  if (!existsSync(index)) return c.text("Web UI not built: run npm run build in apps/control-room", 503);
  return c.html(readFileSync(index, "utf8").replace("<head>", '<head><base href="/">'));
});

const port = Number(process.env.PORT ?? 17000);
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => console.log(`Control room at http://${hostname}:${port} (data in ${DATA})`));
Object.assign(server, { keepAliveTimeout: 65_000, headersTimeout: 66_000 });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { server.close(); store.close(); process.exit(0); });
