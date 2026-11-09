#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6"]
# ///
"""Before/after data comparison of two ERP instances (source vs. migrated target).

    tools/compare/compare.py --source http://127.0.0.1:18069 --target http://127.0.0.1:18070 [--out evidence/compare]

Reads tools/compare/checks.yaml, compares every check by key with tolerances, ignores the
declared expected differences, writes summary.md + diff.json, exits 1 on unexpected differences.
The verdict is the comparison, not a person looking at screens.
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.request

import yaml

HERE = pathlib.Path(__file__).parent


class Odoo:
    def __init__(self, url, db, login, password):
        self.url, self.db, self.password = url, db, password
        self.uid = self._rpc("common", "login", db, login, password)
        if not self.uid:
            raise SystemExit(f"login rejected at {url}")

    def _rpc(self, service, method, *args):
        body = json.dumps({"jsonrpc": "2.0", "method": "call", "params": {"service": service, "method": method, "args": args}})
        req = urllib.request.Request(f"{self.url}/jsonrpc", body.encode(), {"content-type": "application/json"})
        # Every call here is a read, so retrying is safe. Concurrent runs copying or dropping their
        # ERP database on the same server can make one call fail ("cursor already closed").
        for attempt in range(4):
            res = json.load(urllib.request.urlopen(req, timeout=120))
            if "error" not in res:
                return res["result"]
            if attempt < 3:
                time.sleep(5 * (attempt + 1))
        raise RuntimeError(res["error"]["data"].get("message"))

    def read(self, model, domain, fields):
        return self._rpc("object", "execute_kw", self.db, self.uid, self.password, model, "search_read",
                         [domain], {"fields": fields, "context": {"active_test": False}})


def norm(v):
    if isinstance(v, list) and len(v) == 2 and isinstance(v[0], int):  # many2one -> display name
        return v[1]
    return v


def index(rows, check):
    out = {}
    for r in rows:
        key = " | ".join(str(norm(r[k])) for k in check["key"])
        out[key] = {f: norm(r[f]) for f in check["fields"]}
    return out


def expected(check_id, key, field, rules):
    for e in rules:
        if e["check"] != check_id:
            continue
        if ("key" not in e or e["key"] == key) and ("field" not in e or e["field"] == field):
            return e.get("reason", "expected")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--db", default="erp")
    ap.add_argument("--out", default="evidence/compare")
    ap.add_argument("--checks", default=str(HERE / "checks.yaml"))
    a = ap.parse_args()

    cfg = yaml.safe_load(open(a.checks))
    login, pw = "admin", os.environ.get("ERP_ADMIN_PASSWORD", "admin")
    src, tgt = Odoo(a.source, a.db, login, pw), Odoo(a.target, a.db, login, pw)

    diffs, summary = [], []
    for c in cfg["checks"]:
        fields = list(dict.fromkeys(c["key"] + c["fields"]))
        s = index(src.read(c["model"], c.get("domain", []), fields), c)
        t = index(tgt.read(c["model"], c.get("domain", []), fields), c)
        tol = c.get("tolerance", 0)
        found = []
        for key in sorted(s.keys() | t.keys()):
            if key not in t:
                found.append({"key": key, "field": "*", "source": "present", "target": "MISSING"})
                continue
            if key not in s:
                found.append({"key": key, "field": "*", "source": "MISSING", "target": "present"})
                continue
            for f in c["fields"]:
                a_, b_ = s[key][f], t[key][f]
                same = abs(a_ - b_) <= tol if isinstance(a_, (int, float)) and isinstance(b_, (int, float)) and not isinstance(a_, bool) else a_ == b_
                if not same:
                    found.append({"key": key, "field": f, "source": a_, "target": b_})
        for d in found:
            d.update(check=c["id"], title=c["title"], expected=expected(c["id"], d["key"], d["field"], cfg.get("expected_differences", [])))
        unexpected = [d for d in found if not d["expected"]]
        summary.append((c["title"], len(s), len(t), len(found) - len(unexpected), len(unexpected)))
        diffs += found

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "diff.json").write_text(json.dumps(diffs, ensure_ascii=False, indent=2, default=str))
    bad = [d for d in diffs if not d["expected"]]
    lines = [f"# Before/after comparison: {a.source} -> {a.target}", "",
             "| Check | Source records | Target records | Expected differences | Unexpected differences |",
             "|---|---:|---:|---:|---:|"]
    lines += [f"| {t} | {n1} | {n2} | {e} | {'**' + str(u) + '**' if u else 0} |" for t, n1, n2, e, u in summary]
    if bad:
        lines += ["", "## Unexpected differences", "", "| Check | Key | Field | Source | Target |", "|---|---|---|---|---|"]
        lines += [f"| {d['title']} | {d['key']} | {d['field']} | {d['source']} | {d['target']} |" for d in bad[:50]]
    lines += ["", f"**Verdict:** {'failed, ' + str(len(bad)) + ' unexpected differences' if bad else 'passed, no unexpected differences'}"]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
