# Getting started

## Requirements

- Docker with Compose v2 (Docker Desktop, Colima or Docker Engine), with about 15 GB free
- Node 24, Python 3.10 or later, jq
- For the agents: an Anthropic API key (`ANTHROPIC_API_KEY`), or `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for a gateway

The lab has run on Linux x86-64 and on macOS with Apple silicon.

## Start the lab

```bash
lab/up.sh
```

The script builds the images, seeds the ERP, installs the test dependencies and checks every service. It is safe to run again. The first run takes about five minutes, mostly for the ERP database.

| Service | URL | What it is |
|---|---|---|
| ERP | http://127.0.0.1:18069 | Odoo 19, standing in for SAP (`admin` / `admin`) |
| MES | http://127.0.0.1:13000 | The in-house manufacturing execution system |
| Desktop | http://127.0.0.1:6080/vnc.html | Linux desktop running the Java Level 2 client |
| n8n | http://127.0.0.1:15678 | Case intake, regression launcher, business notifications |
| Control room | http://127.0.0.1:17000 | Live view and replays of every run |

All ports bind to loopback. To reach the lab from another machine, use an SSH tunnel.

`lab/up.sh --migration` also starts a second ERP on port 18070, used by the migration rehearsal.

## Run a story on this machine

```bash
scenarios/run.sh                              # list the stories
scenarios/run.sh 08-from-scratch --local      # the same pipeline scripts, without GitHub
```

With `--local`, a case story runs the authoring pipeline in a temporary worktree and leaves the new test and its evidence there. A change story runs the CI pipeline. Open the control room to follow the run while it happens.

## Run the full loop with pull requests

The complete loop (a PR per case, agents reacting to labels, CI on every change) needs a GitHub repository of your own.

1. Fork or push this repository to GitHub and create the labels `new-case`, `automate`, `from-scratch` and `regression`.
2. Register self-hosted runners next to the lab and set the repository variable `QA_LAB_RUNNERS` to `true`: [Self-hosted runners](../operations/runners.md).
3. Optional: load the n8n workflows for the intake form and business notifications: [n8n workflows](../operations/n8n.md).
4. Run a story without `--local`:

   ```bash
   scenarios/run.sh 02-desktop-black-box
   ```

   The script opens a PR with the new case and adds the `automate` label. The authoring workflow picks it up on a runner, and the agent pushes its test and report to the PR.

Replays are published as static pages when `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID` are set on the runners. Without them, runs are still visible in the local control room.

## macOS notes

- The scripts work with the system `/bin/bash` 3.2.
- With Colima and Docker Desktop installed side by side, set `DOCKER_CONTEXT` to the one you use.
- Over SSH, Docker Desktop's keychain credential helper can fail to unlock. Building with Colima avoids it.

## Stop the lab

```bash
docker compose -f lab/compose.yaml down        # keep the data
docker compose -f lab/compose.yaml down -v     # also delete ERP, MES, n8n and control room data
```
