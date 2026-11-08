import { DatabaseSync } from "node:sqlite";

export type Order = {
  id: number;
  erp_ref: string;
  sale_ref: string | null;
  customer: string;
  product: string;
  grade: string;
  qty_t: number;
  due_date: string | null;
  status: "pending" | "in_progress" | "completed" | "reported" | "error";
  erp_message: string | null;
  created_at: string;
};

export type Coil = {
  id: number;
  order_id: number;
  coil_no: string;
  heat_no: string;
  weight_kg: number;
  thickness_mm: number;
  width_mm: number;
  quality: "OK" | "HOLD";
  created_at: string;
};

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      erp_ref TEXT NOT NULL UNIQUE,
      sale_ref TEXT,
      customer TEXT NOT NULL,
      product TEXT NOT NULL,
      grade TEXT NOT NULL,
      qty_t REAL NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      erp_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS coils (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      coil_no TEXT NOT NULL,
      heat_no TEXT NOT NULL,
      weight_kg REAL NOT NULL,
      thickness_mm REAL NOT NULL,
      width_mm REAL NOT NULL,
      quality TEXT NOT NULL DEFAULT 'OK',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS quality_events (
      id INTEGER PRIMARY KEY,
      coil_id INTEGER NOT NULL REFERENCES coils(id),
      action TEXT NOT NULL,          -- HOLD | RELEASE
      motive TEXT NOT NULL,
      comment TEXT,
      supervisor TEXT,
      operator TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY,
      coil_id INTEGER NOT NULL REFERENCES coils(id),
      thickness_mm REAL NOT NULL,
      width_mm REAL NOT NULL,
      flatness_iu REAL NOT NULL,
      result TEXT NOT NULL,          -- OK | NOK
      detail TEXT,
      operator TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stops (
      id INTEGER PRIMARY KEY,
      line TEXT NOT NULL DEFAULT 'L2',
      start_at TEXT NOT NULL,        -- plant local time, YYYY-MM-DDTHH:MM
      end_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      comment TEXT,
      operator TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
