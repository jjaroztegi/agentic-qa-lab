TITLE="A performance change in the MES introduces a business defect: CI blocks it"
KIND=change
COMMIT="perf(mes): sum the produced weight in SQL when confirming to the ERP"
BODY="When an order is completed, the produced weight is summed in one query instead of loading every coil into memory."
# The defect: the SQL sum forgets that held coils do not count as produced. The unit tests
# don't cover the sync, so only the end-to-end business cases can catch it.
apply() {
  python3 - <<'PY'
import pathlib
p = pathlib.Path("apps/mes/src/erp.ts"); s = p.read_text()
old = '''    const coils = db.prepare("SELECT * FROM coils WHERE order_id = ?").all(o.id) as Coil[];
    try {
      const msg = await erp.confirmProduction(o.erp_ref, producedTonnes(coils));'''
new = '''    const { kg } = db.prepare("SELECT COALESCE(SUM(weight_kg), 0) AS kg FROM coils WHERE order_id = ?").get(o.id) as { kg: number };
    try {
      const msg = await erp.confirmProduction(o.erp_ref, Math.round(kg) / 1000);'''
assert old in s, "erp.ts changed: update the scenario"
p.write_text(s.replace(old, new))
PY
}
