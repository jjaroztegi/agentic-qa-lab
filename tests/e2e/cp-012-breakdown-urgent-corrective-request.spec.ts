// spec: specs/CP-012.md
// seed: tests/e2e/seed.spec.ts
import { test, expect } from "@playwright/test";
import { loadCase, eventually, ENV } from "./support/index.ts";

// Expected values stated by the case (expected_results / data_validation).
const NEW_STAGE = "New Request";
const MAINTENANCE_TEAM = "Rolling mill maintenance";

// Read-only JSON-RPC on the ERP's documented API (no support helper covers maintenance.request).
async function erpRead(model: string, domain: unknown[], kwargs: object) {
  const call = async (service: string, method: string, args: unknown[]) => {
    const r = await fetch(`${ENV.erpUrl}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
    });
    const body: any = await r.json();
    if (body.error) throw new Error(body.error.data?.message ?? body.error.message);
    return body.result;
  };
  const uid = await call("common", "login", [ENV.erpDb, ENV.admin.login, ENV.admin.password]);
  return call("object", "execute_kw", [ENV.erpDb, uid, ENV.admin.password, model, "search_read", [domain], kwargs]);
}

test("CP-012 A mill breakdown reported by the shift supervisor reaches maintenance as an urgent corrective request", async ({ page }) => {
  const c = loadCase("CP-012");
  const { role, equipment, subject, type } = c.data as Record<string, string>;
  const priority = String(c.data.priority).match(/(\d) stars?/)![1]; // "highest (3 stars)" -> "3"
  const steps = (c as unknown as { steps: string[] }).steps;
  const account = ENV.roles[role];
  const [user] = await erpRead("res.users", [["login", "=", account.login]], { fields: ["name"] });

  // Requests that already exist with this subject (earlier runs); ours is the one created after them.
  const before = await erpRead("maintenance.request", [["name", "=", subject]], { fields: ["id"], order: "id desc", limit: 1 });
  const lastId: number = before[0]?.id ?? 0;

  await test.step(`Log into the ERP as the ${role}`, async () => {
    await page.goto(`${ENV.erpUrl}/web/session/logout`);
    await page.goto(`${ENV.erpUrl}/web/login?db=${ENV.erpDb}`);
    await page.getByRole("textbox", { name: /email|login/i }).fill(account.login);
    await page.getByRole("textbox", { name: /password/i }).fill(account.password);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page.getByTitle("Home Menu")).toBeVisible();
  });

  await test.step(steps[0], async () => {
    await page.getByTitle("Home Menu").click();
    await page.getByRole("menuitem", { name: "Maintenance" }).click();
    await page.getByRole("button", { name: "Maintenance" }).click();
    await page.getByRole("menuitem", { name: "Maintenance Requests" }).click();
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("textbox", { name: "Request" }).fill(subject);
    await page.getByRole("combobox", { name: "Equipment" }).fill(equipment.split(" · ")[0]);
    await page.getByRole("option", { name: equipment }).click();
    // The team comes from the equipment: the supervisor does not choose it.
    await expect(page.getByRole("combobox", { name: "Team" })).toHaveValue(MAINTENANCE_TEAM);
  });

  await test.step(steps[1], async () => {
    await page.getByRole("radio", { name: type }).click();
    await page.getByRole("radio", { name: "High" }).click(); // 3rd star = highest priority
    const save = page.getByRole("button", { name: "Save manually" });
    if (await save.isVisible()) await save.click();
    await expect(save).toBeHidden();
  });

  await test.step("The request is in the stage \"New Request\", assigned to the rolling mill team, requested by the shift supervisor", async () => {
    await expect(page.getByRole("radio", { name: NEW_STAGE })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Team" })).toHaveValue(MAINTENANCE_TEAM);
    await expect(page.getByRole("radio", { name: type })).toBeChecked();
    await expect(page.getByRole("radio", { name: "High" })).toBeChecked();
    // The form has no requester field; the creation notice in the chatter names who created it.
    await expect(page.getByRole("group", { name: "System notification" }).getByText(user.name)).toBeVisible();
  });

  await test.step("Data validation: ERP maintenance.request", async () => {
    const fetchReq = async () =>
      (await erpRead("maintenance.request", [["name", "=", subject], ["id", ">", lastId]], {
        fields: ["maintenance_type", "priority", "stage_id", "maintenance_team_id", "owner_user_id", "equipment_id"],
        order: "id desc",
      })) as any[];
    const reqs = await eventually(fetchReq, (r) => r.length > 0, 15_000);
    expect(reqs, "exactly one request created by this run").toHaveLength(1);
    const r = reqs[0];
    expect(r.maintenance_type).toBe(type.toLowerCase());
    expect(r.priority).toBe(priority);
    expect(r.stage_id?.[1]).toBe(NEW_STAGE);
    expect(r.maintenance_team_id?.[1]).toBe(MAINTENANCE_TEAM);
    expect(r.owner_user_id?.[0]).toBe(user.id);
    const [eq] = await erpRead("maintenance.equipment", [["name", "=", equipment]], { fields: ["id"] });
    expect(r.equipment_id?.[0]).toBe(eq.id); // display name carries the serial ("…/FM-F3")
  });
});
