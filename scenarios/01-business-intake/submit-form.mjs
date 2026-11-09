// Fills the n8n intake form as a key user would and prints the PR it opened.
//   node scenarios/01-business-intake/submit-form.mjs <form.json>   (N8N_URL, default http://127.0.0.1:15678)
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const answers = JSON.parse(readFileSync(process.argv[2], "utf8"));
const N8N = process.env.N8N_URL ?? "http://127.0.0.1:15678";
const out = "evidence/scenarios/intake";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, locale: "en-US" });
await page.goto(`${N8N}/form/case-intake`);
for (const [label, value] of Object.entries(answers)) {
  const field = page.getByLabel(label, { exact: true });
  if ((await field.evaluate((el) => el.tagName)) === "SELECT") await field.selectOption(value);
  else await field.fill(value);
}
await page.screenshot({ path: `${out}/1-form.png`, fullPage: true });
await page.getByRole("button", { name: /submit/i }).click();
const done = page.getByText(/Proposal opened: https:\/\/github\.com\/\S+\/pull\/\d+/);
await done.waitFor({ timeout: 120_000 });
await page.screenshot({ path: `${out}/2-confirmation.png`, fullPage: true });
console.log((await done.textContent()).match(/https:\/\/\S+\/pull\/\d+/)[0]);
await browser.close();
