// spec: specs/CP-009.md (case: catalog/cases/CP-009.yaml)
// seed: tests/e2e/seed.spec.ts
// Black-box case: the MES validation was learned from its screen only.
import { test, expect } from "@playwright/test";
import { loadCase, mes, eventually, runTag, ENV } from "./support/index.ts";

// The MES form also requires thickness and width, which the case does not give (see report).
// Plausible hot-rolled coil dimensions, irrelevant to the heat-number validation under test.
const FORM_FILLERS = { thickness_mm: 3, width_mm: 1500 };

test("CP-009 The MES rejects a coil with a malformed heat number", async ({ page }) => {
  const c = loadCase("CP-009");
  const { heat, weight_kg } = c.data;
  const coilNo = `C-${runTag()}-1`;
  test.info().annotations.push({ type: "coils", description: coilNo });

  // Precondition: a pending or in-progress order in the MES (orders arrive from the ERP).
  const orders = (await (await fetch(`${ENV.mesUrl}/api/orders`)).json()) as { erp_ref: string; status: string }[];
  const target = orders.find((o) => ["pending", "in_progress"].includes(o.status));
  expect(target, "Precondition: a pending or in-progress order exists in the MES").toBeDefined();
  const erpRef = target!.erp_ref;
  test.info().annotations.push({ type: "order", description: erpRef });

  const before = await mes.orderByErpRef(erpRef);
  expect(before, `MES order ${erpRef}`).toBeDefined();
  const coilsBefore = before!.coils.length;

  await test.step("Open the order in the MES", async () => {
    await page.goto(ENV.mesUrl);
    await page.getByRole("link", { name: erpRef, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Order ${erpRef}` })).toBeVisible();
    await expect(page.getByRole("heading", { name: "New coil" })).toBeVisible();
  });

  await test.step(`Try to add a coil with heat no. ${heat}`, async () => {
    await page.getByRole("textbox", { name: "Coil no." }).fill(coilNo);
    await page.getByRole("textbox", { name: "Heat no." }).fill(String(heat));
    await page.getByRole("textbox", { name: "Weight (kg)" }).fill(String(weight_kg));
    await page.getByRole("textbox", { name: "Thickness (mm)" }).fill(String(FORM_FILLERS.thickness_mm));
    await page.getByRole("textbox", { name: "Width (mm)" }).fill(String(FORM_FILLERS.width_mm));
    await page.getByRole("button", { name: "Register coil" }).click();
  });

  await test.step('The MES shows "Heat no. must have 6 digits" and does not register the coil', async () => {
    await expect(page.getByRole("alert")).toHaveText("Heat no. must have 6 digits");
    await expect(page.getByRole("table", { name: "Coils" }).getByRole("cell", { name: coilNo })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("rejected.png") });
  });

  await test.step("MES GET /api/orders/{order}: the number of coils does not change", async () => {
    // Give an asynchronous write the chance to show up; the check must still hold afterwards.
    const after = await eventually(() => mes.orderByErpRef(erpRef), (v) => !!v && v.coils.length !== coilsBefore, 6_000);
    expect(after!.coils.length, `MES coils on ${erpRef}`).toBe(coilsBefore);
    expect(after!.coils.some((k: any) => JSON.stringify(k).includes(coilNo)), `coil ${coilNo} in MES`).toBe(false);
  });
});
