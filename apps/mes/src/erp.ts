// Connector ERP (Odoo, standing in for SAP) <-> MES.
// Inbound: confirmed manufacturing orders become MES orders.
// Outbound: a completed MES order confirms its production in the ERP.
import type { DatabaseSync } from "node:sqlite";
import { gradeOf, parseInboundOrder, producedTonnes, type InboundOrder } from "./domain.ts";
import type { Coil, Order } from "./db.ts";

type Cfg = { url: string; db: string; user: string; password: string };

export class Erp {
  private uid: number | null = null;
  private cfg: Cfg;
  constructor(cfg: Cfg) {
    this.cfg = cfg;
  }

  private async rpc(service: string, method: string, args: unknown[]): Promise<any> {
    const res = await fetch(`${this.cfg.url}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json();
    if (body.error) throw new Error(body.error.data?.message ?? body.error.message);
    return body.result;
  }

  private async call(model: string, method: string, args: unknown[], kwargs: object = {}) {
    if (this.uid == null) {
      this.uid = await this.rpc("common", "login", [this.cfg.db, this.cfg.user, this.cfg.password]);
      if (!this.uid) throw new Error("ERP login rejected for " + this.cfg.user);
    }
    return this.rpc("object", "execute_kw", [this.cfg.db, this.uid, this.cfg.password, model, method, args, kwargs]);
  }

  // Manufacturing orders waiting for the MES, mapped onto the inbound contract.
  async pendingOrders(): Promise<InboundOrder[]> {
    const mos = await this.call("mrp.production", "search_read",
      [[["state", "=", "confirmed"]]],
      { fields: ["name", "origin", "product_id", "product_qty", "date_deadline", "date_start"] });
    const origins = [...new Set(mos.map((m: any) => m.origin).filter(Boolean))];
    const sales = origins.length
      ? await this.call("sale.order", "search_read", [[["name", "in", origins]]], { fields: ["name", "partner_id"] })
      : [];
    const customerBySale = new Map(sales.map((s: any) => [s.name, s.partner_id[1]]));
    return mos.map((m: any) => toInbound(m, customerBySale.get(m.origin) ?? "Stock"));
  }

  async confirmProduction(erpRef: string, tonnes: number): Promise<string> {
    const [mo] = await this.call("mrp.production", "search_read", [[["name", "=", erpRef]]], { fields: ["id", "state"] });
    if (!mo) throw new Error(`Order ${erpRef} does not exist in the ERP`);
    await this.call("mrp.production", "write", [[mo.id], { qty_producing: tonnes }]);
    await this.call("mrp.production", "button_mark_done", [[mo.id]],
      { context: { skip_backorder: true, skip_consumption: true, skip_redirection: true } });
    const [after] = await this.call("mrp.production", "read", [[mo.id]], { fields: ["state", "qty_produced"] });
    if (after.state !== "done") throw new Error(`ERP left ${erpRef} in state ${after.state}`);
    return `Confirmed ${after.qty_produced} t on ${erpRef}`;
  }
}

// Odoo returns datetimes in UTC ("2026-12-14 23:00:00"); the mill plans by the plant's calendar day.
const PLANT_TZ = process.env.PLANT_TZ ?? "Europe/Berlin";
const dayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

/** An Odoo date or UTC datetime as the plant's calendar day (YYYY-MM-DD), or null. */
export function plantDate(value: string | false | null | undefined, tz = PLANT_TZ): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : dayIn(tz).format(d);
}

export function toInbound(mo: any, customer: string): InboundOrder {
  const product = String(mo.product_id[1]).replace(/^\[[^\]]*\]\s*/, "");
  const { order, errors } = parseInboundOrder({
    erp_ref: mo.name,
    sale_ref: mo.origin || null,
    customer,
    product,
    grade: gradeOf(product),
    qty_t: mo.product_qty,
    due_date: plantDate(mo.date_deadline || mo.date_start),
  });
  if (!order) throw new Error(`ERP->MES contract violated by ${mo.name}: ${errors.join("; ")}`);
  return order;
}

export async function syncOnce(db: DatabaseSync, erp: Erp, log = console.log) {
  for (const o of await erp.pendingOrders()) {
    const r = db.prepare(`INSERT INTO orders (erp_ref, sale_ref, customer, product, grade, qty_t, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(erp_ref) DO NOTHING`)
      .run(o.erp_ref, o.sale_ref, o.customer, o.product, o.grade, o.qty_t, o.due_date);
    if (r.changes) log(`ERP -> MES: ${o.erp_ref} (${o.qty_t} t ${o.grade})`);
  }
  const done = db.prepare("SELECT * FROM orders WHERE status = 'completed'").all() as Order[];
  for (const o of done) {
    const coils = db.prepare("SELECT * FROM coils WHERE order_id = ?").all(o.id) as Coil[];
    try {
      const msg = await erp.confirmProduction(o.erp_ref, producedTonnes(coils));
      db.prepare("UPDATE orders SET status = 'reported', erp_message = ? WHERE id = ?").run(msg, o.id);
      log(`MES -> ERP: ${msg}`);
    } catch (e) {
      db.prepare("UPDATE orders SET status = 'error', erp_message = ? WHERE id = ?").run(String((e as Error).message), o.id);
      log(`MES -> ERP failed for ${o.erp_ref}: ${(e as Error).message}`);
    }
  }
}
