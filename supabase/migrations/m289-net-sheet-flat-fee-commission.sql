-- m289 — let a SAVED net sheet express a flat-fee commission.
--
-- net_sheet_calculations could only store listing_commission_rate /
-- buyer_commission_rate — two PERCENTAGES. A brokerage on a flat-fee listing
-- agreement (listing_agreements.commission_is_flat_fee + commission_flat_amount,
-- which resolveAgreedCommission already honours on the DISPLAYED sheet) had no
-- column to land in, so saving one silently converted it to percentages — and
-- saveNetSheet's `?? 3` default then reinstated 3% + 3% when the caller passed
-- nothing. A seller could be shown a $4,995 flat fee and, on reload, be shown 6%
-- of the sale price instead.
--
-- Same field names as listing_agreements so the agreement and the sheet derived
-- from it read identically, and resolveAgreedCommission's AgreementCommissionFields
-- shape maps straight across.
ALTER TABLE public.net_sheet_calculations
  ADD COLUMN IF NOT EXISTS commission_is_flat_fee boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_flat_amount numeric;

COMMENT ON COLUMN public.net_sheet_calculations.commission_is_flat_fee IS
  'True when the agreed commission is a flat dollar fee rather than a percentage. Mirrors listing_agreements.commission_is_flat_fee.';
COMMENT ON COLUMN public.net_sheet_calculations.commission_flat_amount IS
  'The flat commission in dollars when commission_is_flat_fee. Mirrors listing_agreements.commission_flat_amount.';
