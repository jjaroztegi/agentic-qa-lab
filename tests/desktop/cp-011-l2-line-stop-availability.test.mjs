// case: catalog/cases/CP-011.yaml — a line stop registered in L2 reduces the Morning shift availability.
// Run: node --test 'tests/desktop/*.test.mjs'   (MES_URL, DESKTOP_EXEC optional)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { desktop } from "./support/desktop.mjs";

const CASE = parse(readFileSync(new URL("../../catalog/cases/CP-011.yaml", import.meta.url), "utf8"));
const MES = process.env.MES_URL ?? "http://127.0.0.1:13000";
const APP_CMD = `l2-client ${MES}`;
const { shift: SHIFT, stop: STOP, overlapping_stop: OVERLAP } = CASE.data;
const SHIFT_CODE = { Morning: "M", Afternoon: "T", Night: "N" }[SHIFT]; // MES API shift codes

// Texts from the case.
const [open, register, selectShift, registerOverlap] = CASE.steps;
const TITLE = open.match(/"([^"]+)"/)[1]; // Level 2 · Hot strip mill
const TAB_STOPS = open.match(/press "([^"]+)"/)[1]; // Stops
const BTN_REGISTER = register.match(/press "([^"]+)"/)[1]; // Register stop
const [tableResult, availResult, overlapResult] = CASE.expected_results;
const TABLE = tableResult.match(/table "([^"]+)"/)[1]; // Stops of the day
const [PCT, STOPS_LINE] = [...availResult.matchAll(/"([^"]+)"/g)].map((m) => m[1]); // 93.8% · Stops: 30 min of 480 min planned
const OVERLAP_MSG = overlapResult.match(/"([^"]+)"/)[1]; // Overlaps the stop
const minutes = (a, b) => { const m = (s) => +s.slice(0, 2) * 60 + +s.slice(3); return m(b) - m(a); };

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
  return r.json();
}
/** Row of "Stops of the day" starting at `start`, read from the window texts (Start, End, Duration, Reason). */
function stopRow(texts, start, end) {
  const i = texts.findIndex((s, k) => s === start && texts[k + 1] === end);
  return i < 0 ? null : { start: texts[i], end: texts[i + 1], duration: texts[i + 2], reason: texts[i + 3] };
}

test(`${CASE.id} ${CASE.title}`, async (t) => {
  const evidence = `evidence/desktop/${CASE.id}`;
  const d = desktop("java", evidence);

  // Precondition by API: a unique date per run with no stops registered (far future, random, checked empty).
  let date;
  for (let i = 0; i < 20 && !date; i++) {
    const y = 2200 + Math.floor(Math.random() * 800), m = 1 + Math.floor(Math.random() * 12), dd = 1 + Math.floor(Math.random() * 28);
    const c = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if ((await api(`/api/stops?date=${c}`)).length === 0) date = c;
  }
  assert.ok(date, "precondition: a date with no stops");
  const before = await api(`/api/availability?date=${date}&shift=${SHIFT_CODE}`);
  assert.equal(before.planned_min, 480, "precondition: Morning shift has 480 min planned");
  assert.equal(before.stop_min, 0);
  t.diagnostic(`test date ${date}`);

  // support close() exits 143 when no app is open (its pkill matches its own shell): only close a leftover client.
  if (d.window(TITLE)) d.close();
  const stop = d.record();
  try {
    await t.test(open, () => {
      d.launch(APP_CMD, TITLE);
      assert.ok(d.window(TITLE), `window "${TITLE}" is open`);
      d.click("switch", TAB_STOPS);
      d.screenshot("stops-tab");
    });

    await t.test(register, async () => {
      d.type("textfield", "Date", date);
      d.type("textfield", "Start time", STOP.start);
      d.type("textfield", "End time", STOP.end);
      d.type("textfield", "Stop reason", STOP.reason);
      d.click("button", BTN_REGISTER);
      const r = await until(() => stopRow(d.texts(), STOP.start, STOP.end), `stop ${STOP.start}–${STOP.end} in "${TABLE}"`);
      assert.deepEqual(r, { start: STOP.start, end: STOP.end, duration: String(minutes(STOP.start, STOP.end)), reason: STOP.reason });
      d.screenshot("stop-registered");
    });

    await t.test(selectShift, async () => {
      d.click("radiobutton", SHIFT);
      await until(() => d.texts().includes(`${SHIFT} shift · ${date}`), `${SHIFT} shift availability shown`);
      await until(() => d.texts().includes(PCT), `availability ${PCT}`);
      assert.ok(d.texts().includes(STOPS_LINE), `"${STOPS_LINE}" is shown`);
      d.screenshot("morning-availability");
    });

    await t.test(registerOverlap, async () => {
      d.type("textfield", "Start time", OVERLAP.start);
      d.type("textfield", "End time", OVERLAP.end);
      d.type("textfield", "Stop reason", OVERLAP.reason);
      d.click("button", BTN_REGISTER);
      const msg = await until(() => d.texts().find((s) => s.includes(OVERLAP_MSG)), `"${OVERLAP_MSG}" message`);
      t.diagnostic(msg);
      assert.equal(stopRow(d.texts(), OVERLAP.start, OVERLAP.end), null, "the overlapping stop is not in the table");
      d.screenshot("overlap-rejected");
    });

    await t.test("Result: the table, the availability and the rejection on screen", () => {
      const texts = d.texts();
      assert.equal(stopRow(texts, STOP.start, STOP.end)?.reason, STOP.reason, `"${TABLE}" shows the ${STOP.reason} stop`);
      assert.equal(stopRow(texts, STOP.start, STOP.end)?.duration, "30");
      assert.ok(texts.includes(`${SHIFT} shift · ${date}`));
      assert.ok(texts.includes(PCT), `availability stays at ${PCT}`);
      assert.ok(texts.includes(STOPS_LINE), `"${STOPS_LINE}"`);
      assert.ok(texts.some((s) => s.includes(OVERLAP_MSG)), `"${OVERLAP_MSG}" is shown`);
    });

    await t.test("Data validation in the MES", async () => {
      const stops = await api(`/api/stops?date=${date}`);
      assert.equal(stops.length, 1, "exactly 1 stop");
      assert.equal(stops[0].start_at, `${date}T${STOP.start}`);
      assert.equal(stops[0].end_at, `${date}T${STOP.end}`);
      assert.equal(stops[0].reason, STOP.reason);

      const av = await api(`/api/availability?date=${date}&shift=${SHIFT_CODE}`);
      assert.equal(av.stop_min, 30);
      assert.equal(av.availability_pct, 93.8);
    });
  } finally {
    if (d.window(TITLE)) d.close();
    await stop();
  }
});
