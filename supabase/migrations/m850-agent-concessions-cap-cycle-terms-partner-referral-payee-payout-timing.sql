-- WRITTEN, NOT APPLIED (wave 144, lane 144D) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m850 — AGENT CONCESSIONS · CAP CYCLES FROM THE AGREEMENT · THE OUTSIDE-PARTNER REFERRAL PAYEE · THE PAYOUT GATE
--        (wave 144, lane 144D; owner rulings 4, 5, 8, 9 of 2026-10-25).
--
-- Every column here EXTENDS a survivor; no table is created (CLAUDE.md §1, OS-CONSTITUTION LAW 1). Measured live
-- 2026-10-25 before writing: commission_adjustments 0 rows, commission_distributions 0 rows, agent_commissions 0 rows,
-- referrals 0 rows, agent_cap_tracking 4 rows, agent_commission_profiles 1 row (no royalty, no cap), brokerages 2 rows.
--
-- PART 1 — commission_adjustments becomes the AGENT CONCESSION record (ruling 4). It already held the listing-agreement
--   commission concession (applies_to 'gross', direction 'credit', recipient seller) — which IS an agent concession by the
--   owner's definition: a credit the agent gives the seller, taken off that agent's gross commission. What it lacked:
--   WHICH agent's commission it comes off, the broker-approval state and its evidence, and how it settles. A SELLER
--   concession (seller -> buyer, out of the seller's net) is NOT stored here and never touches commission: its record is
--   the contract term (offers / transactions.closing_cost_contribution) and the seller net sheet.
--   Writer: lib/commission/agent-concession.ts requestAgentConcession / decideAgentConcession / withdrawAgentConcession
--   (reached through app/actions/commission-policy/commission-policy.ts, session tenant) and the existing listing-agreement
--   writer app/actions/seller-listing/execution-engine.ts (approval_status defaults 'not_required' — the seller signed the
--   listing agreement that states it). Reader: lib/commission/waterfall/03-apply-gross-adjustments.ts (the gate).
ALTER TABLE public.commission_adjustments
  ADD COLUMN IF NOT EXISTS concession_agent_id   uuid        NULL REFERENCES public.agents(id),
  ADD COLUMN IF NOT EXISTS approval_status       text        NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approval_decided_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approval_decided_by   uuid        NULL REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS approval_note         text        NULL,
  ADD COLUMN IF NOT EXISTS approval_policy_ref   text        NULL,
  ADD COLUMN IF NOT EXISTS settlement_treatment  text        NULL;

ALTER TABLE public.commission_adjustments DROP CONSTRAINT IF EXISTS commission_adjustments_approval_status_check;
ALTER TABLE public.commission_adjustments ADD CONSTRAINT commission_adjustments_approval_status_check
  CHECK (approval_status IN ('not_required', 'requested', 'approved', 'denied', 'withdrawn'));

ALTER TABLE public.commission_adjustments DROP CONSTRAINT IF EXISTS commission_adjustments_settlement_treatment_check;
ALTER TABLE public.commission_adjustments ADD CONSTRAINT commission_adjustments_settlement_treatment_check
  CHECK (settlement_treatment IN ('reduced_commission_rate', 'closing_statement_credit'));

-- A decision without a decider is not evidence (LAW 5): approved / denied rows name who and when.
ALTER TABLE public.commission_adjustments DROP CONSTRAINT IF EXISTS commission_adjustments_decision_has_decider;
ALTER TABLE public.commission_adjustments ADD CONSTRAINT commission_adjustments_decision_has_decider
  CHECK (approval_status NOT IN ('approved', 'denied') OR (approval_decided_at IS NOT NULL AND approval_decided_by IS NOT NULL));

COMMENT ON COLUMN public.commission_adjustments.concession_agent_id IS
  'The agent whose gross commission the concession comes off (owner ruling 4: "subtracted from THAT agent''s gross commission"). NULL on legacy listing-agreement rows = the deal''s producing agent. The waterfall refuses a final calculation that would charge one agent''s concession to another agent''s commission (m850, wave 144 lane 144D).';
COMMENT ON COLUMN public.commission_adjustments.approval_status IS
  'not_required | requested | approved | denied | withdrawn. A requested concession HOLDS the final commission calculation; denied / withdrawn never apply. Policy: brokerages.agent_concession_approval (m850).';
COMMENT ON COLUMN public.commission_adjustments.settlement_treatment IS
  'reduced_commission_rate (the listing agreement states a lower commission) | closing_statement_credit (a credit to the beneficiary on the closing statement, netted from the commission title disburses). Both reduce the gross the brokerage receives, before the split (m850).';

-- PART 2 — agent_commission_profiles: the CAP CYCLE and the CAP-ELIGIBLE CONTRIBUTIONS come from the agreement (ruling 9).
--   cap_anniversary_date: the agreement's own cap anniversary; NULL = the brokerage's basis (brokerages.default_cap_anniversary_basis)
--   anchored on the agent's seat start date (agents.anniversary_date, else agents.created_at). Never a January 1 reset unless the
--   agreement or the brokerage basis says calendar_year.
--   cap_eligible_contributions: which brokerage contributions count toward (and stop at) the cap. NULL = the brokerage split only
--   (the engine's behaviour before this migration); a royalty or a fee counts ONLY when the agreement lists it.
--   The m812 trigger copies the whole profile row into agent_commission_profile_versions.terms, so both columns are
--   effective-dated with no trigger change. Reader: lib/commission/cap-resolver.ts (capTermsFromAgreement), stages 07 / 10 / 11.
ALTER TABLE public.agent_commission_profiles
  ADD COLUMN IF NOT EXISTS cap_anniversary_date       date   NULL,
  ADD COLUMN IF NOT EXISTS cap_eligible_contributions text[] NULL;

ALTER TABLE public.agent_commission_profiles DROP CONSTRAINT IF EXISTS agent_commission_profiles_cap_eligible_contributions_check;
ALTER TABLE public.agent_commission_profiles ADD CONSTRAINT agent_commission_profiles_cap_eligible_contributions_check
  CHECK (cap_eligible_contributions <@ ARRAY['brokerage_split', 'transaction_fee', 'desk_fee', 'technology_fee', 'eo_fee', 'royalty']::text[]);

-- PART 3 — commission_distributions: the OUTSIDE-PARTNER referral payee (ruling 5) + seller concessions never fund commission (ruling 4).
--   A referral fee to an agent OUTSIDE the brokerage is payable to the partner of record (referral_partners, the canonical
--   PARTNER bucket) — never to an agents row, so the payee is its own column and a row names exactly one payee.
ALTER TABLE public.commission_distributions
  ADD COLUMN IF NOT EXISTS referral_partner_id uuid NULL REFERENCES public.referral_partners(id);

ALTER TABLE public.commission_distributions DROP CONSTRAINT IF EXISTS commission_distributions_partner_payee_check;
ALTER TABLE public.commission_distributions ADD CONSTRAINT commission_distributions_partner_payee_check
  CHECK (referral_partner_id IS NULL OR (distribution_type = 'referral' AND agent_id IS NULL));

-- 'seller_concession' as a SOURCE OF COMMISSION FUNDS is the conflation ruling 4 forbids: a seller concession is the seller's
-- money to the buyer out of the seller's net, never money that funds a commission line. Zero live rows carry it and no code
-- writes it (lib/commission/types.ts no longer admits it); the narrowing refuses rather than rewrites if a row appeared.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.commission_distributions WHERE source_of_funds = 'seller_concession') THEN
    RAISE EXCEPTION 'm850: commission_distributions rows carry source_of_funds=seller_concession — a seller concession funding a commission line; resolve them by hand before narrowing';
  END IF;
END $$;
ALTER TABLE public.commission_distributions DROP CONSTRAINT IF EXISTS commission_distributions_source_of_funds_check;
ALTER TABLE public.commission_distributions ADD CONSTRAINT commission_distributions_source_of_funds_check
  CHECK (source_of_funds IN ('brokerage', 'agent', 'buyer'));

CREATE INDEX IF NOT EXISTS commission_distributions_referral_partner_idx
  ON public.commission_distributions (referral_partner_id) WHERE referral_partner_id IS NOT NULL;

-- PART 4 — brokerages: the PAYOUT GATE and the CONCESSION-APPROVAL policy (rulings 8 and 4) beside offers_cda /
--   non_cda_payout_default, the finance settings that already live on this row (UPDATE policy is_brokerage_finance_admin()).
--   commission_payout_timing NULL = undeclared -> after_brokerage_receipt (the funds-received gate; never an invented
--   closing-time release). at_closing_per_cda is honoured only while offers_cda is true.
--   agent_concession_approval NULL = undeclared -> broker_approval_required (fail closed: a concession reduces the
--   brokerage's share too, so an unanswered setting never lets an agent commit one alone).
--   Writer: app/actions/commission-policy/commission-policy.ts setCommissionPayoutPolicyAction (finance admin, session tenant,
--   ledgered). Readers: lib/transactions/cda-closing-policy.ts resolvePayoutTiming, lib/commission/agent-concession.ts.
ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS commission_payout_timing  text NULL,
  ADD COLUMN IF NOT EXISTS agent_concession_approval text NULL;

ALTER TABLE public.brokerages DROP CONSTRAINT IF EXISTS brokerages_commission_payout_timing_check;
ALTER TABLE public.brokerages ADD CONSTRAINT brokerages_commission_payout_timing_check
  CHECK (commission_payout_timing IN ('at_closing_per_cda', 'after_brokerage_receipt'));

ALTER TABLE public.brokerages DROP CONSTRAINT IF EXISTS brokerages_agent_concession_approval_check;
ALTER TABLE public.brokerages ADD CONSTRAINT brokerages_agent_concession_approval_check
  CHECK (agent_concession_approval IN ('broker_approval_required', 'no_approval_required'));

-- POSTCONDITIONS — refuse to report success on a half-applied migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commission_adjustments' AND column_name = 'approval_status') THEN
    RAISE EXCEPTION 'm850: commission_adjustments.approval_status missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_commission_profiles' AND column_name = 'cap_anniversary_date') THEN
    RAISE EXCEPTION 'm850: agent_commission_profiles.cap_anniversary_date missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commission_distributions' AND column_name = 'referral_partner_id') THEN
    RAISE EXCEPTION 'm850: commission_distributions.referral_partner_id missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'brokerages' AND column_name = 'commission_payout_timing') THEN
    RAISE EXCEPTION 'm850: brokerages.commission_payout_timing missing';
  END IF;
END $$;

-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts (three new FKs: commission_adjustments
-- .concession_agent_id -> agents, .approval_decided_by -> users, commission_distributions.referral_partner_id ->
-- referral_partners) and scripts/check-vocabularies.ts (new CHECKs: commission_adjustments.approval_status /
-- settlement_treatment, brokerages.commission_payout_timing / agent_concession_approval; NARROWED
-- commission_distributions.source_of_funds). Then flip line 1 to the APPLIED LIVE stamp.
