#!/usr/bin/env bash
# Isolated e2e environment for one change:
#   - ERP: a copy of the QA database (Odoo duplicate_database = Postgres template copy, seconds)
#   - MES: the image built from THIS checkout, pointed at that copy
#   - Desktop: its own X display + AT-SPI session running the L2 client from THIS checkout,
#     watchable live (noVNC) and recorded; the run's browser can be shown on it too (QA_SHOW=1)
# Concurrent runs never share data or screens, and the shared QA ERP stays clean.
#   tools/e2e-env.sh up <run-id>     prints ERP_DB, MES_URL, DESKTOP_EXEC, QA_DISPLAY, QA_NOVNC… (append to $GITHUB_ENV)
#   tools/e2e-env.sh down <run-id>
set -euo pipefail
cd "$(dirname "$0")/.."
cmd=$1; RUN_ID=${2:?run id}
DB="erp_ci_${RUN_ID//[^a-zA-Z0-9_]/_}"
ERP=${ERP_URL:-http://127.0.0.1:18069}
MASTER=${ERP_MASTER_PASSWORD:-admin}
CT="qa-mes-${RUN_ID//[^a-zA-Z0-9_]/_}"
DT="qa-desktop-${RUN_ID//[^a-zA-Z0-9_]/_}"

rpc() { curl -sf "$ERP/jsonrpc" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":{\"service\":\"db\",\"method\":\"$1\",\"args\":$2}}"; }

# Host-wide critical sections for concurrent runners (mkdir is atomic everywhere; macOS has no
# flock). A lock older than 2 min was left by a killed run.
LOCK="${TMPDIR:-/tmp}/qa-e2e-env.lockdir"
lock() {
  until mkdir "$LOCK" 2>/dev/null; do
    [[ -n $(find "$LOCK" -maxdepth 0 -mmin +2 2>/dev/null) ]] && rmdir "$LOCK" 2>/dev/null
    sleep 0.3
  done
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}
unlock() { rmdir "$LOCK" 2>/dev/null; trap - EXIT; }

case $cmd in
up)
  # Copying a database needs the template to itself: one copy at a time on this host, retried
  # if a sync of the shared QA MES happens to hold a connection at that moment.
  lock
  for try in 1 2 3 4 5; do
    rpc duplicate_database "[\"$MASTER\",\"erp\",\"$DB\",false]" | jq -e '.result == true' >/dev/null && break
    ((try == 5)) && { echo "Could not copy the erp database" >&2; exit 1; }
    sleep $((try * 2))
  done
  unlock
  docker build -q -t "qa-mes:$RUN_ID" apps/mes >/dev/null
  docker run -d --name "$CT" --network "${LAB_NETWORK:-qa-lab_default}" -p 127.0.0.1::3000 \
    -e ERP_URL="http://${ERP_SERVICE:-erp}:8069" -e ERP_DB="$DB" -e ERP_USER=interface.mes \
    -e ERP_PASSWORD="${ERP_INTERFACE_PASSWORD:-mes-qa-only}" -e SYNC_INTERVAL_S=3 "qa-mes:$RUN_ID" >/dev/null
  url="http://$(docker port "$CT" 3000/tcp | head -1)"
  for _ in $(seq 30); do curl -sf "$url/health" >/dev/null && break; sleep 1; done
  # Desktop: first free slot.
  lock
  for n in $(seq 1 40); do docker ps -aq --filter "label=qa.slot=$n" | grep -q . || break; done
  docker run -d --name "$DT" --network host --ipc host --label "qa.slot=$n" \
    -e QA_DISPLAY_NUM=$((100 + n)) -e QA_VNC_PORT=$((6000 + n)) -e QA_NOVNC_PORT=$((6100 + n)) \
    -v "$PWD/apps/l2-desktop:/home/qa/l2:ro" "${DESKTOP_IMAGE:-qa-desktop:local}" >/dev/null
  unlock
  for _ in $(seq 30); do docker exec "$DT" test -s /home/qa/.desktop-env && curl -sf -o /dev/null "http://127.0.0.1:$((6100 + n))/vnc.html" && break; sleep 1; done
  echo "ERP_DB=$DB"; echo "MES_URL=$url"
  echo "DESKTOP_EXEC=docker exec $DT"; echo "QA_DISPLAY=:$((100 + n))"
  echo "QA_NOVNC=http://127.0.0.1:$((6100 + n))/vnc.html"; echo "QA_VNC_WS=ws://127.0.0.1:$((6100 + n))/websockify" ;;
down)
  docker rm -f "$CT" "$DT" >/dev/null 2>&1 || true
  docker rmi "qa-mes:$RUN_ID" >/dev/null 2>&1 || true
  rpc drop "[\"$MASTER\",\"$DB\"]" >/dev/null || true ;;
*) echo "usage: $0 up|down <run-id>" >&2; exit 2 ;;
esac
