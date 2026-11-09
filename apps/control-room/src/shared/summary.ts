// Run state folded from its events. Shared by the server (stored with the run, served by /api/runs)
// and the browser (kept current from the SSE stream without refetching).
import type { QaEvent, Stage, Status } from "./contract.ts";

export interface RunInfo {
  workflow?: string;
  title?: string;
  case?: string;
  pr?: number;
  repo?: string;
  skill?: string;
  vnc?: string;
  novnc?: string;
  target?: string;
  mode?: string;
  recording_started_at?: string;
  /** What the agent could know per system: "black box" | "source access" (policy/agent-access.yaml). */
  access?: Record<string, string>;
  /** The agent saw no existing tests (PR label "from-scratch"). */
  from_scratch?: boolean;
  [k: string]: unknown;
}
export interface StageState { status: Status; ts: string; startedAt?: string; title?: string; detail?: string }
export interface RunSummary {
  started?: string;
  updated?: string;
  ended?: string;
  verdict: "running" | "ok" | "fail" | "warn";
  /** The result event's title, e.g. "Cancelled". */
  resultTitle?: string;
  stages: Partial<Record<Stage, StageState>>;
  agent?: { turns?: number; durationMs?: number; costUsd?: number; isError?: boolean };
  agentStart?: string;
  recordingStartedAt?: string;
  steps: Record<string, { status: string; ts: string; screenshot?: string; detail?: string }>;
  files: Record<string, { url: string; ts: string; size?: number }>;
  events: number;
}
export interface Run { id: string; info: RunInfo; summary: RunSummary }

export const emptySummary = (): RunSummary => ({ verdict: "running", stages: {}, steps: {}, files: {}, events: 0 });

/** Applies one event to a run in place. */
export function applyEvent(run: Run, e: QaEvent): void {
  const s = run.summary;
  s.events++;
  if (!s.started || e.ts < s.started) s.started = e.ts;
  if (!s.updated || e.ts > s.updated) s.updated = e.ts;
  if (e.case && !run.info.case) run.info.case = e.case;
  if (e.pr && !run.info.pr) run.info.pr = e.pr;
  const d = e.data ?? {};
  switch (e.kind) {
    case "run":
      Object.assign(run.info, d);
      if (e.title && !d.title) run.info.title = e.title;
      if (typeof d.recording_started_at === "string") s.recordingStartedAt = d.recording_started_at;
      break;
    case "stage": {
      if (!e.stage) break;
      const prev = s.stages[e.stage];
      const startedAt = e.status === "start" && prev && prev.status !== "start" ? e.ts : prev?.startedAt ?? e.ts;
      s.stages[e.stage] = { status: e.status ?? "info", ts: e.ts, startedAt, title: e.title ?? prev?.title, detail: e.detail };
      if (e.stage === "agent" && e.status === "start") s.agentStart ??= e.ts;
      if (e.status === "fail" && !s.ended) s.verdict = "fail";
      break;
    }
    case "agent-line":
      if (d.type === "result") s.agent = { turns: d.num_turns, durationMs: d.duration_ms, costUsd: d.total_cost_usd, isError: !!d.is_error };
      break;
    case "step": {
      const key = String(d.step ?? "");
      if (key) s.steps[key] = { status: String(d.status ?? e.status ?? "info"), ts: e.ts, screenshot: d.screenshot, detail: e.detail ?? d.detail };
      break;
    }
    case "note":
      if (typeof d.recording_started_at === "string") s.recordingStartedAt = d.recording_started_at;
      break;
    case "artifact":
      if (typeof d.name === "string") s.files[d.name] = { url: String(d.url ?? ""), ts: e.ts, size: d.size };
      break;
    case "result":
      s.verdict = e.status === "ok" ? "ok" : e.status === "fail" ? "fail" : "warn";
      if (e.title) s.resultTitle = e.title;
      s.ended = e.ts;
      break;
  }
}

/** When the run's screen recording starts (t = 0 of screen.mp4). */
export function recordingStart(run: Run): string | undefined {
  return run.summary.recordingStartedAt ?? run.info.recording_started_at ?? run.summary.agentStart ?? run.summary.started;
}

/** Live state for lists: finished runs keep their verdict; silent ones go idle. */
export function runState(run: Run, now = Date.now()): "running" | "ok" | "fail" | "warn" | "idle" {
  const s = run.summary;
  if (s.ended || s.verdict !== "running") return s.verdict === "running" ? "idle" : s.verdict;
  const quiet = now - Date.parse(s.updated ?? s.started ?? "0");
  const stages = Object.values(s.stages);
  const open = stages.some((st) => st?.status === "start");
  if (open) return quiet < 3 * 3600_000 ? "running" : "idle";
  if (stages.length && quiet < 30_000) return "running"; // between two stages
  if (stages.length) return stages.some((st) => st?.status === "warn") ? "warn" : "ok"; // every stage closed, e.g. an intake run
  return quiet < 120_000 ? "running" : "idle";
}

/** Runs that belong to the same business case: same case id, or same PR when there is no case. */
export function journeyOf(run: Run, all: Run[]): Run[] {
  const c = run.info.case, pr = run.info.pr;
  const standalone = (r: Run) => r.info.workflow === "ci" || r.info.workflow === "regression";
  if ((!c && !pr) || standalone(run)) return [run];
  const others = all.filter((r) => r.id !== run.id && !standalone(r));
  // Same case, plus anything on the PRs those runs opened (a review/merge run may only know the PR).
  const prs = new Set([pr, ...others.filter((r) => c && r.info.case === c).map((r) => r.info.pr)].filter(Boolean));
  return [run, ...others.filter((r) => (c && r.info.case === c) || (r.info.pr && prs.has(r.info.pr) && (!r.info.case || !c)))]
    .sort((a, b) => (a.summary.started ?? "").localeCompare(b.summary.started ?? ""));
}
