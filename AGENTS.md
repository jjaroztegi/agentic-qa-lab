# Agentic QA lab

A working lab where AI agents turn business test cases into deterministic end-to-end tests, repair tests when screens change, and triage failures. The systems under test stand in for a plant landscape: an ERP (Odoo 19 in place of SAP), an in-house MES (`apps/mes`) and a vendor's Java desktop client (`apps/l2-desktop`). Read [README.md](README.md) for the story and [docs/README.md](docs/README.md) for the details.

This file is for coding agents changing the repository. The agents that author and triage tests at runtime follow `.agents/skills/` instead.

## Words we use

- **case**: a business case in `catalog/cases/CP-NNN.yaml`, written by the business. The source of truth for every test.
- **support layer**: `tests/e2e/support/` and `tests/desktop/support/`, the helpers tests use to read and check ERP and MES data.
- **run**: one pipeline execution (authoring, CI or regression), with its own isolated environment and control room entry.
- **isolated environment**: ERP database copy, MES container and desktop container for one run (`tools/e2e-env.sh`).
- **black box**: a system the agent may only use through screens and documented interfaces.

More in [docs/glossary.md](docs/glossary.md).

## Rules

1. **Business expectations are not yours to change.** `catalog/`, the support layers, `policy/`, `tools/agent.sh`, `tools/guard-heal.mjs`, `.agents/` and `.claude/` change only when a person asks for that change. Never make a test pass by editing what it expects.
2. **Never kill by pattern.** No `pkill -f`, `killall` or `kill $(pgrep ...)`. Other runs, runners and the lab share this host. Stop containers by exact name and processes by the PID you started.
3. **Leave the shared lab alone.** `docker compose down -v` deletes the seeded ERP, n8n and control room data. Use `tools/e2e-env.sh up <run>` for anything that writes data, and `down` when done.
4. **No secrets in files.** Keys come from environment variables. Nothing that prints a token goes into logs, events or evidence.
5. **English everywhere,** in code, UI text, data and docs.

## Keep these in sync

A change in one place usually needs the others:

- **UI text** in the MES or the Level 2 client is used by tests, by cases in `catalog/` and `scenarios/`, and by the skills.
- **The case schema** is read by `tools/pipeline/author.sh`, the control room (`apps/control-room/src/catalog.ts`), `n8n/build.py` and the skills.
- **The event contract** (`apps/control-room/src/shared/contract.ts`) is used by `tools/emit.mjs`, the pipeline scripts and n8n.
- **Scenario patches** (`scenarios/04-*`, `05-*`) apply to exact lines of `apps/mes`. Changing those lines means updating the scenario.

## Check your work

```bash
npm test                 # unit tests: MES, control room, tools
npm run check            # shell syntax, Node syntax, typechecks
npx playwright test      # business cases against a running lab (lab/up.sh)
```

For a change to the systems under test, run the affected business cases in an isolated environment (`tools/pipeline/ci.sh` does this end to end). For UI changes, include screenshots at desktop and phone widths in the PR.

## Documentation

- `README.md` is the front page: what, why, how, limits. Keep it short.
- `docs/guide/` explains how to use the lab, `docs/internals/` records design decisions and constraints the code does not show, `docs/operations/` holds runbooks.
- Update docs that a change makes wrong. Do not document what the code already says.
- Write plainly for engineers in large, careful organizations: concrete claims, no hype.

## Commits and pull requests

- Conventional commit titles (`feat(mes): ...`, `fix(ci): ...`), impersonal tone, squash merge.
- PR description: the problem, what changed, and how it was verified ([template](.github/pull_request_template.md)). UI changes include before and after screenshots.
