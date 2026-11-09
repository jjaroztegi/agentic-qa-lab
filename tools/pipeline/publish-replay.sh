#!/usr/bin/env bash
# Publish one run's replay (screen recording + agent narration + stages) as a static page and
# print its public URL. Uses the control room at QA_EVENTS_URL and Vercel (VERCEL_ORG_ID,
# VERCEL_PROJECT_ID, and VERCEL_TOKEN or a logged-in CLI). Prints nothing and exits 0 if either
# is missing: a replay is a nice-to-have, never a reason to fail a pipeline.
#   tools/pipeline/publish-replay.sh [run-id]
set -uo pipefail
cd "$(dirname "$0")/../.."
RUN=${1:-${RUN_ID:-}}
[[ -n $RUN && -n ${QA_EVENTS_URL:-} && -n ${VERCEL_PROJECT_ID:-} ]] || exit 0
vercel_cli() { if type -P vercel >/dev/null; then vercel "$@"; else npx --yes vercel@65.9.0 "$@"; fi; }
dist=apps/control-room/dist
[[ -f $dist/index.html ]] || docker cp "${CONTROL_CONTAINER:-qa-lab-control-1}:/app/dist" "$dist" >/dev/null 2>&1 \
  || (cd apps/control-room && npm ci --silent && npm run build >/dev/null) || exit 0
out=$(mktemp -d)/replay-${RUN//[^a-zA-Z0-9_-]/_}
CONTROL_URL=$QA_EVENTS_URL node apps/control-room/export.mjs "$RUN" "$out" >&2 || exit 0
vercel_cli deploy "$out" --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} 2>&1 | grep -o 'https://[^" ]*\.vercel\.app' | head -1
