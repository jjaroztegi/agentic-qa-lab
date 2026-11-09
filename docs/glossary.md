# Glossary

## Testing terms

| Term | Meaning |
|---|---|
| Business case | A process described by the business in `catalog/cases/`, with expected results and data checks. The reference for every test. |
| Key user | The person in the business who knows a process and writes or reviews its case. |
| Authoring | An agent turning a case into a deterministic test. |
| Deterministic test | A Playwright or desktop test that runs without any model and checks data in the systems. |
| Support layer | Shared helpers in `tests/*/support/` that read ERP and MES data. Protected. |
| Black box | A system the agent knows only through its screens and documented interfaces, without source code. |
| From scratch | An authoring run where the agent sees no existing tests or plans. |
| Triage | An agent classifying a failing test as test drift, application regression, environment or flaky. |
| Test drift | The application changed on purpose and still meets the case; the test needs new locators. |
| Heal | Repairing a test for drift. Checked by `tools/guard-heal.mjs`. |
| Isolated environment | An ERP copy, an MES and a desktop created for one run and destroyed after it. |
| Replay | A static page with a run's screen recording, stages and the agent's steps. |
| Finding | Something the agent reports instead of working around: a defect, a gap in the case, missing data. |
| Migration rehearsal | Moving the ERP to a new host, then running the business cases and a data comparison. |

## Plant terms

| Term | Meaning |
|---|---|
| ERP | Enterprise resource planning. Odoo 19 here, standing in for SAP: sales orders, manufacturing orders, maintenance. |
| MES | Manufacturing execution system. Receives manufacturing orders, records what the mill produces, confirms production to the ERP. |
| Level 2 (L2) | The process-control layer next to the mill. Here, a vendor's Java desktop client for coils, measurements and line stops. |
| Coil | A rolled steel strip wound into a roll; the unit the mill produces. |
| Heat | One batch of molten steel; every coil carries its heat number. |
| Slab | The semi-finished steel block that is rolled into a coil. |
| Grade | The steel specification, such as S275JR or S355J2. |
| Hold / release | Blocking a coil for quality reasons, and clearing it with a supervisor's authorization. |
| Stand | One set of rolls in the finishing mill, such as stand F3. |
