// Protected support layer (CODEOWNERS: QA platform). Agents may USE it, never edit it:
// tools/guard-heal.mjs rejects any automated repair that touches this folder or catalog/.
//
// - loadCase(): expected values come from the business catalog, not from the spec, so a test
//   cannot be "healed" by changing what the business expects.
// - erp / mes: validate by data, independent of the screens.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { test } from "@playwright/test";

export const ENV = {
  erpUrl: process.env.ERP_URL ?? "http://127.0.0.1:18069",
  erpDb: process.env.ERP_DB ?? "erp",
  mesUrl: process.env.MES_URL ?? "http://127.0.0.1:13000",
  sales: { login: process.env.ERP_SALES_USER ?? "sales.rep", password: process.env.ERP_SALES_PASSWORD ?? "sales-qa" },
  // Key-user accounts of the QA ERP by role, as a case names them ("as the shift supervisor").
  roles: {
    "sales rep": { login: process.env.ERP_SALES_USER ?? "sales.rep", password: process.env.ERP_SALES_PASSWORD ?? "sales-qa" },
    "shift supervisor": { login: "shift.supervisor", password: process.env.ERP_SHIFT_PASSWORD ?? "shift-qa" },
  } as Record<string, { login: string; password: string }>,
  admin: { login: "admin", password: process.env.ERP_ADMIN_PASSWORD ?? "admin" },
};

export type Case = {
  id: string;
  title: string;
  data: Record<string, any>;
  expected_results: string[];
  data_validation: string[];
};

export function loadCase(id: string): Case {
  const c = parse(readFileSync(new URL(`../../../catalog/cases/${id}.yaml`, import.meta.url), "utf8")) as Case;
  // Evidence: which case version this run used.
  test.info().annotations.push({ type: "case", description: `${c.id} · ${c.title}` });
  return c;
}

// Unique per run, so reruns never collide (coil numbers are traceability keys).
export const runTag = () => Date.now().toString(36).toUpperCase().slice(-5);

async function odoo(service: string, method: string, ...args: unknown[]) {
  const r = await fetch(`${ENV.erpUrl}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const body: any = await r.json();
  if (body.error) throw new Error(body.error.data?.message ?? body.error.message);
  return body.result;
}

let uid: number | undefined;
async function kw(model: string, method: string, args: unknown[], kwargs: object = {}) {
  uid ??= await odoo("common", "login", ENV.erpDb, ENV.admin.login, ENV.admin.password);
  return odoo("object", "execute_kw", ENV.erpDb, uid, ENV.admin.password, model, method, args, kwargs);
}

export const erp = {
  // Read-only checks on ERP documents.
  async saleOrder(name: string) {
    const [so] = await kw("sale.order", "search_read", [[["name", "=", name]]], { fields: ["name", "state", "partner_id", "amount_untaxed"] });
    return so as { name: string; state: string; partner_id: [number, string]; amount_untaxed: number } | undefined;
  },
  async productionForSale(saleName: string) {
    const [mo] = await kw("mrp.production", "search_read", [[["origin", "=", saleName]]],
      { fields: ["name", "state", "product_qty", "qty_produced"] });
    return mo as { name: string; state: string; product_qty: number; qty_produced: number } | undefined;
  },
  async latestSaleOrderFor(customer: string) {
    const [so] = await kw("sale.order", "search_read", [[["partner_id.name", "=", customer]]],
      { fields: ["name", "state"], order: "id desc", limit: 1 });
    return so as { name: string; state: string } | undefined;
  },
};

export const mes = {
  async orderByErpRef(erpRef: string) {
    const r = await fetch(`${ENV.mesUrl}/api/orders/${encodeURIComponent(erpRef)}`);
    return r.ok ? ((await r.json()) as { id: number; status: string; produced_t: number; coils: any[] }) : undefined;
  },
};

// Poll a data condition (interfaces are asynchronous). Returns the last value for the assertion.
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2_000));
    v = await fn();
  }
  return v;
}
