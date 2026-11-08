import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availability, coilLimits, evaluateMeasurement, gradeSpec, parseHold, parseMeasurement, parseRelease, parseStop, shiftWindow,
} from "../src/domain.ts";

const s275 = { grade: "S275JR", thickness_mm: 3, width_mm: 1250 };

test("coilLimits: coil nominal +/- grade tolerance; unknown grade has no spec", () => {
  assert.deepEqual(coilLimits(s275), { grade: "S275JR", thickness_mm: [2.85, 3.15], width_mm: [1250, 1260], flatness_iu: [0, 15] });
  assert.deepEqual(coilLimits({ grade: "DD11", thickness_mm: 2.5, width_mm: 1250 })!.thickness_mm, [2.4, 2.6]);
  assert.equal(coilLimits({ ...s275, grade: "N/A" }), null);
  assert.equal(gradeSpec("S355J2")!.flatness_max_iu, 12);
});

test("evaluateMeasurement: limits are inclusive; each dimension gives its own hold motive", () => {
  const l = coilLimits(s275)!;
  assert.deepEqual(evaluateMeasurement({ thickness_mm: 3.15, width_mm: 1250, flatness_iu: 15 }, l), []);
  const f = evaluateMeasurement({ thickness_mm: 3.25, width_mm: 1248, flatness_iu: 16 }, l);
  assert.deepEqual(f.map((x) => x.motive), ["Thickness out of tolerance", "Width out of tolerance", "Flatness defect"]);
  assert.equal(f[0].message, "Thickness 3.25 mm outside 2.85–3.15 mm");
});

test("parseMeasurement accepts comma decimals and rejects empty or negative values", () => {
  assert.deepEqual(parseMeasurement({ thickness_mm: "3,02", width_mm: "1252", flatness_iu: "0" }).m, { thickness_mm: 3.02, width_mm: 1252, flatness_iu: 0 });
  assert.match(parseMeasurement({ thickness_mm: "", width_mm: "1252", flatness_iu: "4" }).errors.join(), /Thickness/);
  assert.match(parseMeasurement({ thickness_mm: "3", width_mm: "-1", flatness_iu: "4" }).errors.join(), /Width/);
});

test("hold needs a coded motive; release needs a coded motive and a known supervisor", () => {
  assert.equal(parseHold({ motive: "flatness defect" }).hold!.motive, "Flatness defect");
  assert.match(parseHold({ motive: "Looks wrong" }).errors.join(), /motive/);
  assert.match(parseRelease({ motive: "Reinspection passed" }).errors.join(), /requires the supervisor number/);
  assert.match(parseRelease({ motive: "Reinspection passed", supervisor: "OP0117" }).errors.join(), /OP0117 is not a shift supervisor/);
  assert.deepEqual(parseRelease({ motive: "Reinspection passed", supervisor: "s0412" }).release,
    { motive: "Reinspection passed", supervisor: "S0412", comment: null });
});

test("parseStop: valid range, coded reason, no overlap with registered stops", () => {
  const ok = { start_at: "2026-11-09T10:00", end_at: "2026-11-09T10:30", reason: "Roll change" };
  assert.deepEqual(parseStop(ok, []).errors, []);
  assert.match(parseStop({ ...ok, end_at: "2026-11-09T09:00" }, []).errors.join(), /end after it starts/);
  assert.match(parseStop({ ...ok, start_at: "09/11/2026 10:00" }, []).errors.join(), /YYYY-MM-DDTHH:MM/);
  assert.match(parseStop({ ...ok, reason: "Coffee" }, []).errors.join(), /reason/);
  assert.match(parseStop(ok, [{ start_at: "2026-11-09T10:20", end_at: "2026-11-09T11:00" }]).errors.join(), /Overlaps/);
  assert.deepEqual(parseStop(ok, [{ start_at: "2026-11-09T10:30", end_at: "2026-11-09T11:00" }]).errors, [], "touching is not overlapping");
});

test("shiftWindow: night shift belongs to the day it starts and ends next morning", () => {
  assert.deepEqual(shiftWindow("2026-11-09", "M"), { from: "2026-11-09T06:00", to: "2026-11-09T14:00" });
  assert.deepEqual(shiftWindow("2026-12-31", "N"), { from: "2026-12-31T22:00", to: "2027-01-01T06:00" });
  assert.equal(shiftWindow("2026-11-09", "X" as any), null);
  assert.equal(shiftWindow("09/11/2026", "M"), null);
});

test("availability counts only the stop time inside the shift", () => {
  const w = shiftWindow("2026-11-09", "M")!;
  assert.deepEqual(availability([], w), { planned_min: 480, stop_min: 0, availability_pct: 100 });
  assert.deepEqual(availability([{ start_at: "2026-11-09T10:00", end_at: "2026-11-09T10:30" }], w),
    { planned_min: 480, stop_min: 30, availability_pct: 93.8 });
  // 05:30-06:45 straddles the shift start: 45 min count.
  assert.equal(availability([{ start_at: "2026-11-09T05:30", end_at: "2026-11-09T06:45" }], w).stop_min, 45);
});
