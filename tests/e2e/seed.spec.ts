// Seed for the Playwright Test Agents: the state every generated test starts from.
// ERP: logged in as the sales key user (not admin). MES: no login (plant network).
import { test } from "@playwright/test";
import { ENV } from "./support/index.ts";

test("seed", async ({ page }) => {
  await page.goto(`${ENV.erpUrl}/web/login?db=${ENV.erpDb}`);
  await page.getByRole("textbox", { name: /email|login/i }).fill(ENV.sales.login);
  await page.getByRole("textbox", { name: /password/i }).fill(ENV.sales.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/odoo/);
});
