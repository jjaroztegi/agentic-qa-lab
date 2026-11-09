// Event contract: the integration point for n8n, CI, agents, tests and the lab.
// POST /api/events takes one event or an array; this module validates and normalises them.

export const SOURCES = ["n8n", "ci", "agent", "test", "lab"] as const;
export const KINDS = ["run", "stage", "agent-line", "step", "note", "result", "artifact"] as const;
export const STAGES = ["intake", "draft", "pr", "env", "agent", "prove", "push", "review", "merge", "triage", "guard", "report", "compare"] as const;
export const STATUSES = ["start", "ok", "fail", "warn", "info"] as const;

export type Source = (typeof SOURCES)[number];
export type Kind = (typeof KINDS)[number];
export type Stage = (typeof STAGES)[number];
export type Status = (typeof STATUSES)[number];

/** An event as stored and served (id assigned by the store). */
export interface QaEvent {
  id?: number;
  ts: string;
  run: string;
  source: Source;
  kind: Kind;
  stage?: Stage;
  status?: Status;
  title?: string;
  detail?: string;
  case?: string;
  pr?: number;
  url?: string;
  data?: any;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const optString = (v: unknown, max: number) => v === undefined || v === null || (typeof v === "string" && v.length <= max);

/** Validates one raw event. Returns the normalised event (server time filled in) or the reasons it is invalid. */
export function parseEvent(raw: unknown, now = new Date()): { event?: QaEvent; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["event must be an object"] };
  const e = raw as Record<string, unknown>;
  if (typeof e.run !== "string" || !e.run.trim() || e.run.length > 200) errors.push("run: required text (max 200)");
  if (!oneOf(SOURCES, e.source)) errors.push(`source: one of ${SOURCES.join("|")}`);
  if (!oneOf(KINDS, e.kind)) errors.push(`kind: one of ${KINDS.join("|")}`);
  if (e.stage !== undefined && e.stage !== null && !oneOf(STAGES, e.stage)) errors.push(`stage: one of ${STAGES.join("|")}`);
  if (e.status !== undefined && e.status !== null && !oneOf(STATUSES, e.status)) errors.push(`status: one of ${STATUSES.join("|")}`);
  let ts = now.toISOString();
  if (e.ts !== undefined && e.ts !== null) {
    const d = typeof e.ts === "string" ? new Date(e.ts) : null;
    if (!d || Number.isNaN(d.getTime())) errors.push("ts: ISO date");
    else ts = d.toISOString();
  }
  for (const k of ["title", "detail", "case", "url"] as const) if (!optString(e[k], k === "detail" ? 20_000 : 2_000)) errors.push(`${k}: text`);
  if (e.pr !== undefined && e.pr !== null && !(Number.isInteger(e.pr) && (e.pr as number) > 0)) errors.push("pr: positive integer");
  if ((e.kind === "run" || e.kind === "agent-line" || e.kind === "artifact" || e.kind === "step") &&
    (e.data === null || typeof e.data !== "object" || Array.isArray(e.data))) errors.push(`data: object required for kind=${e.kind}`);
  if (e.kind === "stage" && e.stage == null) errors.push("stage: required for kind=stage");
  if (errors.length) return { errors };

  const event: QaEvent = { ts, run: (e.run as string).trim(), source: e.source as Source, kind: e.kind as Kind };
  for (const k of ["stage", "status", "title", "detail", "case", "url"] as const) if (e[k] != null) (event as any)[k] = e[k];
  if (e.pr != null) event.pr = e.pr as number;
  if (e.data !== undefined) event.data = e.data;
  return { event, errors };
}

/** Validates a POST body (one event or an array). All or nothing. */
export function parseBody(body: unknown, now = new Date()): { events: QaEvent[]; errors: string[] } {
  const list = Array.isArray(body) ? body : [body];
  if (!list.length) return { events: [], errors: ["empty list"] };
  if (list.length > 5000) return { events: [], errors: ["at most 5000 events per request"] };
  const events: QaEvent[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const r = parseEvent(raw, now);
    if (r.event) events.push(r.event);
    else errors.push(...r.errors.map((m) => (list.length > 1 ? `[${i}] ${m}` : m)));
  });
  return errors.length ? { events: [], errors } : { events, errors };
}

/** Safe single path segment for run ids and file names on disk. */
export const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 160) || "_";
