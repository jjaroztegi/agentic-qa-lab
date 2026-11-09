// Client data: runs + events from the API, kept current over SSE. In a static replay export the
// same calls read run.json / events.json / catalog.json next to index.html instead.
import { useEffect, useReducer } from "preact/hooks";
import type { QaEvent } from "../src/shared/contract.ts";
import { applyEvent, emptySummary, type Run } from "../src/shared/summary.ts";
import { Narrator } from "../src/shared/narrate.ts";
import type { CatalogCase } from "../src/catalog.ts";

export type { CatalogCase } from "../src/catalog.ts";

declare global { interface Window { __CONTROL_STATIC__?: { run: string } } }
export const STATIC = typeof window !== "undefined" ? window.__CONTROL_STATIC__ : undefined;

const state = {
  runs: new Map<string, Run>(),
  events: new Map<string, { list: QaEvent[]; ids: Set<number> }>(),
  narrators: new Map<string, { n: Narrator; done: number }>(),
  catalog: [] as CatalogCase[],
  connected: false,
  loaded: false,
  version: 0,
};
const subs = new Set<() => void>();
const notify = () => { state.version++; for (const s of subs) s(); };

/** Re-render on any data change. */
export function useStore() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { subs.add(force); return () => { subs.delete(force); }; }, []);
  return state;
}

/** Artifact URLs work against the server and inside a static export (files/<name>). */
export function fileUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!STATIC) return url;
  const m = /\/files\/([^/?#]+)$/.exec(url);
  return m ? `files/${m[1]}` : url;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function addEvent(e: QaEvent) {
  let run = state.runs.get(e.run);
  if (!run) state.runs.set(e.run, (run = { id: e.run, info: {}, summary: emptySummary() }));
  const evs = state.events.get(e.run);
  if (evs) {
    if (e.id != null && evs.ids.has(e.id)) return;
    if (e.id != null) evs.ids.add(e.id);
    evs.list.push(e);
  }
  applyEvent(run, e);
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  if (STATIC) {
    Promise.all([getJson<Run[]>("runs.json"), getJson<QaEvent[]>("events.json"), getJson<CatalogCase[]>("catalog.json").catch(() => [])])
      .then(([runs, events, catalog]) => {
        for (const r of runs) state.runs.set(r.id, r);
        state.events.set(STATIC.run, { list: events, ids: new Set(events.map((e) => e.id!)) });
        state.catalog = catalog;
        state.loaded = true;
        notify();
      });
    return;
  }
  const es = new EventSource("/api/stream");
  es.onopen = () => { state.connected = true; notify(); };
  es.onerror = () => { state.connected = false; notify(); };
  let pending = false;
  es.onmessage = (m) => {
    try { addEvent(JSON.parse(m.data)); } catch { return; }
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; notify(); }); }
  };
  getJson<Run[]>("/api/runs").then((runs) => {
    for (const r of runs) if (!state.runs.has(r.id)) state.runs.set(r.id, r);
    state.loaded = true;
    notify();
  }).catch(() => { state.loaded = true; notify(); });
  loadCatalog();
  setInterval(loadCatalog, 60_000);
}

function loadCatalog() {
  getJson<CatalogCase[]>("/api/catalog").then((c) => { state.catalog = c; notify(); }).catch(() => {});
}

const loading = new Set<string>();
/** Events of one run (loaded once, then appended live). */
export function runEvents(id: string | undefined): QaEvent[] | undefined {
  if (!id) return undefined;
  const have = state.events.get(id);
  if (have) return have.list;
  if (!STATIC && !loading.has(id)) {
    loading.add(id);
    const holder = { list: [] as QaEvent[], ids: new Set<number>() };
    getJson<QaEvent[]>(`/api/runs/${encodeURIComponent(id)}/events`).then((list) => {
      const live = state.events.get(id);
      const merged = [...list];
      const ids = new Set(list.map((e) => e.id!));
      for (const e of live?.list ?? []) if (!ids.has(e.id!)) { merged.push(e); ids.add(e.id!); }
      state.events.set(id, { list: merged, ids });
      notify();
    }).catch(() => { state.events.set(id, holder); notify(); });
  }
  return undefined;
}

/** Narration of a run, advanced incrementally as agent lines arrive. */
export function narration(id: string, events: QaEvent[]): Narrator {
  let entry = state.narrators.get(id);
  if (!entry || entry.done > events.length) state.narrators.set(id, (entry = { n: new Narrator({ hosts: hostsOf(state.runs.get(id)) }), done: 0 }));
  for (; entry.done < events.length; entry.done++) {
    const e = events[entry.done];
    if (e.kind === "agent-line") entry.n.push(e.data, Date.parse(e.ts));
  }
  return entry.n;
}

function hostsOf(run: Run | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const sys = (run?.info.systems ?? {}) as Record<string, string>;
  for (const [name, url] of Object.entries(sys)) { try { out[new URL(url).host] = name; } catch {} }
  return out;
}

export const runsList = () => [...state.runs.values()].sort((a, b) => (b.summary.updated ?? "").localeCompare(a.summary.updated ?? ""));
export const caseOf = (id: string | undefined) => state.catalog.find((c) => c.id === id);
