#!/usr/bin/env node
// Replays a recorded agent run into a running control room, as the real pipeline would emit it:
// intake run (n8n) -> author run (CI: env, agent lines at speed, prove with business steps, push, review).
//   node apps/control-room/dev/replay.mjs apps/control-room/fixtures/qa-author-desktop-auto-hold.jsonl --speed 20
//   node apps/control-room/dev/replay.mjs apps/control-room/fixtures/qa-author-maintenance.jsonl --speed 20
// Options: --url http://127.0.0.1:17000  --case CP-005  --pr 42  --vnc ws://127.0.0.1:6080/websockify
//          --media <dir> (screenshots + screen.mp4 of the whole run; default fixtures/media/<fixture name
//          without qa-author[-desktop]->, e.g. auto-hold)  --no-intake  --merge
// The case (title, steps) comes from catalog/cases/<case>.yaml, or else from the case file the agent read.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Narrator } from "../src/shared/narrate.ts";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const fixture = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!fixture || flag("help")) { console.error("usage: replay.mjs <fixture.jsonl> [--speed 20] [--url …] [--case CP-xxx] [--pr N] [--vnc ws://…] [--media dir] [--no-intake] [--merge]"); process.exit(flag("help") ? 0 : 2); }
const URL_ = opt("url", process.env.QA_EVENTS_URL ?? "http://127.0.0.1:17000").replace(/\/+$/, "");
const SPEED = Number(opt("speed", 20));
const here = fileURLToPath(new URL(".", import.meta.url));
const text = readFileSync(fixture, "utf8");
const lines = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const CASE = opt("case", /catalog\/cases\/(CP-\d{3})/.exec(text)?.[1] ?? /CP-\d{3}/.exec(text)?.[0] ?? "CP-000");
const PR = Number(opt("pr", 40 + Number(CASE.slice(-3))));
const stamp = Date.now().toString(36);
const runIntake = `intake_${stamp}`;
const runAuthor = `author_${stamp}`;
const desktop = /desktop/.test(basename(fixture)) || text.includes("agent-desktop");
const skill = desktop ? "qa-author-desktop" : "qa-author";
const caseFile = join(here, "../../../catalog/cases", `${CASE}.yaml`);
const kase = existsSync(caseFile) ? parse(readFileSync(caseFile, "utf8")) : caseFromTranscript() ?? { title: CASE, steps: [] };
const mediaDir = opt("media", [basename(fixture, ".jsonl").replace(/^qa-author(-desktop)?-/, ""), CASE.toLowerCase()]
  .map((d) => join(here, "../fixtures/media", d)).find((d) => existsSync(d)) ?? "");
const media = mediaDir && existsSync(mediaDir) ? readdirSync(mediaDir).sort() : [];

// Cases authored in a scenario are not in this checkout's catalog: take the YAML the agent printed
// (`cat catalog/cases/<case>.yaml`), from its `id:` line (and leading comments) to the next non-YAML line.
function caseFromTranscript() {
  for (const l of lines) for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
    if (b?.type !== "tool_result") continue;
    const out = (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n")).split("\n");
    let i = out.indexOf(`id: ${CASE}`);
    if (i < 0) continue;
    while (i > 0 && out[i - 1].startsWith("#")) i--;
    let j = i + 1;
    while (j < out.length && /^(\s|#|[\w-]+:)/.test(out[j])) j++;
    try { const k = parse(out.slice(i, j).join("\n")); if (k?.title) return k; } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(events) {
  const r = await fetch(`${URL_}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
}
const stage = (run, stage, status, title, extra = {}) => post([{ run, source: run === runIntake ? "n8n" : "ci", kind: "stage", stage, status, case: CASE, pr: PR, ...(title ? { title } : {}), ...extra }]);
async function upload(run, path, name = basename(path)) {
  await fetch(`${URL_}/api/runs/${encodeURIComponent(run)}/files/${encodeURIComponent(name)}?source=test`, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body: readFileSync(path),
  });
}

// What the recorded agent concluded about its own test, to tell the proof stage how it ends.
const n = new Narrator();
for (const l of lines) n.push(l, Date.parse(l.timestamp ?? "") || undefined);
const lastTest = [...n.items].reverse().find((i) => i._test && i.status !== "warn");
const proven = lastTest?.status === "ok";

console.log(`Control room: ${URL_}  case ${CASE}  run ${runAuthor}  speed ×${SPEED}`);
console.log(`Live: ${URL_}/live/${runAuthor}   Replay: ${URL_}/runs/${runAuthor}`);

if (!flag("no-intake")) {
  await post([{ run: runIntake, source: "n8n", kind: "run", case: CASE, data: { workflow: "intake", title: kase.title, case: CASE } }]);
  await stage(runIntake, "intake", "ok", "Intake form received");
  await sleep(600);
  await stage(runIntake, "draft", "ok", `catalog/cases/${CASE}.yaml`);
  await sleep(600);
  await stage(runIntake, "pr", "ok", `PR #${PR} labeled automate`);
  await sleep(800);
}

await post([{ run: runAuthor, source: "ci", kind: "run", case: CASE, pr: PR, data: {
  workflow: "author", case: CASE, pr: PR, skill, title: kase.title, repo: opt("repo", undefined),
  ...(opt("vnc") ? { vnc: opt("vnc"), novnc: opt("novnc", opt("vnc").replace(/^ws/, "http").replace(/\/websockify.*$/, "/vnc.html")) } : {}),
} }]);
await stage(runAuthor, "env", "start", "Copy of the ERP and MES for this change");
await sleep(1500);
await stage(runAuthor, "env", "ok");
// The screen recording covers the whole run from here, as tools/pipeline/author.sh records it.
const video = media.find((f) => /\.(mp4|webm)$/.test(f));
if (video) await post([{ run: runAuthor, source: "test", kind: "note", title: "Screen recording", data: { recording_started_at: new Date().toISOString() } }]);
await stage(runAuthor, "agent", "start", skill);

// Agent lines at the recorded pace, sped up.
let prev;
let batch = [];
let lastFlush = Date.now();
for (const l of lines) {
  const t = Date.parse(l.timestamp ?? "");
  if (prev && t) await sleep(Math.min(4000, Math.max(0, (t - prev) / SPEED)));
  if (t) prev = t;
  batch.push({ run: runAuthor, source: "agent", kind: "agent-line", data: l });
  if (Date.now() - lastFlush > 250 || batch.length > 50) { await post(batch); batch = []; lastFlush = Date.now(); }
}
if (batch.length) await post(batch);
const agentOk = !lines.find((l) => l.type === "result")?.is_error;
await stage(runAuthor, "agent", agentOk ? "ok" : "fail");

// Proof outside the agent: the business steps tick while the screen recording runs.
await stage(runAuthor, "prove", "start", "Three passes outside the agent");
const shots = media.filter((f) => /\.(png|jpe?g)$/.test(f));
const proveSecs = 6;
const steps = kase.steps ?? [];
for (let i = 0; i < steps.length; i++) {
  await sleep((proveSecs * 1000) / (steps.length + 1));
  // Each step gets its share of the screenshots (all uploaded) and shows the first of them.
  const share = shots.slice(Math.floor((i * shots.length) / steps.length), Math.floor(((i + 1) * shots.length) / steps.length));
  const shot = share[0] ?? shots[Math.min(shots.length - 1, Math.floor((i * shots.length) / steps.length))];
  for (const f of share.length ? share : shot ? [shot] : []) await upload(runAuthor, join(mediaDir, f));
  await post([{ run: runAuthor, source: "test", kind: "step", case: CASE, data: { case: CASE, step: i + 1, status: "ok", ...(shot ? { screenshot: shot } : {}) } }]);
}
await sleep((proveSecs * 1000) / (steps.length + 1));
await post([{ run: runAuthor, source: "test", kind: "step", case: CASE, status: proven ? "ok" : "fail",
  detail: proven ? undefined : lastTest?.detail, data: { case: CASE, step: "Expected results", status: proven ? "ok" : "fail" } }]);
if (video) await upload(runAuthor, join(mediaDir, video), video.replace(/^[^.]+/, "screen"));
if (proven) {
  await stage(runAuthor, "prove", "ok", "3 of 3 passed");
  await stage(runAuthor, "push", "ok", "Test and plan pushed to the PR");
  await stage(runAuthor, "review", "start", "Waiting for an automation engineer");
  if (flag("merge")) {
    await sleep(1500);
    await stage(runAuthor, "review", "ok", "Approved");
    await stage(runAuthor, "merge", "ok", "Merged into main");
  }
  await post([{ run: runAuthor, source: "ci", kind: "result", status: "ok", case: CASE, title: "Test ready for review" }]);
} else {
  await stage(runAuthor, "prove", "fail", "The case does not hold: the agent explains why in the PR", { detail: lastTest?.detail });
  await post([{ run: runAuthor, source: "ci", kind: "result", status: "fail", case: CASE, title: "Mismatch between the case and the application" }]);
}
console.log("Done.");
