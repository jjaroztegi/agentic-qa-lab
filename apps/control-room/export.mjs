#!/usr/bin/env node
// Static, self-contained replay of one run: index.html + assets + runs.json + events.json + files/.
// Works from any static host (GitHub Pages, an artifact viewer) or straight from disk via a local server.
//   node apps/control-room/export.mjs <run> <outDir>     (control room at CONTROL_URL, default http://127.0.0.1:17000)
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { journeyOf } from "./src/shared/summary.ts";

const [run, out] = process.argv.slice(2);
if (!run || !out) { console.error("usage: node apps/control-room/export.mjs <run> <outDir>"); process.exit(2); }
const BASE = (process.env.CONTROL_URL ?? process.env.QA_EVENTS_URL ?? "http://127.0.0.1:17000").replace(/\/+$/, "");
const DIST = fileURLToPath(new URL("./dist", import.meta.url));
if (!existsSync(join(DIST, "index.html"))) { console.error("Web UI not built: run npm run build in apps/control-room"); process.exit(1); }

async function get(path) {
  const r = await fetch(`${BASE}${path}`).catch((e) => {
    console.error(`Cannot reach the control room at ${BASE} (${e.cause?.code ?? e.message}). Set CONTROL_URL.`);
    process.exit(1);
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r;
}
const json = async (path) => (await get(path)).json();

const self = await json(`/api/runs/${encodeURIComponent(run)}`);
const runs = journeyOf(self, await json("/api/runs?limit=1000"));
const events = await json(`/api/runs/${encodeURIComponent(run)}/events`);
const catalog = (await json("/api/catalog").catch(() => [])).filter((c) => c.id === self.info.case);

mkdirSync(join(out, "files"), { recursive: true });
cpSync(join(DIST, "assets"), join(out, "assets"), { recursive: true });
let copied = 0;
for (const [name, f] of Object.entries(self.summary.files ?? {})) {
  if (!String(f.url).startsWith("/api/")) continue; // external links stay as they are
  const r = await get(f.url).catch((e) => { console.warn(`  skipped ${name}: ${e.message}`); return null; });
  if (!r) continue;
  writeFileSync(join(out, "files", name), Buffer.from(await r.arrayBuffer()));
  copied++;
}
writeFileSync(join(out, "runs.json"), JSON.stringify(runs));
writeFileSync(join(out, "events.json"), JSON.stringify(events));
writeFileSync(join(out, "catalog.json"), JSON.stringify(catalog));
const marker = `<script>window.__CONTROL_STATIC__=${JSON.stringify({ run }).replace(/</g, "\\u003c")}</script>`;
const html = readFileSync(join(DIST, "index.html"), "utf8").replace("</head>", `${marker}\n</head>`);
writeFileSync(join(out, "index.html"), html);
console.log(`Replay of ${run}: ${out} (${events.length} events, ${copied} files). Serve it with any static server.`);
