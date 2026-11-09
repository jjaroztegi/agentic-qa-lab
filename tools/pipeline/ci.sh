#!/usr/bin/env bash
# A change to our own code (MES, L2 client) against every automated business case, isolated.
#   tools/pipeline/ci.sh [base-ref]      base-ref (e.g. origin/main) enables agent triage on failure
# Red e2e -> the qa-triage agent classifies: test drift (it repairs locators, a deterministic guard
# vets the repair, e2e reruns) or application regression (blocked, explained for the business).
# Writes evidence/ci.json; exit 0 = the change can go in.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; cd "$ROOT"
BASE=${1:-}; export RUN_ID=${RUN_ID:-ci_$(date +%Y%m%d%H%M%S)}
mkdir -p evidence
stage env start "Isolated environment"
env_up
emit run "$RUN_ID" "$(jq -nc --arg erp "${ERP_URL:-http://127.0.0.1:18069}" --arg mes "$MES_URL" --arg vnc "$QA_VNC_WS" --arg novnc "$QA_NOVNC" --arg pr "${PR_NUMBER:-}" --arg t "${CI_TITLE:-Change to in-house code}" \
  --arg repo "${GITHUB_REPOSITORY:-}" '{workflow:"ci", title:$t, pr:($pr|tonumber? // null), vnc:$vnc, novnc:$novnc, systems:{ERP:$erp, MES:$mes}, repo:$repo}')"
stage env ok "ERP copy ${ERP_DB} · MES ${MES_URL} · desktop ${QA_DISPLAY}"
[[ $(uname -s) == Linux ]] && export QA_SHOW=1   # the run desktop is an X display on this host
rec_start

e2e=ok desk=ok verdict= rerun=
stage prove start "Web business cases (ERP + MES)"
npx playwright test || e2e=fail
stage prove "$e2e" "Web cases: $e2e"
if ls tests/desktop/*.test.mjs >/dev/null 2>&1; then
  stage prove start "Desktop cases (L2 client)"
  # One file at a time: every desktop test drives the same screen and the same client.
  node --test --test-concurrency=1 --test-timeout=300000 tests/desktop/*.test.mjs || desk=fail
  stage prove "$desk" "Desktop cases: $desk"
fi

if [[ $e2e == fail && -n $BASE ]]; then
  stage triage start "Agent triage"
  QA_AGENT_TOOLS="${QA_AGENT_TOOLS:+$QA_AGENT_TOOLS,}Bash(node tools/guard-heal.mjs*),Bash(git checkout -- tests/e2e*),Bash(git fetch:*),Bash(git log:*),Bash(unzip:*)" \
    tools/agent.sh qa-triage "base=$BASE" || true
  verdict=$(jq -r .verdict evidence/triage.json 2>/dev/null || echo none)
  stage triage "$([[ $verdict == pass_after_heal ]] && echo ok || echo fail)" "Verdict: $verdict"
  if [[ $verdict == pass_after_heal ]]; then
    stage guard start "Deterministic guard on the repair"
    if node tools/guard-heal.mjs && npx playwright test; then rerun=ok; stage guard ok; else rerun=fail; stage guard fail; fi
  fi
fi

jq -n --arg e2e "$e2e" --arg desktop "$desk" --arg verdict "$verdict" --arg rerun "$rerun" \
  '{e2e:$e2e, desktop:$desktop, triage:($verdict|select(.!="")), rerun:($rerun|select(.!=""))}' > evidence/ci.json
cat evidence/ci.json
if [[ ($e2e == ok || $rerun == ok) && $desk == ok ]]; then
  RESULT_TITLE=$([[ $rerun == ok ]] && echo "Meets the business cases (test repaired by the agent)" || echo "Meets all business cases")
else
  RESULT_TITLE=$([[ -n $verdict ]] && echo "Blocked: $verdict" || echo "Blocked: a business case fails"); exit 1
fi
