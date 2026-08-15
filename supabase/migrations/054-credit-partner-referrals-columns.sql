-- =====================================================
-- MIGRATION 054: extend credit_partner_referrals to match callers
-- =====================================================
-- credit_partner_referrals (plural) exists in the schema but is missing
-- five columns the actual callers in app/actions/credit-copilot.ts use:
--   partner_id, referring_agent_id, referral_notes, expected_timeline,
--   referred_at.
-- The current table has partner_name (text) for the legacy single-string
-- case; we keep it for back-compat, but the real callers reference
-- partner_id (UUID FK→vendors / referral_partners) and a distinct
-- referring_agent_id (vs the brokerage's own agent_id field).
--
-- Code update lands in the same commit: "credit_partner_referral"
-- (singular) → "credit_partner_referrals" (plural) at 2 callsites.
-- =====================================================

ALTER TABLE public.credit_partner_referrals
  ADD COLUMN IF NOT EXISTS partner_id          UUID
    REFERENCES public.referral_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referring_agent_id  UUID
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_notes      TEXT,
  ADD COLUMN IF NOT EXISTS expected_timeline   TEXT,
  ADD COLUMN IF NOT EXISTS referred_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_credit_partner_referrals_partner
  ON public.credit_partner_referrals (partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_partner_referrals_agent
  ON public.credit_partner_referrals (referring_agent_id) WHERE referring_agent_id IS NOT NULL;
