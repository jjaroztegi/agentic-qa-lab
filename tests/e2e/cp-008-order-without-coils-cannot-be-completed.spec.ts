// spec: specs/CP-008.md (case: catalog/cases/CP-008.yaml)
// seed: tests/e2e/seed.spec.ts
import { test, expect } from "@playwright/test";
import { loadCase, erp, mes, eventually, ENV } from "./support/index.ts";

// ERP JSON-RPC as a key user (the support layer's erp helpers are read-only and run as admin).
async function erpAs(role: string) {
  const { login, password } = ENV.roles[role];
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
  const uid = await rpc("common", "login", [ENV.erpDb, login, password]);
  if (!uid) throw new Error(`ERP login rejected for ${login}`);
  return (model: string, method: string, args: unknown[], kwargs: object = {}) =>
    rpc("object", "execute_kw", [ENV.erpDb, uid, password, model, method, args, kwargs]);
}

test("CP-008 An order without coils cannot be completed or reported to the ERP", async ({ page }) => {
  const c = loadCase("CP-008");

  let saleOrder = "";
  let erpOrder = "";

  await test.step("Precondition: the MES has an order just arrived from the ERP, without coils", async () => {
    // The case has no data: repeat the most recent sales order of the ERP (customer, product, quantity),
    // created and confirmed by the sales rep through the ERP's documented API.
    const kw = await erpAs("sales rep");
    const [last] = await kw("sale.order", "search_read", [[["state", "=", "sale"]]],
      { fields: ["partner_id", "order_line"], order: "id desc", limit: 1 });
    expect(last, "a confirmed sales order in the ERP to repeat (case CP-008 has no data)").toBeDefined();
    const [line] = await kw("sale.order.line", "read", [[last.order_line[0]]], { fields: ["product_id", "product_uom_qty"] });
    const id = await kw("sale.order", "create", [{
      partner_id: last.partner_id[0],
      order_line: [[0, 0, { product_id: line.product_id[0], product_uom_qty: line.product_uom_qty }]],
    }]);
    await kw("sale.order", "action_confirm", [[id]]);
    const [so] = await kw("sale.order", "read", [[id]], { fields: ["name", "state"] });
    expect(so.state, "ERP sale.order.state").toBe("sale");
    saleOrder = so.name;
    test.info().annotations.push(
      { type: "sales order", description: `${saleOrder} · ${last.partner_id[1]} · ${line.product_id[1]} · ${line.product_uom_qty}` });

    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => !!v);
    expect(mo, `ERP mrp.production with origin ${saleOrder}`).toBeDefined();
    expect(mo!.state, "ERP mrp.production.state").toBe("confirmed");
    erpOrder = mo!.name;
    test.info().annotations.push({ type: "order", description: erpOrder });

    const order = await eventually(() => mes.orderByErpRef(erpOrder), (v) => !!v, 90_000);
    expect(order, `MES order ${erpOrder}`).toBeDefined();
    expect(order!.coils, "MES coils of the order").toHaveLength(0);
  });

  await test.step("Open the order in the MES", async () => {
    await page.goto(ENV.mesUrl);
    const orders = page.getByRole("table", { name: "Manufacturing orders" });
    const row = orders.getByRole("row").filter({ has: page.getByRole("cell", { name: saleOrder, exact: true }) });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: erpOrder }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Order ${erpOrder}`);
    await expect(page.getByRole("table", { name: "Coils" })).toContainText("No coils registered.");
  });

  await test.step(c.expected_results[0], async () => {
    await expect(page.getByRole("button", { name: "Complete order" })).toBeDisabled();
  });

  await test.step(c.data_validation[0], async () => {
    const order = await mes.orderByErpRef(erpOrder);
    expect(order?.status, "MES status").not.toMatch(/^(completed|reported)$/);
    expect(order?.coils, "MES coils of the order").toHaveLength(0);
  });

  await test.step(c.data_validation[1], async () => {
    const mo = await erp.productionForSale(saleOrder);
    expect(mo?.name, "ERP mrp.production of the order").toBe(erpOrder);
    expect(mo?.state, "ERP mrp.production.state").toBe("confirmed");
  });
});
