import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody, parseEvent } from "../src/shared/contract.ts";
import { openStore } from "../src/store.ts";
import { journeyOf, recordingStart, runState, type Run } from "../src/shared/summary.ts";
import { pipelineFor } from "../src/shared/pipeline.ts";

const now = new Date("2026-11-08T10:00:00Z");

test("contract: server fills ts; enums and required fields are enforced", () => {
  const ok = parseEvent({ run: "r1", source: "ci", kind: "stage", stage: "env", status: "start" }, now);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.event!.ts, now.toISOString());
  assert.equal(parseEvent({ run: "r1", source: "ci", kind: "stage", stage: "merge", status: "ok", ts: "2026-11-08T09:00:00+01:00" }).event!.ts, "2026-11-08T08:00:00.000Z");
  const bad = parseEvent({ run: "", source: "jenkins", kind: "x", stage: "deploy", status: "done", pr: -1, ts: "yesterday" });
  assert.equal(bad.event, undefined);
  for (const field of ["run", "source", "kind", "stage", "status", "pr", "ts"]) assert.ok(bad.errors.some((e) => e.startsWith(field)), field);
  assert.match(parseEvent({ run: "r", source: "agent", kind: "agent-line", data: "text" }).errors.join(), /data: object/);
  assert.match(parseEvent({ run: "r", source: "ci", kind: "stage" }).errors.join(), /stage: required/);
});

test("contract: a batch is all or nothing", () => {
  const r = parseBody([{ run: "a", source: "ci", kind: "note" }, { run: "a", source: "nope", kind: "note" }]);
  assert.equal(r.events.length, 0);
  assert.match(r.errors[0], /^\[1\] source/);
  assert.equal(parseBody({ run: "a", source: "lab", kind: "note", title: "x" }).events.length, 1);
});

test("store: folds runs (stages, steps, artifacts, agent totals, verdict) and trims agent lines", () => {
  const s = openStore(":memory:");
  const ts = (m: number) => new Date(Date.parse("2026-11-08T10:00:00Z") + m * 1000).toISOString();
  const stored = s.append([
    { ts: ts(0), run: "author_1", source: "ci", kind: "run", data: { workflow: "author", case: "CP-002", pr: 42, skill: "qa-author-desktop", vnc: "ws://127.0.0.1:6080/websockify" } },
    { ts: ts(1), run: "author_1", source: "ci", kind: "stage", stage: "env", status: "start" },
    { ts: ts(5), run: "author_1", source: "ci", kind: "stage", stage: "env", status: "ok" },
    { ts: ts(6), run: "author_1", source: "ci", kind: "stage", stage: "agent", status: "start" },
    { ts: ts(7), run: "author_1", source: "agent", kind: "agent-line", data: { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 } },
    { ts: ts(8), run: "author_1", source: "agent", kind: "agent-line", data: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(10_000) }] }, tool_use_result: { big: true } } },
    { ts: ts(9), run: "author_1", source: "agent", kind: "agent-line", data: { type: "result", num_turns: 38, duration_ms: 198670, total_cost_usd: 0.83, is_error: false } },
    { ts: ts(10), run: "author_1", source: "test", kind: "step", data: { case: "CP-002", step: 1, status: "ok", screenshot: "01.png" } },
    { ts: ts(11), run: "author_1", source: "test", kind: "artifact", data: { name: "screen.mp4", url: "/api/runs/author_1/files/screen.mp4" } },
    { ts: ts(12), run: "author_1", source: "ci", kind: "stage", stage: "prove", status: "fail", detail: "1 failed" },
  ]);
  assert.equal(stored.length, 9, "thinking_tokens line dropped");
  assert.deepEqual(stored.map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const line = s.events("author_1").find((e) => e.kind === "agent-line" && e.data.type === "user")!;
  assert.equal(line.data.tool_use_result, undefined);
  assert.ok(line.data.message.content[0].content.length < 4200);
  const run = s.run("author_1")!;
  assert.equal(run.info.case, "CP-002");
  assert.equal(run.summary.stages.env!.status, "ok");
  assert.equal(run.summary.stages.env!.startedAt, ts(1));
  assert.equal(run.summary.agentStart, ts(6));
  assert.deepEqual(run.summary.agent, { turns: 38, durationMs: 198670, costUsd: 0.83, isError: false });
  assert.equal(run.summary.steps["1"].screenshot, "01.png");
  assert.equal(run.summary.files["screen.mp4"].url, "/api/runs/author_1/files/screen.mp4");
  assert.equal(run.summary.verdict, "fail");
  assert.equal(recordingStart(run), ts(6), "defaults to the agent start");

  s.append([{ ts: ts(13), run: "author_1", source: "test", kind: "note", data: { recording_started_at: ts(4) } },
    { ts: ts(14), run: "author_1", source: "ci", kind: "result", status: "fail" }]);
  const after = s.run("author_1")!;
  assert.equal(recordingStart(after), ts(4), "an explicit recording start wins");
  assert.equal(after.summary.ended, ts(14));
  assert.equal(runState(after), "fail");
  assert.equal(s.events("author_1", 8).length, 3);
  assert.equal(s.since(9).length, 2);
  s.close();
});

test("journeys join runs of one case and light one stage line; CI runs stand alone", () => {
  const run = (id: string, info: Run["info"], stages: Record<string, string>, started: string): Run => ({
    id, info, summary: { verdict: "running", steps: {}, files: {}, events: 1, started, updated: started,
      stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, { status: v as any, ts: started }])) },
  });
  const intake = run("intake_1", { workflow: "intake", case: "CP-004" }, { intake: "ok", draft: "ok", pr: "ok" }, "2026-11-08T10:00:00Z");
  const author = run("author_1", { workflow: "author", case: "CP-004", pr: 7 }, { env: "ok", agent: "ok", prove: "ok", push: "ok" }, "2026-11-08T10:05:00Z");
  const review = run("review_1", { workflow: "review", pr: 7 }, { review: "ok", merge: "ok" }, "2026-11-08T11:00:00Z");
  const ci = run("ci_1", { workflow: "ci", pr: 7 }, { env: "ok", prove: "fail", triage: "start" }, "2026-11-08T10:30:00Z");
  const all = [intake, author, review, ci];
  const j = journeyOf(author, all);
  assert.deepEqual(j.map((r) => r.id), ["intake_1", "author_1", "review_1"]);
  const line = pipelineFor(j);
  assert.deepEqual(line.map((n) => n.label), ["Intake", "Case drafted", "Proposal (PR)", "Isolated environment", "Agent", "Proof ×3", "Review", "Merged"]);
  assert.ok(line.every((n) => n.state?.status === "ok"));
  assert.deepEqual(journeyOf(ci, all).map((r) => r.id), ["ci_1"]);
  assert.deepEqual(pipelineFor([ci]).map((n) => [n.key, n.state?.status]), [["env", "ok"], ["prove", "fail"], ["triage", "start"], ["guard", undefined]]);
  // Pushed to the PR but not reviewed yet: the review node shows as waiting.
  assert.equal(pipelineFor([intake, author]).find((n) => n.key === "review")!.state!.status, "start");
});
