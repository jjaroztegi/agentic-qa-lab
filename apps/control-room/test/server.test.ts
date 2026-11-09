// End to end over HTTP: the server, the SSE stream and tools/emit.mjs as the pipeline uses it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trimAgentLine } from "../src/shared/trim.ts";

const app = fileURLToPath(new URL("..", import.meta.url));
const emit = fileURLToPath(new URL("../../../tools/emit.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/qa-author-desktop-auto-hold.jsonl", import.meta.url));
const data = mkdtempSync(join(tmpdir(), "control-room-"));
let server: ChildProcess;
let base = "";

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const runEmit = (args: string[], input?: string, url = base) =>
  spawnSync(process.execPath, [emit, ...args], { input, encoding: "utf8", env: { ...process.env, QA_EVENTS_URL: url }, timeout: 20_000 });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["src/server.ts"], { cwd: app, env: { ...process.env, PORT: String(port), DATA_DIR: data }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => { server.kill(); rmSync(data, { recursive: true, force: true }); });

test("POST /api/events rejects invalid events with reasons", async () => {
  const r = await fetch(`${base}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: "x", source: "ci", kind: "stage", stage: "deploy" }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).errors.join(), /stage: one of/);
});

test("emitter: run, stage, agent stream and file land in the run; SSE delivers them live", async () => {
  const ac = new AbortController();
  const sse = await fetch(`${base}/api/stream`, { signal: ac.signal });
  const reader = sse.body!.getReader();
  const seen: any[] = [];
  const reading = (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (const m of buf.split("\n\n").slice(0, -1)) { const d = /^data: (.+)$/m.exec(m)?.[1]; if (d) seen.push(JSON.parse(d)); }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
  })();

  assert.equal(runEmit(["run", "author_9", '{"workflow":"author","case":"CP-005","pr":42,"skill":"qa-author-desktop"}']).status, 0);
  assert.equal(runEmit(["stage", "author_9", "agent", "start", "Agent", "working"]).status, 0);
  const first = readFileSync(fixture, "utf8").split("\n").slice(0, 40);
  const lines = first.join("\n") + "\nnot json\n";
  const piped = runEmit(["agent", "author_9"], lines);
  assert.equal(piped.status, 0);
  assert.equal(piped.stdout, "", "agent mode prints nothing");
  const shot = join(data, "shot.png");
  writeFileSync(shot, Buffer.alloc(5000, 7));
  assert.equal(runEmit(["file", "author_9", shot, "01-client.png"]).status, 0);

  const run = await (await fetch(`${base}/api/runs/author_9`)).json();
  assert.equal(run.info.skill, "qa-author-desktop");
  assert.equal(run.summary.stages.agent.title, "Agent working");
  assert.equal(run.summary.files["01-client.png"].size, 5000);
  const events = await (await fetch(`${base}/api/runs/author_9/events`)).json();
  // Token counters and progress heartbeats are dropped on the way in.
  assert.equal(events.filter((e: any) => e.kind === "agent-line").length, first.filter((l) => trimAgentLine(JSON.parse(l))).length);

  const part = await fetch(`${base}/api/runs/author_9/files/01-client.png`, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  for (let i = 0; i < 30 && seen.length < events.length; i++) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await reading;
  assert.deepEqual(seen.map((e) => e.id), events.map((e: any) => e.id), "the stream carried every stored event, in order");
});

test("emitter never fails its caller: no URL is a no-op, a dead server is swallowed", async () => {
  const none = runEmit(["agent", "x"], "{\"type\":\"system\"}\n", "");
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");
  const dead = await freePort();
  const t = Date.now();
  assert.equal(runEmit(["stage", "x", "env", "ok"], undefined, `http://127.0.0.1:${dead}`).status, 0);
  assert.equal(runEmit(["file", "x", "/no/such/file"]).status, 0);
  assert.ok(Date.now() - t < 10_000);
});

test("pages under /runs/ get a base href so relative assets resolve", async (t) => {
  const r = await fetch(`${base}/runs/author_9`);
  if (r.status === 503) return t.skip("web UI not built");
  assert.match(await r.text(), /<head><base href="\/">/);
});
