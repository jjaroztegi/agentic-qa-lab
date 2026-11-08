#!/usr/bin/env node
// Self-test for guard-heal.mjs: a locator-only repair passes; weakening the test is rejected.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const guard = resolve(import.meta.dirname, "guard-heal.mjs");
const spec = `test("CP-001", async ({ page }) => {
  const c = loadCase("CP-001");
  await page.getByRole("button", { name: "Register coil" }).click();
  const o = await eventually(() => mes.orderByErpRef(ref), (o) => o?.status === "reported");
  expect(o.produced_t).toBe(47.75);
});
`;
function scenario(name, edit, file = "tests/e2e/cp-001.spec.ts") {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  mkdirSync(join(dir, "tests/e2e/support"), { recursive: true });
  writeFileSync(join(dir, "tests/e2e/cp-001.spec.ts"), spec);
  writeFileSync(join(dir, "tests/e2e/support/index.ts"), "export const x = 1;\n");
  g("add", "-A"); g("commit", "-qm", "base");
  writeFileSync(join(dir, file), edit(file.endsWith("index.ts") ? "export const x = 1;\n" : spec));
  const r = spawnSync("node", [guard], { cwd: dir, encoding: "utf8" });
  return { name, ok: r.status === 0, out: r.stdout + r.stderr };
}

const cases = [
  [scenario("locator rename", (s) => s.replace('"Register coil"', '"Add coil"')), true],
  [scenario("expected value changed", (s) => s.replace("47.75", "52.75")), false],
  [scenario("assertion removed", (s) => s.replace(/\s*expect\(o\.produced_t\).*\n/, "\n")), false],
  [scenario("test disabled", (s) => s.replace('test("CP-001"', 'test.fixme("CP-001"')), false],
  [scenario("data check weakened", (s) => s.replace('o?.status === "reported"', "true")), false],
  [scenario("support edited", () => "export const x = 2;\n", "tests/e2e/support/index.ts"), false],
];
for (const [r, expected] of cases) {
  assert.equal(r.ok, expected, `${r.name}: expected ${expected ? "OK" : "REJECT"}\n${r.out}`);
  console.log(`ok - ${r.name} -> ${r.ok ? "OK" : "rejected"}`);
}
