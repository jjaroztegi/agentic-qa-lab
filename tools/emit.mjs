#!/usr/bin/env node
// Sends events to the control room (apps/control-room). Node stdlib only, and it never fails its
// caller: no QA_EVENTS_URL -> no-op; network errors and timeouts are swallowed; exit code is always 0.
//   node tools/emit.mjs stage <run> <stage> <status> [title]
//   node tools/emit.mjs run <run> '<json data>'
//   node tools/emit.mjs file <run> <path> [name]
//   node tools/emit.mjs event '<json event or array>'
//   … | node tools/emit.mjs agent <run>      (Claude Code stream-json on stdin; prints nothing)
// QA_EVENTS_URL is the control room base URL, e.g. http://127.0.0.1:17000. QA_EVENTS_SOURCE overrides
// the event source (default: ci; agent lines are always "agent").
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const BASE = (process.env.QA_EVENTS_URL ?? "").replace(/\/+$/, "").replace(/\/api\/events$/, "");
const SOURCE = process.env.QA_EVENTS_SOURCE ?? "ci";
const TIMEOUT = Number(process.env.QA_EVENTS_TIMEOUT_MS ?? 3000);
const warn = (m) => process.env.QA_EVENTS_DEBUG && console.error(`emit: ${m}`);

async function post(events) {
  if (!BASE) return;
  try {
    const r = await fetch(`${BASE}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events), signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) warn(`${r.status} ${await r.text().catch(() => "")}`);
  } catch (e) { warn(e.message); }
}

// Replays end up on public pages: never let a secret from this process's environment through,
// whatever an agent happens to print. Values of *TOKEN*/*KEY*/*SECRET*/*PASSWORD* variables are masked.
const SECRETS = Object.entries(process.env)
  .filter(([k, v]) => /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH/i.test(k) && v && v.length >= 8)
  .map(([, v]) => v);
function redact(line) {
  for (const v of SECRETS) line = line.split(v).join("[redacted]");
  return line;
}

async function agent(run) {
  // Always drain stdin, even with no URL, so a `tee >(…)` upstream never sees a broken pipe.
  let batch = [];
  let chain = Promise.resolve();
  let downUntil = 0;
  const flush = () => {
    if (!batch.length) return;
    const events = batch;
    batch = [];
    if (Date.now() < downUntil) return;
    chain = chain.then(async () => {
      const t = Date.now();
      await post(events);
      if (Date.now() - t >= TIMEOUT) downUntil = Date.now() + 10_000; // server gone: stop waiting on it for a while
    });
  };
  const timer = setInterval(flush, 300);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!BASE || !line.trim()) continue;
    let data;
    try { data = JSON.parse(redact(line)); } catch { continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    batch.push({ ts: new Date().toISOString(), run, source: "agent", kind: "agent-line", data });
    if (batch.length >= 200) flush();
  }
  clearInterval(timer);
  flush();
  await chain;
}

async function file(run, path, name = basename(path)) {
  if (!BASE) return;
  try {
    const size = statSync(path).size;
    const r = await fetch(`${BASE}/api/runs/${encodeURIComponent(run)}/files/${encodeURIComponent(name)}?source=${encodeURIComponent(SOURCE)}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      body: createReadStream(path), duplex: "half", signal: AbortSignal.timeout(Math.max(TIMEOUT, 120_000)),
    });
    if (!r.ok) warn(`${r.status} ${await r.text().catch(() => "")}`);
  } catch (e) { warn(e.message); }
}

const json = (s) => { try { return JSON.parse(s); } catch { warn(`invalid JSON: ${s}`); return undefined; } };

async function main() {
  const [cmd, run, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "stage": {
      const [stage, status, ...title] = rest;
      return post([{ run, source: SOURCE, kind: "stage", stage, status, ...(title.length ? { title: title.join(" ") } : {}) }]);
    }
    case "run": {
      const data = json(rest[0] ?? "{}");
      return data && post([{ run, source: SOURCE, kind: "run", data }]);
    }
    case "file": return file(run, rest[0], rest[1]);
    case "agent": return agent(run);
    case "event": { const e = json(run ?? ""); return e && post(e); }
    default: warn(`usage: emit.mjs stage|run|file|agent|event …`);
  }
}

main().catch((e) => warn(e.message)).finally(() => process.exit(0));
