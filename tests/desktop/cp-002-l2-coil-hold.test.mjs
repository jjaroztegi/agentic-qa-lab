// case: catalog/cases/CP-002.yaml — quality hold of a coil from the L2 desktop client.
// Run: node --test 'tests/desktop/*.test.mjs'   (MES_URL, DESKTOP_EXEC optional)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { desktop } from "./support/desktop.mjs";

const CASE = parse(readFileSync(new URL("../../catalog/cases/CP-002.yaml", import.meta.url), "utf8"));
const MES = process.env.MES_URL ?? "http://127.0.0.1:13000";
const APP_CMD = `l2-client ${MES}`;
const COLS = ["Coil", "Order", "Customer", "Grade", "Nominal thickness (mm)", "Weight (kg)", "Status"];

// Business values come from the case text.
const [open, select, hold] = CASE.steps;
const TITLE = open.match(/"([^"]+)"/)[1]; // Level 2 · Hot strip mill
const BTN_REFRESH = select.match(/"([^"]+)"/)[1]; // Refresh
const BTN_HOLD = hold.match(/"([^"]+)"/)[1]; // Hold
const REASON = hold.match(/reason "([^"]+)"/)[1]; // Flatness defect

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(300);
  }
}
async function api(path, init) {
  // The MES drops idle keep-alive sockets after 5 s; a GET reusing one after the desktop phase is retried once.
  const r = await fetch(`${MES}${path}`, init).catch((e) => {
    if (init?.method || e.cause?.code !== "UND_ERR_SOCKET") throw e;
    return fetch(`${MES}${path}`);
  });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}
/** Row of the client table for a coil, read from the window texts (cells come in column order). */
function row(texts, coilNo) {
  const i = texts.indexOf(coilNo);
  return i < 0 ? null : Object.fromEntries(COLS.map((c, k) => [c, texts[i + k]]));
}

test(`${CASE.id} ${CASE.title}`, async (t) => {
  const run = Date.now().toString(36).toUpperCase();
  const evidence = `evidence/desktop/${CASE.id}`;
  const d = desktop("java", evidence);

  // Precondition by API: an order in progress with released coils; the case works on the last one.
  const erpRef = `CP002-${run}`;
  const order = await api("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ erp_ref: erpRef, customer: "QA CP-002", product: "Hot-rolled coil S275JR", grade: "S275JR", qty_t: 50 }),
  });
  const coils = [
    { coil_no: `C2-${run}-1`, heat_no: "512345", weight_kg: "24500", thickness_mm: "3", width_mm: "1250", quality: "OK" },
    { coil_no: `C2-${run}-2`, heat_no: "512345", weight_kg: "23250", thickness_mm: "3", width_mm: "1250", quality: "OK" },
  ];
  for (const c of coils) {
    // The MES registers coils through its form endpoint (303 on success, 422 with errors).
    const r = await fetch(`${MES}/orders/${order.id}/coils`, { method: "POST", body: new URLSearchParams(c), redirect: "manual" });
    assert.equal(r.status, 303, `register coil ${c.coil_no}`);
  }
  const before = await api(`/api/orders/${order.id}`);
  assert.equal(before.status, "in_progress");
  const target = before.coils.filter((c) => c.quality === "OK").at(-1);
  assert.equal(target?.coil_no, coils.at(-1).coil_no, "precondition: the last released coil exists");
  t.diagnostic(`order ${erpRef}, coil ${target.coil_no} (id ${target.id})`);

  // support close() exits 143 when no app is open (its pkill matches its own shell): only close a leftover client.
  if (d.window(TITLE)) d.close();
  const stop = d.record();
  try {
    await t.test(open, () => {
      d.launch(APP_CMD, TITLE);
      assert.ok(d.window(TITLE), `window "${TITLE}" is open`);
      d.screenshot("client-open");
    });

    await t.test(select, async () => {
      d.type("textfield", "Coil filter", target.coil_no);
      d.click("button", BTN_REFRESH);
      const r = await until(() => row(d.texts(), target.coil_no), `coil ${target.coil_no} in the table`);
      assert.equal(r.Status, "OK");
      assert.equal(r.Order, erpRef);
      d.selectOnlyRow("Coils");
      d.screenshot("coil-selected");
    });

    await t.test(hold, async () => {
      d.click("button", BTN_HOLD);
      await until(() => d.window("Hold coil"), "hold dialog");
      d.screenshot("reason-dialog");
      d.keys(REASON);
      d.waitWindowGone("Hold coil");
      await until(() => row(d.texts(), target.coil_no)?.Status === "HOLD", "coil is HOLD in the table");
      d.screenshot("coil-held");
    });

    await t.test("Result: the client table shows the coil as HOLD", () => {
      assert.equal(row(d.texts(), target.coil_no)?.Status, "HOLD");
    });

    await t.test("Data validation in the MES", async () => {
      const held = await api("/api/coils?quality=HOLD");
      assert.ok(held.some((c) => c.id === target.id), "GET /api/coils?quality=HOLD contains the coil");

      const after = await api(`/api/orders/${order.id}`);
      assert.equal(after.coils.find((c) => c.id === target.id).quality, "HOLD");
      assert.equal(after.produced_t, Math.round((before.produced_t - target.weight_kg / 1000) * 1000) / 1000, "produced drops by the coil weight");

      const html = await api(`/orders/${order.id}`);
      const tr = html.split("<tr>").find((r) => r.includes(`<td>${target.coil_no}</td>`));
      assert.match(tr ?? "", />Held</, `the MES shows ${target.coil_no} as "Held"`);
    });
  } finally {
    if (d.window(TITLE)) d.close();
    await stop();
  }
});
