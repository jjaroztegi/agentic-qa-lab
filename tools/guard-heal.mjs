#!/usr/bin/env node
// Deterministic guard for automated test repairs ("healing").
// An AI healer may fix HOW a test reaches the screen (locators, waits, navigation),
// never WHAT the business expects. Exit 1 with reasons if the working-tree diff breaks that.
//
//   node tools/guard-heal.mjs [base]      (default: diff of the working tree against HEAD)
import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "HEAD";
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
const files = git("diff", "--name-only", base).split("\n").filter(Boolean);
const reasons = [];

for (const f of files) {
  if (!/^tests\/e2e\/[^/]+\.spec\.ts$/.test(f) || f.endsWith("seed.spec.ts")) {
    reasons.push(`${f}: outside what a healer may touch (only tests/e2e/*.spec.ts)`);
    continue;
  }
  const diff = git("diff", "-U0", base, "--", f).split("\n");
  const removed = diff.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  const added = diff.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const count = (ls, re) => ls.filter((l) => re.test(l)).length;

  if (count(added, /\bexpect\s*\(/) < count(removed, /\bexpect\s*\(/))
    reasons.push(`${f}: removes assertions (expect)`);
  if (count(added, /test\.(fixme|skip|only)\b|\.fixme\(|\.skip\(/))
    reasons.push(`${f}: disables or isolates tests (fixme/skip/only)`);
  // Lines that state business expectations or validate by data must survive unchanged.
  const business = /\b(c\.data|loadCase|erp\.|mes\.|eventually|produced|qty_produced|toBeCloseTo|toEqual\(\s*[\d.]+)/;
  for (const l of removed.filter((l) => business.test(l)))
    if (!added.includes(l)) reasons.push(`${f}: changes a business check: ${l.trim().slice(0, 120)}`);
  // Numeric literals inside assertions may not change.
  const nums = (ls) => ls.filter((l) => /expect/.test(l)).flatMap((l) => l.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []).sort().join(",");
  if (nums(removed) !== nums(added)) reasons.push(`${f}: changes numeric values in assertions`);
}

if (reasons.length) {
  console.error("guard-heal: REJECTED\n- " + reasons.join("\n- "));
  process.exit(1);
}
console.log(`guard-heal: OK (${files.length} file(s), locator/wait changes only)`);
