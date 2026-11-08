#!/usr/bin/env python3
"""Seed the Odoo QA instance that stands in for SAP.

Creates database `erp`, installs Sales + Manufacturing, and the minimum master data for the
order-to-coil flow: hot-rolled coil products (made to order), slab raw material with stock,
customers, and the technical user the MES interface logs in with. Idempotent.

    python3 lab/erp/seed.py [http://127.0.0.1:18069]
"""
import os
import sys
import time
import urllib.request
import json

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18069"
DB = "erp"
ADMIN_PW = os.environ.get("ERP_ADMIN_PASSWORD", "admin")  # QA-only instance on loopback
IFACE_PW = os.environ.get("ERP_INTERFACE_PASSWORD", "mes-qa-only")

for _ in range(60):
    try:
        urllib.request.urlopen(f"{URL}/web/webclient/version_info", data=b"{}", timeout=3)
        break
    except Exception:
        time.sleep(2)



def rpc(service, method, *args):
    body = json.dumps({"jsonrpc": "2.0", "method": "call", "params": {"service": service, "method": method, "args": args}})
    req = urllib.request.Request(f"{URL}/jsonrpc", body.encode(), {"content-type": "application/json"})
    res = json.load(urllib.request.urlopen(req, timeout=600))
    if "error" in res:
        raise RuntimeError(res["error"]["data"].get("message", res["error"]))
    return res.get("result")  # absent when the method returns None


if DB not in rpc("db", "list"):
    print("creating database", DB)
    rpc("db", "create_database", "admin", DB, False, "en_US", ADMIN_PW, "admin", False)  # no country: generic chart of accounts

uid = rpc("common", "login", DB, "admin", ADMIN_PW)


def x(model, method, *args, **kw):
    return rpc("object", "execute_kw", DB, uid, ADMIN_PW, model, method, list(args), kw)


def ref(xmlid):
    mod, name = xmlid.split(".")
    r = x("ir.model.data", "search_read", [["module", "=", mod], ["name", "=", name]], fields=["res_id"])
    return r[0]["res_id"] if r else None


def upsert(model, domain, vals):
    ids = x(model, "search", domain, context={"active_test": False})
    if ids:
        x(model, "write", ids, vals)
        return ids[0]
    return x(model, "create", vals)


# Modules
todo = x("ir.module.module", "search", [["name", "in", ["sale_management", "mrp", "stock"]], ["state", "!=", "installed"]])
if todo:
    print("installing modules")
    x("ir.module.module", "button_immediate_install", todo)

# Company
company = x("res.users", "read", [uid], fields=["company_id"])[0]["company_id"][0]
x("res.company", "write", [company], {"name": "Demo Steel Plant Ltd.", "city": "Northport"})

# Quantities in tonnes need 3 decimals (kg precision).
dp = x("decimal.precision", "search", [["name", "in", ["Product Unit of Measure", "Product Unit"]]])
x("decimal.precision", "write", dp, {"digits": 3})

# Make-to-order route is archived by default; coils are made to order.
mto = ref("stock.route_warehouse0_mto")
x("stock.route", "write", [mto], {"active": True})
manufacture = ref("mrp.route_warehouse0_manufacture")

ton = ref("uom.product_uom_ton")
cat = upsert("product.category", [["name", "=", "Steel products"]], {"name": "Steel products"})

def product(code, name, price, routes=None, storable=True):
    vals = {
        "default_code": code, "name": name, "type": "consu", "is_storable": storable,
        "uom_id": ton, "categ_id": cat, "list_price": price, "sale_ok": True,
    }
    if routes:
        vals["route_ids"] = [(6, 0, routes)]
    return upsert("product.product", [["default_code", "=", code]], vals)

slab = product("SLB-S275", "Slab S275JR", 520.0)
coils = {
    "HRC-S275": product("HRC-S275", "Hot-rolled coil S275JR", 690.0, [mto, manufacture]),
    "HRC-S355": product("HRC-S355", "Hot-rolled coil S355J2", 735.0, [mto, manufacture]),
    "PKL-DD11": product("PKL-DD11", "Pickled coil DD11", 760.0, [mto, manufacture]),
}

# BoM: 1.03 t of slab per tonne of coil (3 % yield loss).
for code, pid in coils.items():
    tmpl = x("product.product", "read", [pid], fields=["product_tmpl_id"])[0]["product_tmpl_id"][0]
    if not x("mrp.bom", "search", [["product_tmpl_id", "=", tmpl]]):
        x("mrp.bom", "create", {
            "product_tmpl_id": tmpl, "product_qty": 1.0, "product_uom_id": ton, "type": "normal",
            "bom_line_ids": [(0, 0, {"product_id": slab, "product_qty": 1.03, "product_uom_id": ton})],
        })

# Slab stock so manufacturing orders are ready.
stock_loc = ref("stock.stock_location_stock")
quant = x("stock.quant", "search_read", [["product_id", "=", slab], ["location_id", "=", stock_loc]], fields=["quantity"])
if not quant or quant[0]["quantity"] < 5000:
    x("stock.quant", "create", {"product_id": slab, "location_id": stock_loc, "inventory_quantity": 10000.0})
    q = x("stock.quant", "search", [["product_id", "=", slab], ["location_id", "=", stock_loc]])
    x("stock.quant", "action_apply_inventory", q)

for name, city in [
    ("Northline Fabrication Ltd.", "Northport"),
    ("Meridian Construction Inc.", "Eastbridge"),
    ("Atlantic Tube Ltd.", "Westhaven"),
]:
    upsert("res.partner", [["name", "=", name]], {"name": name, "city": city, "is_company": True})

# Technical user for the MES interface: manufacturing user, read on sales.
groups = [ref("mrp.group_mrp_user"), ref("stock.group_stock_user"), ref("sales_team.group_sale_salesman_all_leads")]
iface = upsert("res.users", [["login", "=", "interface.mes"]], {
    "name": "MES Interface", "login": "interface.mes", "password": IFACE_PW,
    "group_ids": [(6, 0, [g for g in groups if g] + [ref("base.group_user")])],
})
print(f"seeded: db={DB} company={company} coils={list(coils)} interface_user={iface}")

# Sales user the UI tests log in with (key-user role, not admin).
SALES_PW = os.environ.get("ERP_SALES_PASSWORD", "sales-qa")
sales = upsert("res.users", [["login", "=", "sales.rep"]], {
    "name": "Sales Rep", "login": "sales.rep", "password": SALES_PW,
    "group_ids": [(6, 0, [ref("base.group_user"), ref("sales_team.group_sale_salesman_all_leads")])],
    "tz": "Europe/Berlin", "lang": "en_US",
})
print(f"sales user: sales.rep ({sales})")

# Maintenance (Odoo's own app, installed but never prepared for the tests): the "first day on a new
# system" case. Plant equipment, the rolling mill maintenance team and the shift supervisor who reports
# breakdowns (a plain internal user: anyone in the plant can file a maintenance request).
mods = x("ir.module.module", "search_read", [["name", "=", "maintenance"]], fields=["state"])
if mods and mods[0]["state"] != "installed":
    print("installing maintenance")
    x("ir.module.module", "button_immediate_install", [mods[0]["id"]])
team = upsert("maintenance.team", [["name", "=", "Rolling mill maintenance"]], {"name": "Rolling mill maintenance"})
cat = upsert("maintenance.equipment.category", [["name", "=", "Rolling mill"]], {"name": "Rolling mill"})
for name, serial in [("Finishing mill · Stand F3", "FM-F3"), ("Downcoiler 2", "DC-2"), ("Crop shear", "CS-1")]:
    upsert("maintenance.equipment", [["name", "=", name]],
           {"name": name, "serial_no": serial, "category_id": cat, "maintenance_team_id": team})
SHIFT_PW = os.environ.get("ERP_SHIFT_PASSWORD", "shift-qa")
shift = upsert("res.users", [["login", "=", "shift.supervisor"]], {
    "name": "Shift Supervisor", "login": "shift.supervisor", "password": SHIFT_PW,
    "group_ids": [(6, 0, [ref("base.group_user")])], "tz": "Europe/Berlin", "lang": "en_US",
})
# The supervisor follows the equipment of the line: base users see only the equipment they follow.
partner = x("res.users", "read", [shift], fields=["partner_id"])[0]["partner_id"][0]
x("maintenance.equipment", "message_subscribe", x("maintenance.equipment", "search", [["category_id", "=", cat]]), partner_ids=[partner])
print(f"maintenance: team={team} shift supervisor: shift.supervisor ({shift})")

