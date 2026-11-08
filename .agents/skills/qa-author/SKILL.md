---
name: qa-author
description: Turn a business test case from catalog/cases/<ID>.yaml into a deterministic, data-validated Playwright test under tests/e2e/, exploring the live apps with the Playwright Test Agents. Use when asked to automate, author or generate the test for a catalog case.
---

# qa-author: business case → deterministic test

Input: a case id (e.g. `CP-001`). Output: `tests/e2e/<id-lowercase>-<slug>.spec.ts` that passes 3 runs in a row, plus `specs/<ID>.md` (the plan).

The agent explores and writes; the test it leaves behind runs without any model. The verdict comes from data checks, not from the agent's opinion.

## Steps

1. Read `catalog/cases/<ID>.yaml`, `tests/e2e/support/index.ts` and `tests/e2e/seed.spec.ts`. The URLs are in `ENV` (ERP and MES).
2. Write the plan `specs/<ID>.md` in the Playwright planner format: one `### 1. <title>` section, `**Seed:** tests/e2e/seed.spec.ts`, and one scenario `#### 1.1 <ID> <title>` whose numbered steps and expectations come from `steps` and `expected_results`. Make the data concrete (customer, product, quantities, coils). Coil numbers must be unique per run: write them as `C-<RUN>-1`, `C-<RUN>-2`… and use any placeholder value while exploring.
3. Hand the scenario to the `playwright-test-generator` subagent with the plan text, the seed file and the target file name. It drives the real apps and writes the first version of the test.
4. Rewrite that test so it is maintainable and honest. Keep the generator's locators (role/label based). Then:
   - `import { loadCase, erp, mes, eventually, runTag, ENV } from "./support/index.ts"` and call `const c = loadCase("<ID>")` first.
   - Take every business value (customer, product, quantity, coil data, expected tonnes) from `c.data`, never as literals. Compute expected tonnes from the coils (sum of released coils / 1000) when the case implies it.
   - Use `runTag()` for unique coil numbers.
   - Add every check in `data_validation` with the `erp` / `mes` helpers, wrapped in `eventually(...)` for asynchronous interfaces, plus the on-screen checks in `expected_results`.
   - Wrap each business step in `await test.step("<step text from the case>", ...)` so the evidence report reads like the case.
   - Title: `"<ID> <title>"`. No `waitForTimeout`, no `networkidle`, no CSS/XPath selectors when a role or label works.
5. Run `npx playwright test <file> --reporter=line` three times. All three must pass. If one fails, fix the cause (wait for the right condition, better locator) and start the count again.
6. End with the report (see "Report").

## Cases that also run on the L2 desktop client

When `systems` lists L2 next to ERP/MES, write ONE Playwright test for the whole business flow: browser steps with Playwright, desktop steps with `tests/desktop/support/desktop.mjs` (`import { desktop } from "../desktop/support/desktop.mjs"`; read its header first). Explore the desktop part live through `tools/l2` (see `.agents/skills/qa-author-desktop/SKILL.md`, "Explore first"), find elements by role + accessible name, and start the client with `d.launch(\`l2-client ${ENV.mesUrl}\`, <window title>)`. Each desktop step is still a `test.step` with the case's wording and a `d.screenshot()`; attach the desktop screenshots to the report with `testInfo.attach`.

## Rules

- Never edit `tests/e2e/support/`, `catalog/`, `policy/`, `playwright.config.ts` or other tests. If a helper is missing, say so in your report.
- If the application does not do what `expected_results` says, do **not** adapt the expectation. Keep the assertion as the case states it and report the discrepancy as a possible defect, with what you observed.
- The ERP is a commercial product: drive it like a key user through its screens, never through URLs with record ids.

## Getting data in and out

Use `tools/api` for every call to a system's documented interface, while exploring and to check data (`tools/api mes GET /api/coils`, `tools/api mes POST /api/orders '<json>'`, `tools/api erp res.partner search_read '[[...]]' '{"fields":[...]}'`). It reaches only this run's ERP and MES. Tests create the transactional data they need (orders, coils, requests) through the same interfaces (in code: `fetch` to `ENV.mesUrl`, the `erp` helpers or JSON-RPC). Log into the ERP with the account of the role the case names (`ENV.roles["shift supervisor"]`, `ENV.roles["sales rep"]`).

Master data is different. If a customer, product or equipment the case assumes is missing, do not create it: stop and report it. Master data belongs to the business.

## What you can know about each system

Read `policy/agent-access.yaml` and the case's `systems`. A system with `source: null` is a **black box**: learn it the way a new key user would, through its screens (Playwright for web, `tools/l2` for the desktop client) and its documented interfaces (the ERP API used by the support layer, the MES REST API). Its code is not in your workspace; do not look for it elsewhere. The workspace is sealed and reads outside it are denied.

- If the case cannot be automated without something only the code would tell you, stop and say so under **Findings**. Missing documentation or poor testability is a finding; do not guess.
- For a system with a `source` path (the in-house MES), you may read its source to understand its behavior. The test still drives it through its screens and APIs and never imports its code.
- If the case has `black_box: true`, every system is a black box, in-house ones included.

## Report

People in the business follow your work live in the control room: write your messages in plain English. End with this report, short, no tables:

**What was done**: one or two sentences, the test file and what it covers.
**Verification**: the runs and their results (e.g. "3 of 3 passed").
**Findings**: discrepancies with the case or the application, or "None".
