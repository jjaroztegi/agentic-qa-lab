import { test } from "node:test";
import assert from "node:assert/strict";
import { plantDate } from "../src/erp.ts";

test("plantDate turns an Odoo UTC datetime into the plant's calendar day", () => {
  assert.equal(plantDate("2026-12-14 23:00:00", "Europe/Berlin"), "2026-12-15"); // winter, UTC+1
  assert.equal(plantDate("2026-06-14 22:30:00", "Europe/Berlin"), "2026-06-15"); // summer, UTC+2
  assert.equal(plantDate("2026-12-15 10:00:00", "Europe/Berlin"), "2026-12-15");
  assert.equal(plantDate("2026-12-15 03:00:00", "America/Chicago"), "2026-12-14");
});

test("plantDate keeps plain dates and rejects what is not a date", () => {
  assert.equal(plantDate("2026-12-15"), "2026-12-15");
  assert.equal(plantDate(false), null);
  assert.equal(plantDate(""), null);
  assert.equal(plantDate("not a date"), null);
});
