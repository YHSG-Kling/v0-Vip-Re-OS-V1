-- m287 — persist the seller transaction fee on a saved net sheet.
--
-- m286 put the AGREED fee on listing_agreements. This is the per-sheet value the
-- agent actually used: pre-filled from the agreement, overridable on the sheet.
-- Without it, an edited fee vanished on reload while every other editable line
-- (closing costs, payoff, taxes, HOA, repairs, concessions) persisted.
alter table net_sheet_calculations
  add column if not exists transaction_fee numeric;

comment on column net_sheet_calculations.transaction_fee is
  'Flat brokerage transaction fee charged to the SELLER on this saved net sheet, in dollars. Pre-filled from listing_agreements.seller_transaction_fee; the agent may override per sheet.';
