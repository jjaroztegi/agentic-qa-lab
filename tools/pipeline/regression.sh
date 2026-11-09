#!/usr/bin/env bash
# Commercial systems: black-box regression of the business cases on an ERP, launched by an event
# (vendor release, transport, migration rehearsal). With mode=migration it also compares business
# data between source and target.
#   tools/pipeline/regression.sh [erp|erp-new] [regression|migration]
# Writes evidence/regression.json; exit 0 = no business case broken and no unexpected data diff.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; cd "$ROOT"
TARGET=${1:-erp} MODE=${2:-regression}; export RUN_ID=${RUN_ID:-reg_$(date +%Y%m%d%H%M%S)}
if [[ $TARGET == erp-new ]]; then export ERP_URL=http://127.0.0.1:18070 ERP_SERVICE=erp-new; fi
mkdir -p evidence
stage env start "Environment on $TARGET"
env_up
emit run "$RUN_ID" "$(jq -nc --arg erp "${ERP_URL:-http://127.0.0.1:18069}" --arg mes "$MES_URL" --arg vnc "$QA_VNC_WS" --arg novnc "$QA_NOVNC" --arg t "$TARGET" --arg m "$MODE" --arg r "${REASON:-manual}" \
  '{workflow:"regression", title:("Process regression on " + (if $t=="erp-new" then "the migrated ERP" else "the ERP" end) + " · " + $r), target:$t, mode:$m, vnc:$vnc, novnc:$novnc, systems:{ERP:$erp, MES:$mes}}')"
stage env ok "ERP copy ${ERP_DB} · MES ${MES_URL}"
[[ $(uname -s) == Linux ]] && export QA_SHOW=1   # the run desktop is an X display on this host
rec_start
e2e=ok compare=
stage prove start "Business cases on $TARGET"
npx playwright test || e2e=fail
stage prove "$e2e"
if [[ $MODE == migration ]]; then
  stage compare start "Source/target data comparison"
  if uv run --script tools/compare/compare.py --source http://127.0.0.1:18069 --target http://127.0.0.1:18070 --out evidence/compare; then compare=ok; else compare=fail; fi
  stage compare "$compare" "$(head -c 300 evidence/compare/summary.md 2>/dev/null || true)"
fi
jq -n --arg t "$TARGET" --arg m "$MODE" --arg e "$e2e" --arg c "$compare" '{target:$t, mode:$m, e2e:$e, compare:($c|select(.!=""))}' > evidence/regression.json
if [[ $e2e == ok && $compare != fail ]]; then RESULT_TITLE="No regressions on $TARGET"
else RESULT_TITLE="Regression on $TARGET: cases $e2e${compare:+, data $compare}"; exit 1; fi
