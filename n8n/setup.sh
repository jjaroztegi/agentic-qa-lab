#!/usr/bin/env bash
# Loads the QA control tower into the lab's n8n: credentials (written only to a mode-600 temp file
# that is deleted), then the workflows, then publishes them.
# Needs these environment variables:
#   N8N_ANTHROPIC_API_KEY   LLM summaries and case drafting
#   N8N_GITHUB_TOKEN        opens case PRs, launches regressions (contents, pull requests, actions)
#   N8N_RESEND_API_KEY      business notifications by email (optional: without it, sending fails)
#   N8N_MCP_TOKEN           bearer token for the QA MCP server (optional: without it, MCP is unusable)
# Optional: QA_REPO=owner/name (default: this checkout's origin), N8N_NOTIFY_FROM, N8N_NOTIFY_TO.
set -euo pipefail
cd "$(dirname "$0")"
CT=${N8N_CONTAINER:-qa-lab-n8n-1}
: "${N8N_ANTHROPIC_API_KEY:?set N8N_ANTHROPIC_API_KEY}" "${N8N_GITHUB_TOKEN:?set N8N_GITHUB_TOKEN}"
wf=$(mktemp -d)
N8N_WORKFLOWS_OUT=$wf python3 build.py

tmp=$(mktemp); chmod 600 "$tmp"; trap 'rm -rf "$tmp" "$wf"; docker exec "$CT" rm -f /tmp/creds.json' EXIT
jq -n --arg a "$N8N_ANTHROPIC_API_KEY" --arg g "$N8N_GITHUB_TOKEN" \
      --arg r "${N8N_RESEND_API_KEY:-}" --arg m "${N8N_MCP_TOKEN:-}" '[
  {id:"qaAnthropic00001", name:"Anthropic", type:"anthropicApi", data:{apiKey:$a}},
  {id:"qaGithub00000001", name:"GitHub", type:"githubApi", data:{server:"https://api.github.com", user:"", accessToken:$g}},
  {id:"qaResend00000001", name:"Resend", type:"httpHeaderAuth", data:{name:"Authorization", value:("Bearer " + $r)}},
  {id:"qaMcpBearer00001", name:"MCP token", type:"httpBearerAuth", data:{token:$m}}]' > "$tmp"
docker cp "$tmp" "$CT:/tmp/creds.json"
docker exec "$CT" n8n import:credentials --input=/tmp/creds.json
docker exec "$CT" rm -rf /tmp/wf && docker cp "$wf" "$CT:/tmp/wf"
docker exec "$CT" n8n import:workflow --separate --input=/tmp/wf
for f in "$wf"/*.json; do docker exec "$CT" n8n publish:workflow --id="$(jq -r .id "$f")"; done
docker restart "$CT" >/dev/null
echo "n8n ready: http://127.0.0.1:15678"
