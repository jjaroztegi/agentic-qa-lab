#!/usr/bin/env bash
# The whole lab with one command, from a fresh clone:
#   ERP (Odoo 19, standing in for SAP) seeded · MES built from this checkout · L2 desktop · n8n · control room.
#   lab/up.sh              start (idempotent: safe to run again)
#   lab/up.sh --migration  also the lift & shift target (erp-new)
# n8n workflows need API keys in the environment (N8N_ANTHROPIC_API_KEY, N8N_GITHUB_TOKEN; optional
# N8N_RESEND_API_KEY, N8N_MCP_TOKEN, see n8n/setup.sh); without them n8n starts empty and everything
# else works.
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\033[1m· %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "Missing $1 ($2)" >&2; exit 1; }; }
need docker "https://docs.docker.com/get-docker/"
need node "Node 24+"
need jq "jq"
need python3 "Python 3.10+"
docker compose version >/dev/null || { echo "Missing docker compose v2" >&2; exit 1; }
[[ $(node -p 'process.versions.node.split(".")[0]') -ge 24 ]] || { echo "Node 24+ required" >&2; exit 1; }

profiles=()
[[ ${1:-} == --migration ]] && profiles=(--profile migration)

say "building and starting containers"
docker compose ${profiles[@]+"${profiles[@]}"} up -d --build

say "ERP: database and master data (2-4 min the first time)"
python3 erp/seed.py http://127.0.0.1:18069

if [[ ${1:-} == --migration ]]; then
  say "migration rehearsal: clean copy erp -> erp-new"
  migration/rehearsal.sh
fi

say "n8n"
if [[ -n ${N8N_ANTHROPIC_API_KEY:-} && -n ${N8N_GITHUB_TOKEN:-} ]]; then
  ../n8n/setup.sh || echo "  n8n without workflows (setup failed): the rest of the lab works"
else
  echo "  no keys: n8n starts empty (see n8n/setup.sh)"
fi

say "test dependencies"
(cd .. && npm ci --silent && npx playwright install chromium >/dev/null)

say "checking"
ok=1
check() {  # retries: n8n restarts after its workflows load
  local i; for i in $(seq 30); do curl -sf -m 5 -o /dev/null "$2" && break; sleep 2; done
  if curl -sf -m 5 -o /dev/null "$2"; then printf '  ✓ %-22s %s\n' "$1" "$2"; else printf '  ✗ %-22s %s\n' "$1" "$2"; ok=0; fi; }
check "ERP (Odoo)"        http://127.0.0.1:18069/web/login
check "MES"               http://127.0.0.1:13000/health
check "n8n"               http://127.0.0.1:15678/healthz
check "L2 desktop"        http://127.0.0.1:6080/vnc.html
check "Control room"      http://127.0.0.1:17000/
[[ ${1:-} == --migration ]] && check "Migrated ERP" http://127.0.0.1:18070/web/login
((ok)) && echo "Lab ready. Next: scenarios/README.md" || { echo "Something did not start: docker compose -f lab/compose.yaml ps"; exit 1; }
