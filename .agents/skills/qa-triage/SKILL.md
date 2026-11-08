---
name: qa-triage
description: Classify failing end-to-end tests after a change (test drift vs. application regression vs. environment), with evidence, and repair only test drift. Use in CI after `playwright test` fails, or when asked why the e2e suite is red.
---

# qa-triage: why is it red, and who has to act

Input: the failed run in `evidence/` (`results.json`, `test-results/*/trace.zip`, `error-context.md`, screenshots) and the change under test (`git diff origin/main...HEAD`, unless told another base).

## Classify each failed test

| category | meaning | who acts |
|---|---|---|
| `test_drift` | The application changed on purpose (label, layout, flow) and still meets the business case; the test's locators or steps are stale. | The agent repairs the test. |
| `app_regression` | The application no longer meets the case's `expected_results` / `data_validation`. | The developer. The agent does not touch the test. |
| `environment` | Infrastructure: service down, interface not reachable, data missing, timeout before the app answered. | Platform team. |
| `flaky` | Passes on rerun with no change; timing. | QA platform: fix the wait. |

How to decide:
1. Read the error and `error-context.md`, and the screenshot. Open `trace.zip` (unzip with Bash) only if those are not enough; `npx playwright show-trace` does not work headless.
2. Read the diff. A diff that only renames or moves UI elements points to `test_drift`. A diff in business logic (`apps/*/src/domain.ts`, connectors, calculations) next to a failing data assertion points to `app_regression`.
3. The business truth is the case in `catalog/cases/<ID>.yaml`, never the current test code and never the current app behavior. A failing data assertion (ERP or MES values) is `app_regression` unless the diff shows the business rule was changed on purpose **and** the case was updated in the same change.
4. When unsure between drift and regression, choose `app_regression`. A false alarm costs a look; a hidden regression costs a line stop.

## Repair (only `test_drift`)

Delegate to the `playwright-test-healer` subagent, scoped to the failing spec file. Tell it: change locators, waits and navigation only; do not change assertions, expected values, `test.step` names, data helpers or imports; never use `test.fixme`/`test.skip`. Then run `node tools/guard-heal.mjs`. If the guard rejects the change, revert it with `git checkout -- tests/e2e` and reclassify as `app_regression`.

## Output

People in the business follow your work live in the control room: write your messages and every text field of triage.json in plain English. End with exactly one JSON object (no prose after it), also written to `evidence/triage.json`:

```json
{
  "verdict": "pass_after_heal | blocked_regression | blocked_environment | flaky",
  "failures": [
    {
      "test": "CP-001 …",
      "case": "CP-001",
      "category": "test_drift | app_regression | environment | flaky",
      "confidence": 0.0,
      "evidence": ["error line", "diff hunk file:line", "screenshot path"],
      "business_explanation": "One or two sentences for the key user: which process fails and what the impact would be.",
      "action": "healed: <what changed> | issue: <title> | retry"
    }
  ]
}
```

Never edit application code, `catalog/`, `policy/` or `tests/e2e/support/`.
