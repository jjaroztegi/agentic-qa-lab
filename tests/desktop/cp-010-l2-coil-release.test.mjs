// case: catalog/cases/CP-010.yaml — release of a held coil with supervisor authorization (L2 desktop client).
// Run: node --test 'tests/desktop/*.test.mjs'   (MES_URL, DESKTOP_EXEC optional)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { desktop } from "./support/desktop.mjs";

const CASE = parse(readFileSync(new URL("../../catalog/cases/CP-010.yaml", import.meta.url), "utf8"));
const MES = process.env.MES_URL ?? "http://127.0.0.1:13000";
const APP_CMD = `l2-client ${MES}`;
const COLS = ["Coil", "Order", "Customer", "Grade", "Nominal thickness (mm)", "Weight (kg)", "Status"];
const quoted = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// Business values come from the case text.
const [open, noSupervisor, withSupervisor] = CASE.steps;
const [TITLE] = quoted(open); // Level 2 · Hot strip mill
const [BTN_RELEASE, , BTN_CONFIRM] = quoted(noSupervisor); // Release, (reason), Confirm release
const { reason: REASON, supervisor: SUPERVISOR, comment: COMMENT } = CASE.data;
const HOLD_REASON = CASE.preconditions[0].match(/reason "([^"]+)"/)[1]; // Flatness defect
const [MSG_NO_SUPERVISOR] = quoted(CASE.expected_results[0]); // Release requires the supervisor number
const [HIST_ACTION, HIST_BY] = quoted(CASE.expected_results[1]); // Release, Sup. S0412
const [, NOT_SUPERVISOR, MSG_NOT_SUPERVISOR] = CASE.data_validation[1].match(/supervisor (\S+): 422 '([^']+)'/);
const DIALOG = "Release coil"; // window title of the client's release dialog

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
async function call(path, init) {
  // The MES drops idle keep-alive sockets after 5 s; a GET reusing one after the desktop phase is retried once.
  return fetch(`${MES}${path}`, init).catch((e) => {
    if (init?.method || e.cause?.code !== "UND_ERR_SOCKET") throw e;
    return fetch(`${MES}${path}`);
  });
}
async function api(path, init) {
  const r = await call(path, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}
const postJson = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Row of the client table for a coil, read from the window texts (cells come in column order). */
function row(texts, coilNo) {
  const i = texts.indexOf(coilNo);
  return i < 0 ? null : Object.fromEntries(COLS.map((c, k) => [c, texts[i + k]]));
}
/** Quality history row whose "By" cell is `by`: [Action, Reason, By, Comment]. */
function historyRow(texts, by) {
  const i = texts.indexOf(by);
  return i < 2 ? null : { action: texts[i - 2], reason: texts[i - 1], by, comment: texts[i + 1] };
}
const tonnes = (x) => Math.round(x * 1000) / 1000;

test(`${CASE.id} ${CASE.title}`, async (t) => {
  const run = Date.now().toString(36).toUpperCase();
  const evidence = `evidence/desktop/${CASE.id}`;
  const d = desktop("java", evidence);

  // Supervisor master data must exist in the MES (not created by the test).
  const codes = await api("/api/codes");
  assert.ok(codes.supervisors.some((s) => s.id === SUPERVISOR), `precondition: supervisor ${SUPERVISOR} is registered in the MES`);
  assert.ok(!codes.supervisors.some((s) => s.id === NOT_SUPERVISOR), `precondition: ${NOT_SUPERVISOR} is not a supervisor`);

  // Precondition by API: an order in progress with a coil held for "Flatness defect".
  const erpRef = `CP010-${run}`;
  const order = await api("/api/orders", postJson({ erp_ref: erpRef, customer: "QA CP-010", product: "Hot-rolled coil S275JR", grade: "S275JR", qty_t: 50 }));
  const coils = [
    { coil_no: `C10-${run}-1`, heat_no: "512345", weight_kg: "24500", thickness_mm: "3", width_mm: "1250", quality: "OK" },
    { coil_no: `C10-${run}-2`, heat_no: "512345", weight_kg: "23250", thickness_mm: "3", width_mm: "1250", quality: "OK" },
  ];
  for (const c of coils) {
    // The MES registers coils through its form endpoint (303 on success, 422 with errors).
    const r = await fetch(`${MES}/orders/${order.id}/coils`, { method: "POST", body: new URLSearchParams(c), redirect: "manual" });
    assert.equal(r.status, 303, `register coil ${c.coil_no}`);
  }
  const target = (await api(`/api/orders/${order.id}`)).coils.find((c) => c.coil_no === coils.at(-1).coil_no);
  await api(`/api/coils/${target.id}/hold`, postJson({ motive: HOLD_REASON }));
  const before = await api(`/api/orders/${order.id}`);
  assert.equal(before.status, "in_progress");
  assert.equal(before.coils.find((c) => c.id === target.id).quality, "HOLD", "precondition: the coil is held");
  t.diagnostic(`order ${erpRef}, coil ${target.coil_no} (id ${target.id}), produced before ${before.produced_t} t`);

  // support close() exits 143 when no app is open (its pkill matches its own shell): only close a leftover client.
  if (d.window(TITLE)) d.close();
  const stop = d.record();
  try {
    await t.test(open, async () => {
      d.launch(APP_CMD, TITLE);
      assert.ok(d.window(TITLE), `window "${TITLE}" is open`);
      d.type("textfield", "Coil filter", target.coil_no);
      d.click("button", "Refresh");
      const r = await until(() => row(d.texts(), target.coil_no), `coil ${target.coil_no} in the table`);
      assert.equal(r.Status, "HOLD");
      assert.equal(r.Order, erpRef);
      d.selectOnlyRow("Coils");
      await until(() => d.texts().includes(`Detail · coil ${target.coil_no}`), "coil detail shown");
      d.screenshot("held-coil-selected");
    });

    await t.test(noSupervisor, async () => {
      d.click("button", BTN_RELEASE);
      await until(() => d.window(DIALOG), "release dialog");
      // The modal dialog opens with the reason combo focused; Return triggers its default button (Confirm release).
      d.keys(REASON);
      await until(() => d.texts().includes(MSG_NO_SUPERVISOR), `dialog shows "${MSG_NO_SUPERVISOR}"`);
      assert.ok(d.window(DIALOG), "the dialog stays open");
      d.screenshot("supervisor-required");
      const k = await api(`/api/coils/${target.id}`);
      assert.equal(k.quality, "HOLD", "the coil stays HOLD");
      assert.equal(k.events.length, 1, "no release was recorded");
    });

    // Checked while the coil is still held (the dialog stays open), so the refusal is about the supervisor only.
    await t.test(`Data validation: release with ${NOT_SUPERVISOR} is refused by the MES`, async () => {
      const r = await call(`/api/coils/${target.id}/release`, postJson({ motive: REASON, supervisor: NOT_SUPERVISOR, comment: COMMENT }));
      assert.equal(r.status, 422);
      assert.ok((await r.json()).errors.includes(MSG_NOT_SUPERVISOR), `error "${MSG_NOT_SUPERVISOR}"`);
      const k = await api(`/api/coils/${target.id}`);
      assert.equal(k.quality, "HOLD", "the coil stays HOLD");
      assert.equal(k.events.length, 1, "no release was recorded");
    });

    await t.test(withSupervisor, async () => {
      d.type("textfield", "Supervisor", SUPERVISOR);
      d.type("textfield", "Comment", COMMENT);
      d.screenshot("release-filled");
      d.click("button", BTN_CONFIRM);
      d.waitWindowGone(DIALOG);
      await until(() => row(d.texts(), target.coil_no)?.Status === "OK", "coil is OK in the table");
      await until(() => historyRow(d.texts(), HIST_BY), `quality history shows "${HIST_BY}"`);
      d.screenshot("coil-released");
    });

    await t.test("Result: the table shows the coil as OK and the quality history a Release by the supervisor", () => {
      const texts = d.texts();
      assert.equal(row(texts, target.coil_no)?.Status, "OK");
      assert.deepEqual(historyRow(texts, HIST_BY), { action: HIST_ACTION, reason: REASON, by: HIST_BY, comment: COMMENT });
    });

    await t.test("Data validation in the MES", async () => {
      const k = await api(`/api/coils/${target.id}`);
      assert.equal(k.quality, "OK");
      assert.equal(k.events[0].action, "RELEASE");
      assert.equal(k.events[0].supervisor, SUPERVISOR);
      assert.equal(k.events[0].motive, REASON);
      assert.equal(k.events[0].comment, COMMENT);

      const after = await api(`/api/orders/${order.id}`);
      assert.equal(after.produced_t, tonnes(before.produced_t + target.weight_kg / 1000), "produced includes the coil weight again");
    });
  } finally {
    if (d.window(TITLE)) d.close();
    await stop();
  }
});
