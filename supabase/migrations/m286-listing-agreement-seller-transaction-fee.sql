-- m286 — the SELLER-side brokerage transaction fee, agreed on the listing agreement.
--
-- Every net sheet must price the terms the seller actually agreed to. The
-- commission already lives here (listing_commission_rate / buyer_commission_rate /
-- total_commission_rate / commission_is_flat_fee + commission_flat_amount); a flat
-- brokerage transaction fee charged to the seller at closing had nowhere to live,
-- so it could not be quoted as agreed.
--
-- DELIBERATELY NOT reused: agent_commission_profiles.transaction_fee and
-- agents.transaction_fee are AGENT-side — what the agent pays the brokerage out of
-- their own split. Those must never reduce the seller's proceeds. Different payer,
-- different column.
--
-- Flat dollars only. A percentage-based charge is commission, and belongs in the
-- rate columns above.
alter table listing_agreements
  add column if not exists seller_transaction_fee numeric;

comment on column listing_agreements.seller_transaction_fee is
  'Flat brokerage transaction fee charged to the SELLER at closing, in dollars. Distinct from agents.transaction_fee / agent_commission_profiles.transaction_fee, which are agent-side. NULL means none agreed.';
