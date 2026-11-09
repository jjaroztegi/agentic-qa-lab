TITLE="First day on a module never tested before (ERP maintenance): no source, no prior tests, no helpers"
KIND=case
FROM_SCRATCH=1
# Odoo's Maintenance app is a real third-party product this platform was never prepared for: no
# helpers in the support layer, no example tests, no source code. The agent learns it as a new
# key user would, from the screens, and leaves a deterministic test.
