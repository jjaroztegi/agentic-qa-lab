import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTonnes, gradeOf, parseCoil, parseInboundOrder, producedTonnes } from "../src/domain.ts";

const coil = { coil_no: "C-24001", heat_no: "512345", weight_kg: "24500", thickness_mm: "3,5", width_mm: "1500", quality: "OK" };

test("parseCoil accepts a coil inside the mill envelope (comma decimals too)", () => {
  const { coil: c, errors } = parseCoil(coil);
  assert.deepEqual(errors, []);
  assert.equal(c!.thickness_mm, 3.5);
});

test("parseCoil rejects weights outside 1–40 t and malformed heat numbers", () => {
  assert.match(parseCoil({ ...coil, weight_kg: "0" }).errors.join(), /Weight/);
  assert.match(parseCoil({ ...coil, weight_kg: "-5" }).errors.join(), /Weight/);
  assert.match(parseCoil({ ...coil, weight_kg: "45000" }).errors.join(), /Weight/);
  assert.match(parseCoil({ ...coil, heat_no: "12A" }).errors.join(), /Heat no/);
});

test("producedTonnes counts only quality-released coils, in tonnes", () => {
  assert.equal(producedTonnes([
    { weight_kg: 24_500, quality: "OK" },
    { weight_kg: 23_250, quality: "OK" },
    { weight_kg: 22_000, quality: "HOLD" },
  ]), 47.75);
});

test("gradeOf extracts the steel grade from the ERP product name", () => {
  assert.equal(gradeOf("Hot-rolled coil S275JR"), "S275JR");
  assert.equal(gradeOf("Pickled coil DD11"), "DD11");
  assert.equal(gradeOf("Scrap"), "N/A");
});

// Contract ERP -> MES: the fixture is a real manufacturing order read from the ERP
// (tests/contracts/fixtures). If either side changes the shape, this fails first.
test("contract: inbound order from ERP fixture satisfies the MES contract", async () => {
  const { toInbound } = await import("../src/erp.ts");
  const fixture = JSON.parse(await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../../tests/contracts/fixtures/erp-mrp-production.json", import.meta.url), "utf8")));
  const order = toInbound(fixture.mo, fixture.customer);
  assert.equal(order.erp_ref, fixture.mo.name);
  assert.ok(order.qty_t > 0);
  assert.match(order.due_date ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

test("contract: MES rejects orders without quantity in tonnes", () => {
  const { errors } = parseInboundOrder({ erp_ref: "WH/MO/1", customer: "X", product: "P", grade: "S275JR", qty_t: "25" });
  assert.match(errors.join(), /qty_t/);
});

test("formatTonnes keeps kg precision with en-US separators (47.750 t, 1,250.500 t)", () => {
  assert.equal(formatTonnes(47.75), "47.750 t");
  assert.equal(formatTonnes(1250.5), "1,250.500 t");
});
