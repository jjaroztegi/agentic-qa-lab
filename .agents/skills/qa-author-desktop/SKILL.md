---
name: qa-author-desktop
description: Turn a catalog case that runs on a desktop application (Java Swing client of a vendor Level 2 system) into a deterministic desktop test under tests/desktop/, exploring the live app through agent-desktop (OS accessibility tree). Use when a case in catalog/cases lists a desktop system.
---

# qa-author-desktop: business case → deterministic desktop test

Input: a case id. Output: `tests/desktop/<id-lowercase>-<slug>.test.mjs` (node:test) that passes 3 runs in a row.

## Explore first

Each run has its own desktop (X display + accessibility bus), reached through `tools/l2` (it uses `DESKTOP_EXEC` from the isolated environment; people may be watching that screen live):

```bash
tools/l2 launch                          # start the L2 client against $MES_URL
tools/l2 list-windows
tools/l2 snapshot --app java -i          # accessibility tree with refs
tools/l2 click @e12 · tools/l2 type @e7 "text" · tools/l2 keys type "text"   # keys = xdotool, for modal dialogs
```

Read `tools/l2 skills get desktop` once if you need the command reference. Walk through every step of the case live before writing anything; take a fresh snapshot after each action.

## Write the test

- Use only `tests/desktop/support/desktop.mjs` (`desktop(app, evidenceDir)`): `launch`, `click(role, name)`, `type(role, name, text)`, `selectOnlyRow(table)`, `keys(text)`, `texts()`, `window(title)`, `waitWindowGone`, `screenshot(label)`, `record()`, `close()`. Read it first: its header lists the toolkit limits it works around. Find elements by role + accessible name; never use refs from your exploration, never coordinates.
- Use `node:test` + `node:assert/strict`. Load the case with `yaml` from `catalog/cases/<ID>.yaml`; business values come from its `data`.
- Set up preconditions by API (the MES API at `MES_URL`): create what the case needs with unique ids, then drive the desktop for the steps under test.
- One `t.test("<step text from the case>")` per business step, a `screenshot()` after each, `record()` around the whole test, evidence in `evidence/desktop/<ID>/`.
- Validate by data at the end (MES API), plus what the case says the screen shows.

## Rules

Same as qa-author: never edit `support/`, `catalog/` or `policy/`. If the app does not do what the case says, keep the assertion and report the discrepancy. If a helper you need is missing, say so instead of working around the support layer.

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
