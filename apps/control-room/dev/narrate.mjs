#!/usr/bin/env node
// Prints the human narration of a stream-json log, to eyeball the mapping:
//   node apps/control-room/dev/narrate.mjs apps/control-room/fixtures/qa-author-maintenance.jsonl
import { readFileSync } from "node:fs";
import { Narrator, PHASES, fmtDuration } from "../src/shared/narrate.ts";

const n = new Narrator();
const lines = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let ts = Date.parse(lines.find((l) => l.timestamp)?.timestamp ?? "") || Date.now();
for (const l of lines) n.push(l, (ts = Date.parse(l.timestamp ?? "") || ts));
const t0 = n.totals.startedAt ?? 0;
let phase;
for (const it of n.items) {
  if (it.phase !== phase) console.log(`\n== ${PHASES[(phase = it.phase)]}`);
  const mark = { ok: "✓", fail: "✗", warn: "!", running: "…" }[it.status] ?? " ";
  const text = it.kind === "report" ? `Report: ${it.text.slice(0, 200).replace(/\n/g, " ")}…` : it.text;
  console.log(`${fmtDuration(it.t - t0).padStart(10)} ${mark} ${it.sub ? `  [${it.sub}] ` : ""}${text}${it.detail ? `  — ${it.detail}` : ""}`);
}
console.log("\n", n.totals);
