// spec: specs/CP-005.md (case: catalog/cases/CP-005.yaml)
// seed: tests/e2e/seed.spec.ts
import { test, expect } from "@playwright/test";
import { loadCase, erp, eventually, ENV } from "./support/index.ts";

const fmt = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 3) });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// erp.saleOrder() does not return commitment_date (helper gap), so the date is read through the
// same documented JSON-RPC interface the support layer uses.
async function erpRead(model: string, domain: unknown[], fields: string[]) {
  const rpc = async (service: string, method: string, args: unknown[]) => {
    const r = await fetch(`${ENV.erpUrl}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
    });
    const body: any = await r.json();
    if (body.error) throw new Error(body.error.data?.message ?? body.error.message);
    return body.result;
  };
  const uid = await rpc("common", "login", [ENV.erpDb, ENV.admin.login, ENV.admin.password]);
  return rpc("object", "execute_kw", [ENV.erpDb, uid, ENV.admin.password, model, "search_read", [domain], { fields }]);
}

// Odoo stores datetimes in UTC; the business date is the one the user sees in their own time zone.
const dateInTz = (utc: string, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(utc.replace(" ", "T") + "Z"));

type MesOrder = { erp_ref: string; sale_ref: string | null; customer: string; grade: string; qty_t: number; due_date: string | null; status: string };
async function mesOrderForSale(saleRef: string) {
  const r = await fetch(`${ENV.mesUrl}/api/orders`);
  const orders = (await r.json()) as MesOrder[];
  return orders.find((o) => o.sale_ref === saleRef);
}

test("CP-005 A sales order with a committed delivery date reaches the MES with that date", async ({ page }) => {
  const c = loadCase("CP-005");
  const { customer, product, grade, quantity_t, committed_delivery_date } = c.data as {
    customer: string; product: string; grade: string; quantity_t: number; committed_delivery_date: string;
  };
  const [yyyy, mm, dd] = committed_delivery_date.split("-");
  const typedDate = `${mm}/${dd}/${yyyy}`; // the sales rep's ERP date format (en-US)
  const salesRep = ENV.roles["sales rep"];

  let saleOrder = "";
  let confirmedAt = 0;

  await test.step("Log in to the ERP as the sales rep", async () => {
    await page.goto(`${ENV.erpUrl}/web/login?db=${ENV.erpDb}`);
    await page.getByRole("textbox", { name: /email|login/i }).fill(salesRep.login);
    await page.getByRole("textbox", { name: /password/i }).fill(salesRep.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForURL(/\/odoo/);
  });

  await test.step("In the ERP, as the sales rep, create a quotation for the customer with the product and quantity, and set the committed delivery date", async () => {
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
    await page.getByRole("tab", { name: "Other Info" }).click();
    const deliveryDate = page.getByRole("textbox", { name: "Delivery Date" });
    await deliveryDate.fill(typedDate);
    await page.keyboard.press("Enter");
    // Datetime field: the ERP completes the typed date with midnight ("12/15/2026 12:00:00 AM").
    await expect(deliveryDate).toHaveValue(new RegExp(`^${escapeRe(typedDate)}\\b`));
  });

  await test.step("Confirm the sales order in the ERP", async () => {
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("radio", { name: "Sales Order" })).toBeChecked();
    confirmedAt = Date.now();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/^S\d+$/);
    saleOrder = (await heading.innerText()).trim();
    test.info().annotations.push({ type: "sales order", description: saleOrder });

    const so = await erp.saleOrder(saleOrder);
    expect(so?.state, "ERP sale.order.state").toBe("sale");
    expect(so?.partner_id[1], "ERP sale.order customer").toBe(customer);

    const [rec] = await erpRead("sale.order", [["name", "=", saleOrder]], ["commitment_date"]);
    const [user] = await erpRead("res.users", [["login", "=", salesRep.login]], ["tz"]);
    expect(rec?.commitment_date, "ERP sale.order.commitment_date is set").toBeTruthy();
    test.info().annotations.push({ type: "ERP commitment_date (UTC)", description: String(rec.commitment_date) });
    expect(dateInTz(rec.commitment_date, user.tz || "UTC"), `ERP sale.order.commitment_date (in ${user.tz || "UTC"})`)
      .toBe(committed_delivery_date);
  });

  await test.step("The ERP creates the manufacturing order and the MES picks it up automatically (interface every 10 s); nobody acts in between", async () => {
    const order = await eventually(() => mesOrderForSale(saleOrder), (v) => !!v, 60_000);
    const seconds = Math.round((Date.now() - confirmedAt) / 1000);
    test.info().annotations.push({ type: "MES pick-up time", description: `${seconds} s` });
    expect(order, `MES order with sale_ref ${saleOrder} within 1 minute of confirmation`).toBeDefined();
    test.info().annotations.push({ type: "MES order", description: order!.erp_ref });
  });

  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: saleOrder, exact: true }) });

  await test.step("In the MES, open the list of manufacturing orders", async () => {
    await page.goto(ENV.mesUrl);
    await expect(page.getByRole("table", { name: "Manufacturing orders" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Due date" })).toBeVisible();
  });

  await test.step("Find the order that corresponds to the sales order", async () => {
    await expect(row).toBeVisible();
  });

  await test.step(`The MES list shows an order for the sales order with customer ${customer}`, async () => {
    await expect.soft(row.getByRole("cell", { name: customer, exact: true })).toBeVisible();
  });

  await test.step(`That MES order shows grade ${grade}`, async () => {
    await expect.soft(row.getByRole("cell", { name: grade, exact: true })).toBeVisible();
  });

  await test.step(`That MES order shows quantity ${fmt(quantity_t)} t`, async () => {
    await expect.soft(row.getByRole("cell", { name: new RegExp(`^${escapeRe(fmt(quantity_t, 3))}( t)?$`) })).toBeVisible();
  });

  await test.step(`That MES order shows due date ${committed_delivery_date}, equal to the committed delivery date in the ERP`, async () => {
    await expect.soft(row.getByRole("cell", { name: committed_delivery_date, exact: true })).toBeVisible();
  });

  await test.step(`MES GET /api/orders (order whose sale_ref is ${saleOrder}): customer, grade, qty_t, due_date`, async () => {
    const order = await mesOrderForSale(saleOrder);
    expect(order, `MES order with sale_ref ${saleOrder}`).toBeDefined();
    expect.soft(order!.customer, "MES customer").toBe(customer);
    expect.soft(order!.grade, "MES grade").toBe(grade);
    expect.soft(order!.qty_t, "MES qty_t").toBeCloseTo(quantity_t, 3);
    expect.soft(order!.due_date, "MES due_date").toBe(committed_delivery_date);
  });
});
