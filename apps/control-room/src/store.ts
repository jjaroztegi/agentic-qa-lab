// Event store: append-only events plus one row per run with its folded state (node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { QaEvent } from "./shared/contract.ts";
import { applyEvent, emptySummary, type Run } from "./shared/summary.ts";
import { trimAgentLine } from "./shared/trim.ts";

export interface Store {
  append(events: QaEvent[]): QaEvent[];
  runs(limit?: number): Run[];
  run(id: string): Run | undefined;
  events(run: string, after?: number, limit?: number): QaEvent[];
  since(after: number, limit?: number): QaEvent[];
  close(): void;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, info TEXT NOT NULL, summary TEXT NOT NULL, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
      stage TEXT, status TEXT, title TEXT, detail TEXT, "case" TEXT, pr INTEGER, url TEXT, data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_run ON events(run, id);
    CREATE INDEX IF NOT EXISTS runs_updated ON runs(updated);
  `);
  const insert = db.prepare(`INSERT INTO events (run, ts, source, kind, stage, status, title, detail, "case", pr, url, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");
  const putRun = db.prepare(`INSERT INTO runs (id, info, summary, updated) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET info = excluded.info, summary = excluded.summary, updated = excluded.updated`);

  const rowToRun = (r: any): Run => ({ id: r.id, info: JSON.parse(r.info), summary: JSON.parse(r.summary) });
  const rowToEvent = (r: any): QaEvent => {
    const e: any = { id: r.id, ts: r.ts, run: r.run, source: r.source, kind: r.kind };
    for (const k of ["stage", "status", "title", "detail", "case", "pr", "url"]) if (r[k] != null) e[k] = r[k];
    if (r.data != null) e.data = JSON.parse(r.data);
    return e;
  };

  return {
    /** Stores events atomically (agent lines trimmed; empty ones dropped) and returns them with ids. */
    append(events) {
      const stored: QaEvent[] = [];
      const touched = new Map<string, Run>();
      db.exec("BEGIN");
      try {
        for (const ev of events) {
          const e = { ...ev };
          if (e.kind === "agent-line") {
            e.data = trimAgentLine(e.data);
            if (!e.data) continue;
          }
          const r = insert.run(e.run, e.ts, e.source, e.kind, e.stage ?? null, e.status ?? null, e.title ?? null, e.detail ?? null,
            e.case ?? null, e.pr ?? null, e.url ?? null, e.data === undefined ? null : JSON.stringify(e.data));
          e.id = Number(r.lastInsertRowid);
          let run = touched.get(e.run);
          if (!run) {
            const row = getRun.get(e.run);
            run = row ? rowToRun(row) : { id: e.run, info: {}, summary: emptySummary() };
            touched.set(e.run, run);
          }
          applyEvent(run, e);
          stored.push(e);
        }
        for (const run of touched.values()) putRun.run(run.id, JSON.stringify(run.info), JSON.stringify(run.summary), run.summary.updated ?? "");
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return stored;
    },
    runs(limit = 200) {
      return (db.prepare("SELECT * FROM runs ORDER BY updated DESC LIMIT ?").all(limit) as any[]).map(rowToRun);
    },
    run(id) {
      const row = getRun.get(id);
      return row ? rowToRun(row) : undefined;
    },
    events(run, after = 0, limit = 20_000) {
      return (db.prepare("SELECT * FROM events WHERE run = ? AND id > ? ORDER BY id LIMIT ?").all(run, after, limit) as any[]).map(rowToEvent);
    },
    since(after, limit = 5000) {
      return (db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(after, limit) as any[]).map(rowToEvent);
    },
    close() { db.close(); },
  };
}
