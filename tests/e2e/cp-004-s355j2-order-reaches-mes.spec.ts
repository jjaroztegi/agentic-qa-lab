// spec: specs/CP-004.md (case: catalog/cases/CP-004.yaml)
// seed: tests/e2e/seed.spec.ts
import { test, expect } from "@playwright/test";
import { loadCase, erp, mes, eventually, ENV } from "./support/index.ts";

const fmt = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 3) });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("CP-004 S355J2 sales order reaches the MES with the correct customer, grade and quantity", async ({ page }) => {
  const c = loadCase("CP-004");
  const { customer, product, grade, quantity_t } = c.data;

  let saleOrder = "";
  let erpOrder = "";

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
    expect(so?.state, "ERP sale.order.state").toBe("sale");
    expect(so?.partner_id[1], "ERP sale.order customer").toBe(customer);
  });

  await test.step("Check that the ERP creates a manufacturing order for the sales order", async () => {
    // The sales key user has no Manufacturing access: checked by data.
    // erp.productionForSale() does not return product_id, so the product is not checked here (helper gap).
    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => !!v);
    expect(mo, `ERP mrp.production with origin ${saleOrder}`).toBeDefined();
    expect(mo!.product_qty, "ERP mrp.production.product_qty").toBeCloseTo(quantity_t, 3);
    erpOrder = mo!.name;
    test.info().annotations.push({ type: "order", description: erpOrder });
  });

  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: saleOrder, exact: true }) });

  await test.step("In the MES, open the list of manufacturing orders", async () => {
    await page.goto(ENV.mesUrl);
    await expect(page.getByRole("columnheader", { name: "Sales order" })).toBeVisible();
  });

  await test.step("Find the order that arrives from the ERP for that sales order", async () => {
    // The MES list is server-rendered and the ERP interface is asynchronous: reload until the row shows up.
    await expect(async () => {
      await page.goto(ENV.mesUrl);
      await expect(row).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });
    await expect(row.getByRole("link", { name: erpOrder })).toBeVisible();
  });

  await test.step(`The MES order list shows the order for the sales order with customer "${customer}"`, async () => {
    await expect.soft(row.getByRole("cell", { name: customer, exact: true })).toBeVisible();
  });

  await test.step(`The order shows grade "${grade}"`, async () => {
    await expect.soft(row.getByRole("cell", { name: grade, exact: true })).toBeVisible();
  });

  await test.step(`The order shows a quantity of ${fmt(quantity_t, 3)} t`, async () => {
    // Column header is "Quantity (t)": the unit may live in the header, the number must read as en-US.
    await expect.soft(row.getByRole("cell", { name: new RegExp(`^${escapeRe(fmt(quantity_t, 3))}( t)?$`) })).toBeVisible();
  });

  await test.step('The order has status "Pending"', async () => {
    await expect.soft(row.getByRole("cell", { name: "Pending", exact: true })).toBeVisible();
  });

  await test.step("MES GET /api/orders/{ERP order}: customer, grade, quantity and status", async () => {
    const order = (await eventually(() => mes.orderByErpRef(erpOrder), (v) => !!v)) as any;
    expect(order, `MES order ${erpOrder}`).toBeDefined();
    expect.soft(order.customer, "MES customer").toBe(customer);
    expect.soft(order.grade, "MES grade").toBe(grade);
    expect.soft(order.qty_t, "MES qty_t").toBeCloseTo(quantity_t, 3);
    expect.soft(order.status, "MES status").toBe("pending");
  });
});
