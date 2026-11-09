// spec: specs/CP-007.md (case: catalog/cases/CP-007.yaml)
// seed: tests/e2e/seed.spec.ts
// Browser steps (ERP, MES) with Playwright; Level 2 desktop steps with tests/desktop/support/desktop.mjs.
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { loadCase, erp, mes, eventually, runTag, ENV } from "./support/index.ts";
// @ts-ignore: plain ESM module of the protected desktop support layer
import { desktop } from "../desktop/support/desktop.mjs";

const L2_TITLE = "Level 2 · Hot strip mill";

const fmt = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 3) });

// MES screens are server-rendered: reload until the expected state shows up (the ERP interface is asynchronous).
async function reloadUntil(page: Page, url: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(url);
    await check();
  }).toPass({ timeout: 90_000, intervals: [3_000] });
}

// Desktop calls are synchronous; poll a desktop condition until it holds.
async function until<T>(check: () => T, what: string, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The text that follows a label in the L2 window (label/value pairs come in tree order). */
const after = (texts: string[], label: string) => {
  const i = texts.indexOf(label);
  return i < 0 ? undefined : texts[i + 1];
};

async function mesCoil(id: number) {
  const r = await fetch(`${ENV.mesUrl}/api/coils/${id}`);
  return r.ok ? ((await r.json()) as { id: number; coil_no: string; quality: string; hold_motive: string | null }) : undefined;
}

test("CP-007 From the ERP sales order to confirmed production, with a coil held by its Level 2 measurement", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const c = loadCase("CP-007");
  const { customer, product, quantity_t } = c.data;
  const [stepSale, stepMes, stepMeasure, stepCoils, stepComplete] = (c as any).steps as string[];
  const grade = (product as string).match(/\bS\d{3}[A-Z0-9]*\b/)![0]; // "Hot-rolled coil S355J2" -> S355J2
  const run = runTag();
  const coils = (c.data.coils as any[]).map((k, i) => ({ ...k, coil: `C-${run}-${i + 1}` }));
  const target = coils[1]; // "coil 2"
  const meas = c.data.coil_2_measurement as { thickness_mm: number; width_mm: number; flatness_i: number };
  const HOLD_REASON = "Thickness out of tolerance"; // expected_results: reason the MES must give
  const WARNING = "Measurement out of tolerance"; // expected_results: L2 warning
  // Only released coils count: the measured coil 2 is held by the MES.
  const producedT = coils.filter((k) => k !== target).reduce((s, k) => s + k.weight_kg, 0) / 1000;
  testInfo.annotations.push({ type: "coils", description: coils.map((k) => k.coil).join(", ") });

  const d = desktop("java", testInfo.outputPath("desktop"));
  let shots = 0;
  const shot = async (label: string) => {
    d.screenshot(label);
    const name = `${String(++shots).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.png`;
    await testInfo.attach(`L2 · ${label}`, { path: join(testInfo.outputPath("desktop"), name), contentType: "image/png" });
  };

  let saleOrder = "";
  let erpOrder = "";
  let mesOrderUrl = "";
  let targetId = 0;

  await test.step("Log in to the ERP as the sales rep", async () => {
    const who = ENV.roles["sales rep"];
    await page.goto(`${ENV.erpUrl}/web/login?db=${ENV.erpDb}`);
    await page.getByRole("textbox", { name: /email|login/i }).fill(who.login);
    await page.getByRole("textbox", { name: /password/i }).fill(who.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForURL(/\/odoo/);
  });

  await test.step(stepSale, async () => {
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
    testInfo.annotations.push({ type: "sales order", description: saleOrder });

    const so = await erp.saleOrder(saleOrder);
    expect(so?.state, "ERP sales order state").toBe("sale");
    expect(so?.partner_id[1], "ERP sales order customer").toBe(customer);
    // The sales key user has no Manufacturing access: the manufacturing order is checked by data.
    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => !!v);
    expect(mo, `manufacturing order with origin ${saleOrder}`).toBeDefined();
    expect(mo!.product_qty, "manufacturing order quantity").toBeCloseTo(quantity_t, 3);
    erpOrder = mo!.name;
    testInfo.annotations.push({ type: "order", description: erpOrder });
  });

  await test.step(stepMes, async () => {
    // Expected: the order reaches the MES with the customer, grade and quantity.
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: saleOrder, exact: true }) });
    await reloadUntil(page, ENV.mesUrl, () => expect(row).toBeVisible({ timeout: 2_000 }));
    await expect(row.getByRole("cell", { name: customer, exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: grade, exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: fmt(quantity_t, 3), exact: true })).toBeVisible();
    const inbound = await mes.orderByErpRef(erpOrder);
    expect(inbound, "MES order").toMatchObject({ customer, grade, qty_t: quantity_t });

    await row.getByRole("link", { name: erpOrder }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Order ${erpOrder}`);
    mesOrderUrl = page.url();

    const table = page.getByRole("table", { name: "Coils" });
    for (const k of coils) {
      await page.getByRole("textbox", { name: "Coil no." }).fill(k.coil);
      await page.getByRole("textbox", { name: "Heat no." }).fill(k.heat);
      await page.getByRole("textbox", { name: "Weight (kg)" }).fill(String(k.weight_kg));
      await page.getByRole("textbox", { name: "Thickness (mm)" }).fill(String(k.thickness_mm));
      await page.getByRole("textbox", { name: "Width (mm)" }).fill(String(k.width_mm));
      await page.getByRole("combobox", { name: "Quality status" }).selectOption({ label: "Released" });
      await page.getByRole("button", { name: "Register coil" }).click();
      await expect(table.getByRole("row").filter({ has: page.getByRole("cell", { name: k.coil, exact: true }) })).toContainText("Released");
    }
    await expect(table.getByRole("row")).toHaveCount(coils.length + 1);

    const order = await mes.orderByErpRef(erpOrder);
    targetId = order!.coils.find((k: any) => k.coil_no === target.coil)?.id;
    expect(targetId, `MES id of ${target.coil}`).toBeTruthy();
  });

  // The client of a previous run may still be open: start from a fresh one.
  if (d.window(L2_TITLE)) d.close();
  try {
    await test.step(stepMeasure, async () => {
      d.launch(`l2-client ${ENV.mesUrl}`, L2_TITLE);
      d.click("switch", "Measurements");
      d.type("textfield", "Coil to measure", target.coil);
      d.click("button", "Load coil");
      await until(() => d.texts().some((t: string) => t.startsWith(`Order ${erpOrder} · ${grade} ·`)), `coil ${target.coil} loaded`);
      await shot("coil-2-loaded");
      d.type("textfield", "Measured thickness (mm)", String(meas.thickness_mm));
      d.type("textfield", "Measured width (mm)", String(meas.width_mm));
      d.type("textfield", "Measured flatness (I)", String(meas.flatness_i));
      d.click("button", "Register measurement");

      // Expected: Level 2 shows the warning "Measurement out of tolerance".
      await until(() => d.window(WARNING), `warning "${WARNING}"`);
      await shot("warning-out-of-tolerance");
      d.keys("", "Return"); // the modal owns keyboard focus: acknowledge with OK
      d.waitWindowGone(WARNING);
      expect(d.texts(), "L2 measurement result").toContain(`Out of tolerance · coil held: ${HOLD_REASON}`);
      await shot("measurement-registered");
    });

    await test.step(stepCoils, async () => {
      d.click("switch", "Coils");
      d.type("textfield", "Coil filter", target.coil);
      d.click("button", "Refresh");
      await until(() => d.texts().includes(target.coil), `coil ${target.coil} in the table`);
      d.selectOnlyRow("Coils");
      const texts: string[] = await until(() => {
        const t = d.texts();
        return t.includes(`Detail · coil ${target.coil}`) ? t : null;
      }, `detail of ${target.coil}`);
      await shot("coil-2-on-hold");
      // Expected: coil 2 goes to HOLD with reason "Thickness out of tolerance"...
      expect(texts[texts.indexOf(target.coil) + 6], "L2 coil status").toBe("HOLD");
      expect(after(texts, "Hold reason"), "L2 hold reason").toBe(HOLD_REASON);
      // ...without the operator pressing "Hold": the only quality event is the MES automatic hold.
      const h = texts.indexOf("Hold");
      expect(texts.slice(h, h + 3), "L2 quality history").toEqual(["Hold", HOLD_REASON, "MES"]);
      expect(texts[h + 3]).toMatch(/^Automatic hold from measurement/);
    });
  } finally {
    if (d.window(L2_TITLE)) d.close();
  }

  await test.step(`Data check: MES coil ${target.coil} is HOLD with reason "${HOLD_REASON}"`, async () => {
    const k = await mesCoil(targetId);
    expect(k?.quality, "MES coil quality").toBe("HOLD");
    expect(k?.hold_motive, "MES coil hold_motive").toBe(HOLD_REASON);
  });

  await test.step(stepComplete, async () => {
    await page.goto(mesOrderUrl);
    await page.getByRole("button", { name: "Complete order" }).click();
    await expect(page.getByRole("button", { name: "Complete order" })).toBeHidden();
    await reloadUntil(page, mesOrderUrl, () =>
      expect(page.getByRole("definition").filter({ hasText: "Confirmed in ERP" })).toBeVisible({ timeout: 2_000 }));
  });

  await test.step(`The MES shows produced "${fmt(producedT, 3)} t" (only the released coil counts)`, async () => {
    await expect(page.getByTestId("produced")).toHaveText(`${fmt(producedT, 3)} t`);
    const order = await eventually(() => mes.orderByErpRef(erpOrder), (v) => v?.status === "reported");
    expect(order?.status, "MES status").toBe("reported");
    expect(order?.produced_t, "MES produced_t").toBeCloseTo(producedT, 3);
  });

  await test.step(`In the ERP the manufacturing order is done with ${fmt(producedT)} t produced`, async () => {
    const mo = await eventually(() => erp.productionForSale(saleOrder), (v) => v?.state === "done");
    expect(mo?.state, "ERP mrp.production.state").toBe("done");
    expect(mo?.qty_produced, "ERP mrp.production.qty_produced").toBeCloseTo(producedT, 3);
  });
});
