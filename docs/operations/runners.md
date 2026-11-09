# Self-hosted runners

The jobs that need the lab run on self-hosted GitHub Actions runners with the label `qa-lab`, on the same host as the lab. That mirrors a company setup: the systems under test sit inside the company network, out of reach of cloud-hosted runners, so the runners sit next to them. Each runner takes one job at a time, and isolated environments let several runners share one host.

Those jobs only run when the repository variable `QA_LAB_RUNNERS` is `true`. Without it they are skipped, and only the unit and contract tests run on GitHub-hosted runners.

## Register runners

Requirements: Linux with systemd, `sudo`, and `gh` logged in with admin rights on the repository.

```bash
lab/runner/setup.sh 3                                   # registers runners 1 to 3 for this checkout's repository
gh variable set QA_LAB_RUNNERS --body true              # turns on the jobs that need them
```

The runners run as a dedicated user, `qa` by default (`QA_RUNNER_USER`), in the `docker` group. Workflow code never runs as you, so it cannot read your home directory, your credentials or your tool settings. Each runner lives in `~qa/actions-runner-<n>`, runs as the system service `qa-runner-<n>`, and reports `qa-lab` (`QA_RUNNER_HOST`) as its machine name.

The `qa` user needs Node 24, the Claude Code CLI and Playwright's Chromium on its `PATH`.

## Runner environment

All runners read `~qa/.config/qa-runner.env` (mode 600). The setup script creates it empty.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Model access for the agents. Or `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for a gateway. |
| `QA_EVENTS_URL` | Control room, usually `http://127.0.0.1:17000` |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` | Optional. Publish replays as static pages. |
| `QA_AGENT_MODEL` | Optional. Model for the agents. |
| `PATH` | Must include Node 24, Docker and the Claude Code CLI |

Restart the runners after changing it: `sudo systemctl restart 'qa-runner-*'`.

## Public repositories

Anyone can open a pull request on a public repository, and a pull request from a fork runs the workflow files in that pull request, not yours. A self-hosted runner in the `docker` group gives that code control of the host. On a public repository:

- Keep the runners offline, or require approval for every outside contributor's workflow runs (**Settings → Actions → General**), and only approve code you have read.
- Unset `QA_LAB_RUNNERS` when the runners are offline, so jobs are skipped instead of waiting for a runner.

## Remove runners

```bash
sudo systemctl disable --now qa-runner-1
sudo -u qa -H bash -c 'cd ~/actions-runner-1 && ./config.sh remove --token "$1"' _ \
  "$(gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token -q .token)"
gh variable delete QA_LAB_RUNNERS
```

## Other CI systems

The workflows only call the scripts in `tools/pipeline/`. Another CI system can run the same scripts with the same environment variables: `author.sh <case>`, `ci.sh <base-ref>` and `regression.sh <target> <mode>`.
