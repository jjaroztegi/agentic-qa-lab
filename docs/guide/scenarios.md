# Scenarios

Each scenario is a story you can reproduce with `scenarios/run.sh <name>` (add `--local` to skip GitHub). There are three kinds:

| Kind | Trigger | Pipeline |
|---|---|---|
| Case | A new case in the catalog, opened as a PR with the `automate` label | Authoring: an agent writes and proves the test |
| Change | A code change opened as a PR | CI: every business case runs; on red, the triage agent classifies the failure |
| Regression | An event such as a vendor release or a migration rehearsal | Regression: the whole suite against a target, plus a data comparison |

Follow any of them in the control room at http://127.0.0.1:17000. The live view shows the run's screen and the agent's steps; the Overview lists every case with its time and cost.

## 01-business-intake

A key user describes a case in plain words on the n8n form: a customer orders a pickled coil with a committed delivery date, and the MES must receive that date. n8n drafts the case in the catalog template, marks what is missing as `PENDING` and opens a PR. Once a reviewer completes it and adds `automate`, the agent writes the test.

What to watch: the drafted YAML in the PR, the reviewer's edit, then the agent's report. In our runs the agent found a real defect: the MES stores the delivery date one day early for users ahead of UTC. The agent traced it to the date conversion, kept the business expectation, and left the test red with an explanation. A developer fixed the conversion, and the same test passed without changes. Because that fix is merged, the story now ends with a green test on the first run.

## 02-desktop-black-box

A thickness measurement out of tolerance must put a coil on hold automatically in the Level 2 client. The client is a vendor product: the agent has no source code and, with the `from-scratch` label, no existing tests to learn from. It learns the application through its accessibility tree, the same interface a screen reader uses.

What to watch: the desktop on the live view while the agent explores, then the test it writes with `agent-desktop`.

## 03-cross-system

One test takes an order from the ERP in the browser to a confirmed production, with a coil held because of its Level 2 measurement. The browser and the Java client share the same recorded screen.

What to watch: one test switching between three systems and checking data in each.

## 04-defect-blocked

A developer pushes a "performance" change to the MES that moves a sum into SQL. The new query also counts held coils as produced, and the unit tests do not cover that path. CI runs the business cases in an isolated environment, the order-to-coil case fails, and the triage agent classifies it as an application regression. The PR is blocked with an explanation written for the business.

What to watch: the triage verdict in the PR, and that the test was not touched.

## 05-screen-change

A developer renames labels on the MES coil form ("Register coil" becomes "Add coil"). The tests that use that form fail. The triage agent classifies the failure as test drift and repairs the locators, then `tools/guard-heal.mjs` checks that no assertion, expected value or step name changed. The repaired tests run again and pass, and the repair is pushed to the PR.

What to watch: the diff of the repair, which only touches how the test reaches the screen.

## 06-migration-rehearsal

A lift and shift of the ERP to a new host, with the slips a real rehearsal tends to have: quantity precision reset to two decimals and the procurement scheduler left off. The business cases run against the migrated ERP, and a data comparison between source and target reports the differences that were not expected.

What to watch: the comparison summary, which separates expected differences (the new host name) from the ones that need action.

## 07-parallel-cases

Four new cases at once: two on the Java client, one on the MES as a black box (`black_box: true`), and one across the MES and the ERP. The runner pool authors them in parallel, each in its own isolated environment and on its own screen.

What to watch: the Overview, with four runs moving at the same time.

## 08-from-scratch

The first day on an ERP module nobody prepared: a shift supervisor reports a breakdown on a mill stand, and it must reach maintenance as an urgent corrective request. No source, no prior tests, no helpers for that module.

What to watch: the agent learning an unfamiliar module, and the findings in its report, written as a careful new user would note them.
