-- m265 — Agent-to-agent client referrals (with the money).
--
-- An agent whose client is relocating refers them to another agent in the same (multi-location /
-- nationwide) brokerage and earns a referral fee when the deal closes. The referrals table was
-- partner-oriented; these additive columns let an internal agent→agent referral live in the SAME table
-- (no parallel system). The fee is booked on the canonical commission_distributions rail
-- (distribution_type 'referral') by the referral-closer, exactly like revenue share.

alter table public.referrals
  add column if not exists referring_agent_id uuid references public.agents(id) on delete set null,
  add column if not exists referral_fee_pct numeric;

create index if not exists idx_referrals_referring_agent
  on public.referrals (referring_agent_id) where referring_agent_id is not null;
