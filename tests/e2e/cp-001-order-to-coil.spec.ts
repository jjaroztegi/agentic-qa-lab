// spec: specs/CP-001.md (case: catalog/cases/CP-001.yaml)
// seed: tests/e2e/seed.spec.ts
import { test, expect, type Page } from "@playwright/test";
import { loadCase, erp, mes, eventually, runTag, ENV } from "./support/index.ts";

const fmt = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 3) });

// MES screens are server-rendered: reload until the expected state shows up (the ERP interface is asynchronous).
async function reloadUntil(page: Page, url: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(url);
    await check();
  }).toPass({ timeout: 90_000, intervals: [3_000] });
}

test("CP-001 Hot-rolled coil sales order through to production confirmed in the ERP", async ({ page }) => {
  const c = loadCase("CP-001");
  const { customer, product, quantity_t } = c.data;
  const run = runTag();
  const coils = (c.data.coils as any[]).map((k, i) => ({ ...k, coil: `C-${run}-${i + 1}` }));
  const producedT = coils.filter((k) => k.quality_status === "Released").reduce((s, k) => s + k.weight_kg, 0) / 1000;
  test.info().annotations.push({ type: "coils", description: coils.map((k) => k.coil).join(", ") });

  let saleOrder = "";
  let erpOrder = "";
  let mesOrderUrl = "";

  await test.step("Log in to the ERP as the sales rep", async () => {
    await page.goto(`${ENV.erpUrl}/web/login?db=${ENV.erpDb}`);
    await page.getByRole("textbox", { name: /email|login/i }).fill(ENV.sales.login);
    await page.getByRole("textbox", { name: /password/i }).fill(ENV.sales.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForURL(/\/odoo/);
  });

  await test.step("In the ERP, as the sales rep, create a quotation for the customer with the product and quantity, and confirm it", async () => {
    await page.getByTitle("Home Menu").click();
    await page.getByRole("menuitem", { name: "Sales" }).click();
    await page.waitForURL(/\/odoo\/sales/);
    await page.getByRole("button", { name: "New" }).click();
    await page.waitForURL(/\/odoo\/sales\/new/);
    await page.getByRole("combobox", { name: "Customer" }).fill(customer);
    await page.getByRole("option", { name: customer, exact: true }).click();
    await page.getByRole("button", { name: "Add a product" }).click();
    await page.getByRole("combobox", { name: "Search a product" }).fill(product);
    await page.getByRole("option", { name: product }).first().click();
    await page.getByRole("cell", { name: "1.000" }).getByRole("textbox").fill(fmt(quantity_t));
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("radio", { name: "Sales Order" })).toBeChecked();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/^S\d+$/);
    saleOrder = (await heading.innerText()).trim();
    test.info().annotations.push({ type: "sales order", description: saleOrder });

    const so = await erp.saleOrder(saleOrder);
    expect(so?.state, "ERP sales order state").toBe("sale");
    expect(so?.partner_id[1], "ERP sales order customer").toBe(customer);
  });

  await test.step("Check that the ERP creates a manufacturing order for the sales order", async () => {
    // The sales key user has no Manufacturing access: checked by data.
    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => !!v);
    expect(mo, `manufacturing order with origin ${saleOrder}`).toBeDefined();
    expect(mo!.product_qty, "manufacturing order quantity").toBeCloseTo(quantity_t, 3);
    erpOrder = mo!.name;
    test.info().annotations.push({ type: "order", description: erpOrder });
  });

  await test.step("In the MES, open the order that arrives from the ERP for that sales order", async () => {
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: saleOrder, exact: true }) });
    await reloadUntil(page, ENV.mesUrl, () => expect(row).toBeVisible({ timeout: 2_000 }));
    await expect(row.getByRole("cell", { name: customer, exact: true })).toBeVisible();
    await row.getByRole("link", { name: erpOrder }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Order ${erpOrder}`);
    mesOrderUrl = page.url();
  });

  await test.step("Register the three coils with their data", async () => {
    const table = page.getByRole("table", { name: "Coils" });
    for (const k of coils) {
      await page.getByRole("textbox", { name: "Coil no." }).fill(k.coil);
      await page.getByRole("textbox", { name: "Heat no." }).fill(k.heat);
      await page.getByRole("textbox", { name: "Weight (kg)" }).fill(String(k.weight_kg));
      await page.getByRole("textbox", { name: "Thickness (mm)" }).fill(String(k.thickness_mm));
      await page.getByRole("textbox", { name: "Width (mm)" }).fill(String(k.width_mm));
      await page.getByRole("combobox", { name: "Quality status" }).selectOption({ label: k.quality_status });
      await page.getByRole("button", { name: "Register coil" }).click();
      const row = table.getByRole("row").filter({ has: page.getByRole("cell", { name: k.coil, exact: true }) });
      await expect(row).toContainText(k.quality_status);
    }
    await expect(table.getByRole("row")).toHaveCount(coils.length + 1);
  });

  await test.step("Complete the order", async () => {
    await page.getByRole("button", { name: "Complete order" }).click();
    await expect(page.getByRole("button", { name: "Complete order" })).toBeHidden();
  });

  await test.step('The MES order changes to "Confirmed in ERP"', async () => {
    await reloadUntil(page, mesOrderUrl, () =>
      expect(page.getByRole("definition").filter({ hasText: "Confirmed in ERP" })).toBeVisible({ timeout: 2_000 }));
  });

  await test.step(`The MES shows produced ${fmt(producedT, 3)} t (released coils only)`, async () => {
    await expect.soft(page.getByTestId("produced")).toHaveText(`${fmt(producedT, 3)} t`);
  });

  await test.step(`In the ERP the manufacturing order is done with ${fmt(producedT, 3)} t produced`, async () => {
    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => v?.state === "done");
    expect(mo?.state, "ERP mrp.production.state").toBe("done");
    expect(mo?.qty_produced, "ERP mrp.production.qty_produced").toBeCloseTo(producedT, 3);

    const order = await eventually(() => mes.orderByErpRef(erpOrder), (v) => v?.status === "reported");
    expect(order?.status, "MES status").toBe("reported");
    expect(order?.produced_t, "MES produced_t").toBeCloseTo(producedT, 3);
  });
});
