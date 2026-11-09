import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { html, raw } from "hono/html";
import { openDb, type Coil, type Order } from "./db.ts";
import {
  availability, coilLimits, evaluateMeasurement, formatTonnes, gradeSpec, GRADE_SPECS, HOLD_MOTIVES, parseCoil, parseHold,
  parseInboundOrder, parseMeasurement, parseRelease, parseStop, producedTonnes, RELEASE_MOTIVES, shiftWindow, SHIFTS,
  STOP_REASONS, SUPERVISORS, type ShiftCode,
} from "./domain.ts";
import { Erp, syncOnce } from "./erp.ts";

const db = openDb(process.env.MES_DB ?? "/data/mes.db");
const app = new Hono();

const STATUS: Record<Order["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  reported: "Confirmed in ERP",
  error: "Interface error",
};

const page = (title: string, body: unknown) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Rolling mill MES</title>
<style>
  :root{--bg:#f4f5f6;--panel:#fff;--ink:#1d2329;--muted:#5b6670;--line:#d8dde2;--accent:#b4441c;--ok:#1f7a3d;--hold:#9a6400;--err:#b3261e}
  *{box-sizing:border-box} body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
  header{background:#1d2329;color:#fff;padding:12px 20px;display:flex;gap:16px;align-items:baseline}
  header a{color:#fff;text-decoration:none;font-weight:600} header span{color:#aab4bd;font-size:13px}
  main{max-width:1100px;margin:0 auto;padding:20px 16px}
  h1{font-size:22px;margin:0 0 16px} h2{font-size:17px;margin:24px 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line)}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)} th{font-size:13px;color:var(--muted);font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#e6e9ec}
  .badge.reported,.badge.OK{background:#dcefe2;color:var(--ok)} .badge.HOLD{background:#f6ead2;color:var(--hold)} .badge.error{background:#f8dcda;color:var(--err)}
  form.coil{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;background:var(--panel);border:1px solid var(--line);padding:14px}
  label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);gap:4px}
  input,select{font:inherit;padding:6px 8px;border:1px solid #b9c1c8;border-radius:4px;color:var(--ink)}
  button{font:inherit;padding:8px 14px;border:0;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer;align-self:end}
  button.secondary{background:#44505b}
  .errors{background:#f8dcda;color:var(--err);padding:10px 14px;border-radius:4px} .msg{color:var(--muted)}
  dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;background:var(--panel);border:1px solid var(--line);padding:14px;margin:0}
  dt{color:var(--muted)} dd{margin:0}
  @media (max-width:640px){.hide-sm{display:none}}
</style></head>
<body><header><a href="/">Hot strip mill MES</a><span>Demo plant · QA environment</span></header>
<main>${body}</main></body></html>`;

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", (c) => {
  const orders = db.prepare("SELECT * FROM orders ORDER BY id DESC").all() as Order[];
  return c.html(page("Orders", html`
    <h1>Manufacturing orders</h1>
    <table aria-label="Manufacturing orders">
      <thead><tr><th>ERP order</th><th>Sales order</th><th>Customer</th><th>Grade</th><th class="num">Quantity (t)</th><th class="hide-sm">Due date</th><th>Status</th></tr></thead>
      <tbody>${orders.length ? orders.map((o) => html`<tr>
        <td><a href="/orders/${o.id}">${o.erp_ref}</a></td><td>${o.sale_ref ?? "—"}</td><td>${o.customer}</td>
        <td>${o.grade}</td><td class="num">${formatTonnes(o.qty_t).slice(0, -2)}</td><td class="hide-sm">${o.due_date ?? ""}</td>
        <td><span class="badge ${o.status}">${STATUS[o.status]}</span></td></tr>`)
        : html`<tr><td colspan="7" class="msg">No orders. They arrive from the ERP when sales orders are confirmed.</td></tr>`}</tbody>
    </table>`));
});

function orderPage(id: number, errors: string[] = []) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
  if (!o) return null;
  const coils = db.prepare(`${COIL_SQL} WHERE k.order_id = ? ORDER BY k.id`).all(id) as CoilRow[];
  const open = o.status === "pending" || o.status === "in_progress";
  return page(o.erp_ref, html`
    <h1>Order ${o.erp_ref}</h1>
    <dl>
      <dt>Sales order</dt><dd>${o.sale_ref ?? "—"}</dd><dt>Customer</dt><dd>${o.customer}</dd>
      <dt>Product</dt><dd>${o.product}</dd><dt>Ordered quantity</dt><dd>${formatTonnes(o.qty_t)}</dd>
      <dt>Produced (released)</dt><dd data-testid="produced">${formatTonnes(producedTonnes(coils))}</dd>
      <dt>Status</dt><dd><span class="badge ${o.status}">${STATUS[o.status]}</span></dd>
      ${o.erp_message ? html`<dt>ERP</dt><dd>${o.erp_message}</dd>` : ""}
    </dl>
    <h2>Coils</h2>
    <table aria-label="Coils">
      <thead><tr><th>Coil</th><th>Heat</th><th class="num">Weight (kg)</th><th class="num">Thickness (mm)</th><th class="num">Width (mm)</th><th>Quality status</th></tr></thead>
      <tbody>${coils.length ? coils.map((k) => html`<tr><td>${k.coil_no}</td><td>${k.heat_no}</td>
        <td class="num">${k.weight_kg.toLocaleString("en-US")}</td><td class="num">${k.thickness_mm}</td><td class="num">${k.width_mm}</td>
        <td><span class="badge ${k.quality}">${k.quality === "OK" ? "Released" : "Held"}</span>${k.hold_motive ? html` <span class="msg">${k.hold_motive}</span>` : ""}</td></tr>`)
        : html`<tr><td colspan="6" class="msg">No coils registered.</td></tr>`}</tbody>
    </table>
    ${open ? html`
      <h2>New coil</h2>
      ${errors.length ? html`<div class="errors" role="alert">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ""}
      <form class="coil" method="post" action="/orders/${o.id}/coils">
        <label>Coil number<input name="coil_no" required></label>
        <label>Heat number<input name="heat_no" required inputmode="numeric"></label>
        <label>Weight (kg)<input name="weight_kg" required inputmode="decimal"></label>
        <label>Thickness (mm)<input name="thickness_mm" required inputmode="decimal"></label>
        <label>Width (mm)<input name="width_mm" required inputmode="numeric"></label>
        <label>Quality status<select name="quality"><option value="OK">Released</option><option value="HOLD">Held</option></select></label>
        <button type="submit">Add coil</button>
      </form>
      <form method="post" action="/orders/${o.id}/complete" style="margin-top:16px">
        <button class="secondary" type="submit" ${coils.length ? "" : raw("disabled")}>Complete order</button>
      </form>` : ""}
    ${o.status === "error" ? html`<form method="post" action="/orders/${o.id}/retry" style="margin-top:16px"><button type="submit">Retry sending to ERP</button></form>` : ""}
  `);
}

app.get("/orders/:id", (c) => {
  const p = orderPage(Number(c.req.param("id")));
  return p ? c.html(p) : c.notFound();
});

app.post("/orders/:id/coils", async (c) => {
  const id = Number(c.req.param("id"));
  const { coil, errors } = parseCoil(await c.req.parseBody());
  if (!coil) return c.html(orderPage(id, errors) ?? "", 422);
  db.prepare(`INSERT INTO coils (order_id, coil_no, heat_no, weight_kg, thickness_mm, width_mm, quality)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, coil.coil_no, coil.heat_no, coil.weight_kg, coil.thickness_mm, coil.width_mm, coil.quality);
  db.prepare("UPDATE orders SET status = 'in_progress' WHERE id = ? AND status = 'pending'").run(id);
  return c.redirect(`/orders/${id}`, 303);
});

app.post("/orders/:id/complete", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare("UPDATE orders SET status = 'completed' WHERE id = ? AND status = 'in_progress'").run(id);
  kick();
  return c.redirect(`/orders/${id}`, 303);
});

app.post("/orders/:id/retry", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare("UPDATE orders SET status = 'completed', erp_message = NULL WHERE id = ? AND status = 'error'").run(id);
  kick();
  return c.redirect(`/orders/${id}`, 303);
});

// --- API (used by the L2 desktop client and by the tests) ---
app.get("/api/orders", (c) => c.json(db.prepare("SELECT * FROM orders ORDER BY id").all()));
app.get("/api/orders/:id", (c) => {
  const o = db.prepare("SELECT * FROM orders WHERE id = ? OR erp_ref = ?").get(c.req.param("id"), c.req.param("id")) as Order | undefined;
  if (!o) return c.json({ error: "not found" }, 404);
  const coils = db.prepare("SELECT * FROM coils WHERE order_id = ? ORDER BY id").all(o.id) as Coil[];
  return c.json({ ...o, coils, produced_t: producedTonnes(coils) });
});
app.post("/api/orders", async (c) => {
  const { order, errors } = parseInboundOrder(await c.req.json().catch(() => null));
  if (!order) return c.json({ errors }, 422);
  db.prepare(`INSERT INTO orders (erp_ref, sale_ref, customer, product, grade, qty_t, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(erp_ref) DO NOTHING`).run(order.erp_ref, order.sale_ref, order.customer, order.product, order.grade, order.qty_t, order.due_date);
  return c.json(db.prepare("SELECT * FROM orders WHERE erp_ref = ?").get(order.erp_ref), 201);
});
const COIL_SQL = `SELECT k.*, o.erp_ref, o.customer, o.grade,
    CASE WHEN k.quality = 'HOLD' THEN (SELECT motive FROM quality_events e WHERE e.coil_id = k.id AND e.action = 'HOLD'
      ORDER BY e.id DESC LIMIT 1) END AS hold_motive
  FROM coils k JOIN orders o ON o.id = k.order_id`;
type CoilRow = Coil & { erp_ref: string; customer: string; grade: string; hold_motive: string | null };
const coilById = (id: string) => db.prepare(`${COIL_SQL} WHERE k.id = ?`).get(Number(id)) as CoilRow | undefined;

app.get("/api/coils", (c) => {
  const q = c.req.query("quality");
  const sql = `${COIL_SQL} ${q ? "WHERE k.quality = ?" : ""} ORDER BY k.id DESC`;
  return c.json(q ? db.prepare(sql).all(q) : db.prepare(sql).all());
});
app.post("/api/coils/:id/quality", async (c) => {
  const { quality } = await c.req.json().catch(() => ({}));
  if (quality !== "OK" && quality !== "HOLD") return c.json({ error: "quality must be OK or HOLD" }, 422);
  const r = db.prepare("UPDATE coils SET quality = ? WHERE id = ?").run(quality, Number(c.req.param("id")));
  return r.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// --- Level 2: codes, specs, quality hold/release, measurements, downtime (L2 client) ---
app.get("/api/codes", (c) => c.json({
  hold_motives: HOLD_MOTIVES, release_motives: RELEASE_MOTIVES, stop_reasons: STOP_REASONS,
  shifts: Object.entries(SHIFTS).map(([code, s]) => ({ code, ...s })),
  supervisors: Object.entries(SUPERVISORS).map(([id, name]) => ({ id, name })),
}));
app.get("/api/grades", (c) => c.json(GRADE_SPECS));
app.get("/api/grades/:grade", (c) => {
  const s = gradeSpec(c.req.param("grade"));
  return s ? c.json(s) : c.json({ error: "No specification for this grade" }, 404);
});

app.get("/api/coils/:id", (c) => {
  const k = coilById(c.req.param("id"));
  if (!k) return c.json({ error: "not found" }, 404);
  return c.json({
    ...k,
    limits: coilLimits(k),
    measurements: db.prepare("SELECT * FROM measurements WHERE coil_id = ? ORDER BY id DESC").all(k.id),
    events: db.prepare("SELECT * FROM quality_events WHERE coil_id = ? ORDER BY id DESC").all(k.id),
  });
});

function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function holdCoil(id: number, motive: string, comment: string | null, operator: string | null) {
  db.prepare("UPDATE coils SET quality = 'HOLD' WHERE id = ?").run(id);
  db.prepare("INSERT INTO quality_events (coil_id, action, motive, comment, operator) VALUES (?, 'HOLD', ?, ?, ?)").run(id, motive, comment, operator);
}
const operatorOf = (b: any) => String(b?.operator ?? "").trim() || null;

app.post("/api/coils/:id/hold", async (c) => {
  const body = await c.req.json().catch(() => null);
  const k = coilById(c.req.param("id"));
  if (!k) return c.json({ error: "not found" }, 404);
  const { hold, errors } = parseHold(body);
  if (!hold) return c.json({ errors }, 422);
  if (k.quality === "HOLD") return c.json({ errors: [`Coil ${k.coil_no} is already held`] }, 409);
  tx(() => holdCoil(k.id, hold.motive, hold.comment, operatorOf(body)));
  return c.json(coilById(String(k.id)));
});

app.post("/api/coils/:id/release", async (c) => {
  const body = await c.req.json().catch(() => null);
  const k = coilById(c.req.param("id"));
  if (!k) return c.json({ error: "not found" }, 404);
  const { release, errors } = parseRelease(body);
  if (!release) return c.json({ errors }, 422);
  if (k.quality !== "HOLD") return c.json({ errors: [`Coil ${k.coil_no} is not held`] }, 409);
  tx(() => {
    db.prepare("UPDATE coils SET quality = 'OK' WHERE id = ?").run(k.id);
    db.prepare(`INSERT INTO quality_events (coil_id, action, motive, comment, supervisor, operator) VALUES (?, 'RELEASE', ?, ?, ?, ?)`)
      .run(k.id, release.motive, release.comment, release.supervisor, operatorOf(body));
  });
  return c.json(coilById(String(k.id)));
});

// A measurement out of tolerance holds the coil automatically (the client only reports what the MES decided).
app.post("/api/coils/:id/measurements", async (c) => {
  const body = await c.req.json().catch(() => null);
  const k = coilById(c.req.param("id"));
  if (!k) return c.json({ error: "not found" }, 404);
  const limits = coilLimits(k);
  if (!limits) return c.json({ errors: [`Grade ${k.grade} has no specification in the MES`] }, 422);
  const { m, errors } = parseMeasurement(body);
  if (!m) return c.json({ errors }, 422);
  const failures = evaluateMeasurement(m, limits);
  const held = failures.length > 0 && k.quality === "OK";
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO measurements (coil_id, thickness_mm, width_mm, flatness_iu, result, detail, operator)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(k.id, m.thickness_mm, m.width_mm, m.flatness_iu, failures.length ? "NOK" : "OK",
      failures.map((f) => f.message).join("; ") || null, operatorOf(body));
    if (held) holdCoil(k.id, failures[0].motive, `Automatic hold from measurement: ${failures.map((f) => f.message).join("; ")}`, "MES");
    return r.lastInsertRowid;
  });
  return c.json({
    measurement: db.prepare("SELECT * FROM measurements WHERE id = ?").get(id),
    ok: failures.length === 0, failures, limits, held, coil: coilById(String(k.id)),
  }, 201);
});

const dayStops = (date: string) => db.prepare(`SELECT * FROM stops WHERE start_at < ? AND end_at > ? ORDER BY start_at`)
  .all(`${date}T24:00`, `${date}T00:00`) as any[];
app.get("/api/stops", (c) => {
  const date = c.req.query("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 422);
  return c.json(dayStops(date));
});
app.post("/api/stops", async (c) => {
  const body = await c.req.json().catch(() => null);
  const existing = db.prepare("SELECT start_at, end_at FROM stops").all() as any[];
  const { stop, errors } = parseStop(body, existing);
  if (!stop) return c.json({ errors }, errors.some((e) => e.startsWith("Overlaps")) ? 409 : 422);
  const r = db.prepare("INSERT INTO stops (start_at, end_at, reason, comment, operator) VALUES (?, ?, ?, ?, ?)")
    .run(stop.start_at, stop.end_at, stop.reason, stop.comment, operatorOf(body));
  return c.json(db.prepare("SELECT * FROM stops WHERE id = ?").get(r.lastInsertRowid), 201);
});
app.get("/api/availability", (c) => {
  const date = c.req.query("date") ?? "";
  const shift = (c.req.query("shift") ?? "") as ShiftCode;
  const w = shiftWindow(date, shift);
  if (!w) return c.json({ error: "date YYYY-MM-DD and shift M, T or N" }, 422);
  const stops = db.prepare("SELECT start_at, end_at FROM stops WHERE start_at < ? AND end_at > ?").all(w.to, w.from) as any[];
  return c.json({ date, shift, shift_name: SHIFTS[shift].name, ...w, ...availability(stops, w), stops: stops.length });
});

// --- ERP sync loop ---
const erp = process.env.ERP_URL
  ? new Erp({ url: process.env.ERP_URL, db: process.env.ERP_DB ?? "erp", user: process.env.ERP_USER ?? "", password: process.env.ERP_PASSWORD ?? "" })
  : null;
let running = false;
async function kick() {
  if (!erp || running) return;
  running = true;
  try { await syncOnce(db, erp); } catch (e) { console.error("sync:", (e as Error).message); } finally { running = false; }
}
if (erp) setInterval(kick, Number(process.env.SYNC_INTERVAL_S ?? 10) * 1000);

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, () => console.log(`MES on :${port}${erp ? `, ERP ${process.env.ERP_URL}` : ", no ERP"}`));
// Longer than clients' pooled-connection idle time (Node default 5 s drops reused connections).
Object.assign(server, { keepAliveTimeout: 65_000, headersTimeout: 66_000 });
