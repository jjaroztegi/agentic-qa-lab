# n8n workflows

n8n is where business users meet the lab. `n8n/build.py` generates four workflows and `n8n/setup.sh` loads them into the lab's n8n.

| Workflow | Trigger | What it does |
|---|---|---|
| Case intake | Form | A key user describes a case in plain words. A model drafts it in the catalog template, marks gaps as `PENDING`, and the workflow opens a PR. |
| Regression launcher | Webhook or form | A vendor release or a migration lead starts a regression run. |
| Results | CI and regression results | Writes a business summary of a run and emails it. |
| MCP server | MCP client | Lets any MCP-capable agent start regressions and read recent results. |

## Load them

```bash
export N8N_ANTHROPIC_API_KEY=...   # drafting cases and summaries
export N8N_GITHUB_TOKEN=...        # fine-grained token: contents, pull requests and issues on the repository
export N8N_RESEND_API_KEY=...      # optional: notification emails
export N8N_MCP_TOKEN=...           # optional: bearer token for the MCP server
export N8N_NOTIFY_FROM="QA Lab <qa@your-domain>" N8N_NOTIFY_TO="qa-team@your-domain"
n8n/setup.sh
```

`lab/up.sh` calls `n8n/setup.sh` when the first two keys are set. Without them, n8n starts empty and the rest of the lab works.

The workflows open PRs in the repository named by `QA_REPO` (`owner/name`), or this checkout's `origin` when it is not set.

## Change them

Edit `n8n/build.py`, not the generated JSON, then run `n8n/setup.sh` again. The control room receives an event when a case is drafted and when its PR opens.
