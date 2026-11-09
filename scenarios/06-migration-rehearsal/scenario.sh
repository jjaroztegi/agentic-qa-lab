TITLE="ERP lift-and-shift migration rehearsal with drift: regression + data comparison"
KIND=regression
TARGET=erp-new RMODE=migration
# The rehearsal copies the ERP to a new host and, like real rehearsals, slips: quantity precision
# reset to 2 decimals and the procurement scheduler left off. The comparison must catch both.
apply() { lab/migration/rehearsal.sh --drift; }
