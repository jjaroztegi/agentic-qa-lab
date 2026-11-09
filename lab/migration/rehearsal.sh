#!/usr/bin/env bash
# Migration rehearsal (lift & shift) of the ERP: same version, same code, same data, new "host".
#   lab/migration/rehearsal.sh             clean copy erp -> erp-new
#   lab/migration/rehearsal.sh --drift     ...plus the slips a real rehearsal tends to have:
#       base URL repointed (expected), quantity precision reset to 2 decimals and the
#       procurement scheduler left disabled (both unexpected; the comparison must catch them).
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose"
$C --profile migration up -d erp-new-db
$C stop erp-new >/dev/null 2>&1 || true
until $C exec -T erp-new-db pg_isready -U odoo -q; do sleep 1; done
echo "· copying the erp database"
$C exec -T erp-new-db psql -qU odoo -d postgres -c "DROP DATABASE IF EXISTS erp" -c "CREATE DATABASE erp OWNER odoo"
# Same host-wide lock as tools/e2e-env.sh: copying the ERP for a run (Odoo duplicate_database) ends
# every connection to the source database, this dump included.
LOCK="${TMPDIR:-/tmp}/qa-e2e-env.lockdir"
until mkdir "$LOCK" 2>/dev/null; do sleep 0.3; done
dump=$(mktemp); trap 'rmdir "$LOCK" 2>/dev/null; rm -f "$dump"' EXIT
$C exec -T erp-db pg_dump -U odoo -Fc erp > "$dump"
rmdir "$LOCK"
# From a file: piping one `compose exec` into another can cut the stream short.
$C exec -T erp-new-db pg_restore -U odoo -d erp --no-owner < "$dump"
rm -f "$dump"; trap - EXIT
echo "· copying the filestore"
$C --profile migration create erp-new >/dev/null 2>&1
docker run --rm -v qa-lab_erp-data:/from:ro -v qa-lab_erp-new-data:/to alpine sh -c 'rm -rf /to/* && cp -a /from/. /to/'
$C --profile migration up -d erp-new
until curl -sf -o /dev/null -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:18070/web/webclient/version_info; do sleep 2; done
sql() { $C exec -T erp-new-db psql -qU odoo -d erp -c "$1"; }
sql "UPDATE ir_config_parameter SET value='http://erp-new:8069' WHERE key='web.base.url'"
if [[ ${1:-} == --drift ]]; then
  echo "· applying the drift typical of a rehearsal"
  sql "UPDATE decimal_precision SET digits=2 WHERE name IN ('Product Unit of Measure','Product Unit')"
  sql "UPDATE ir_cron SET active=false WHERE ir_actions_server_id IN (SELECT id FROM ir_act_server WHERE name->>'en_US' ILIKE '%procurement%scheduler%')"
  $C --profile migration restart erp-new >/dev/null
  until curl -sf -o /dev/null -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:18070/web/webclient/version_info; do sleep 2; done
fi
echo "✓ erp-new ready at http://127.0.0.1:18070"
