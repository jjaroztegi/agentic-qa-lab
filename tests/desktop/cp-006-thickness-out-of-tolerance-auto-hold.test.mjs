// CP-006 · An out-of-tolerance thickness measurement holds the coil automatically (Level 2).
// Preconditions by MES interfaces (unique order + released coil), steps on the L2 desktop client,
// validation by data (MES API) and by what the client shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { desktop } from "./support/desktop.mjs";

const ID = "CP-006";
const c = parse(readFileSync(new URL(`../../catalog/cases/${ID}.yaml`, import.meta.url), "utf8"));
const MES = process.env.MES_URL ?? "http://127.0.0.1:13000";
const APP = "java";
const MAIN = "Level 2 · Hot strip mill";
const WARNING = "Measurement out of tolerance";

// Master data that must already exist (the business owns it): customer and S275JR product.
const CUSTOMER = "Northline Fabrication Ltd.";
const PRODUCT = "Hot-rolled coil S275JR";
// The released coil of the case: 3.00 mm × 1250 mm nominal.
const NOMINAL = { thickness_mm: "3.00", width_mm: "1250", weight_kg: 24350 };

const tag = Date.now().toString(36).toUpperCase().slice(-6);
const ERP_REF = `QA/CP006/${tag}`;
const COIL_NO = `CP6-${tag}`;

async function mes(method, path, body) {
  const r = await fetch(`${MES}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  assert.ok(r.ok, `${method} ${path} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}

const has = (texts, s) => texts.some((t) => t.includes(s));
const until = async (fn, timeoutMs = 10_000) => {
  const end = Date.now() + timeoutMs;
  let v = fn();
  while (!v && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    v = fn();
  }
  return v;
};

test(`${ID} · ${c.title}`, async (t) => {
  const d = desktop(APP, `evidence/desktop/${ID}`);
  const stop = d.record();
  let coil, producedBefore;
  try {
    // --- Preconditions: an order in progress (S275JR) with a released 3.00 × 1250 mm coil ---
    await mes("POST", "/api/orders", {
      erp_ref: ERP_REF, sale_ref: null, customer: CUSTOMER, product: PRODUCT, grade: "S275JR", qty_t: 48.5, due_date: null,
    });
    let order = await mes("GET", `/api/orders/${encodeURIComponent(ERP_REF)}`);
    // The MES documents no API to register a coil: it is done on its order screen (form post).
    const reg = await fetch(`${MES}/orders/${order.id}/coils`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        coil_no: COIL_NO, heat_no: "600601", weight_kg: String(NOMINAL.weight_kg),
        thickness_mm: NOMINAL.thickness_mm, width_mm: NOMINAL.width_mm, quality: "OK",
      }),
    });
    assert.equal(reg.status, 303, "coil registered on the MES order screen");
    order = await mes("GET", `/api/orders/${encodeURIComponent(ERP_REF)}`);
    assert.equal(order.status, "in_progress");
    assert.equal(order.grade, "S275JR");
    const spec = await mes("GET", "/api/grades/S275JR");
    assert.equal(spec.thickness_tol_mm, 0.15);
    assert.deepEqual(spec.width_tol_mm, { minus: 0, plus: 10 });
    assert.equal(spec.flatness_max_iu, 15);
    coil = order.coils.find((k) => k.coil_no === COIL_NO);
    assert.equal(coil.quality, "OK");
    producedBefore = order.produced_t;

    d.close();
    await t.test(c.steps[0], () => {
      // Open the client "Level 2 · Hot strip mill" and press "Measurements"
      d.launch(`l2-client ${MES}`, MAIN);
      d.click("switch", "Measurements");
      d.screenshot("measurements-tab");
    });

    await t.test(c.steps[1], async () => {
      // Type the coil in "Coil to measure" and press "Load coil"
      d.type("textfield", "Coil to measure", COIL_NO);
      d.click("button", "Load coil");
      // Expected: before measuring, the client shows the thickness limits "2.85 – 3.15 mm"
      const shown = await until(() => { const x = d.texts(); return has(x, "2.85 – 3.15 mm") && x; });
      d.screenshot("coil-loaded-limits");
      assert.ok(shown, `thickness limits "2.85 – 3.15 mm" shown; screen: ${JSON.stringify(d.texts())}`);
    });

    await t.test(c.steps[2], async () => {
      // Enter thickness 3.25, width 1252 and flatness 8 and press "Register measurement"
      d.type("textfield", "Measured thickness (mm)", String(c.data.thickness_mm));
      d.type("textfield", "Measured width (mm)", String(c.data.width_mm));
      d.type("textfield", "Measured flatness (I)", String(c.data.flatness_i));
      d.click("button", "Register measurement");
      // Expected: warning "Measurement out of tolerance" with "Thickness 3.25 mm outside 2.85–3.15 mm"
      const w = await until(() => d.window(WARNING));
      d.screenshot("out-of-tolerance-warning");
      assert.ok(w, `warning window "${WARNING}" appears`);
      // While the modal is open the app's accessibility tree is the dialog alone (its texts, not the main window's).
      const texts = d.texts();
      assert.ok(has(texts, `The measurement of coil ${COIL_NO} is out of tolerance`), `warning dialog: ${JSON.stringify(texts)}`);
      assert.ok(has(texts, "Thickness 3.25 mm outside 2.85–3.15 mm"), `warning text: ${JSON.stringify(texts)}`);
      // The hold comes from the MES, not from the operator pressing "Hold".
      assert.ok(has(texts, "The MES has HELD the coil"), `warning says the MES held the coil: ${JSON.stringify(texts)}`);
      d.keys("", "Return"); // JOptionPane owns focus: acknowledge it
      d.waitWindowGone(WARNING);
      d.screenshot("after-warning");
    });

    // --- Validation by data (MES API) ---
    const k = await mes("GET", `/api/coils/${coil.id}`);
    assert.equal(k.quality, "HOLD");
    assert.equal(k.hold_motive, "Thickness out of tolerance");
    assert.equal(k.measurements[0].result, "NOK");
    assert.equal(k.events[0].action, "HOLD");
    assert.equal(k.events[0].operator, "MES", "held by the MES, not by an operator pressing Hold");
    const after = await mes("GET", `/api/orders/${encodeURIComponent(ERP_REF)}`);
    assert.equal(Math.round((producedBefore - after.produced_t) * 1000), coil.weight_kg,
      "produced quantity drops by exactly the coil's weight");
  } finally {
    d.close();
    await stop();
  }
});
