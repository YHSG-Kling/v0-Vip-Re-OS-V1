-- ── APPLIED LIVE 2026-10-03 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) — as m692a (reason CHECK) + m692b (backfill: VIP Premier Realty → brokerage, Your Brokerage → team, both active) ──
--
-- m692 — wave 99A: fail-closed SaaS access + the trial/renewal lifecycle.
--
-- APPLY THIS BEFORE THE 99A CODE SHIPS. lib/billing/billing-access.ts now REFUSES a brokerage
-- with no subscriptions row (owner, wave 99: "no subscription row … means refused"). Live on
-- 2026-10-03 BOTH brokerages had no row (2 of 2, 23 users between them) — without PART 2 the
-- proxy paywall would route every non-staff user of both tenants to /dashboard/admin/billing.
-- Pre-check (expect the rows PART 2 will insert):
--   select b.id, b.name, b.plan_tier from brokerages b
--   where not exists (select 1 from subscriptions s where s.brokerage_id = b.id);
--
-- ── PART 1 — agent_action_ledger reason vocabulary gains SUBSCRIPTION_LIFECYCLE ──────────────
-- lib/billing/stripe-subscription-ops.ts runSubscriptionLifecycleSweep ledgers each trial it
-- converts or pauses under this reason (LAW 5). Code vocabulary: lib/kernel/action-ledger.ts
-- ACTION_REASON_CODES (scripts/action-ledger-guard.ts holds the two lists equal against the
-- LATEST defining migration). Until applied, those claims are refused (23514) and the sweep
-- reports the error rather than moving the row — fail closed, nothing moves unledgered.
ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'SUBSCRIPTION_LIFECYCLE', 'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'UNSPECIFIED'));

-- ── PART 2 — an explicit subscription row for every brokerage that predates the writer ──────
-- Data only, no schema change. Status 'active' with NO stripe_subscription_id = a comped /
-- staff-provisioned tenant: the Stripe reconcile (seat-sync) skips it (no Stripe link), the
-- lifecycle sweep sends it no renewal notice (renewals need a Stripe link), and an owner who
-- wants it billed runs the existing activation checkout. Tier from brokerages.plan_tier,
-- falling back to the entry tier; a brokerage whose tier cannot be resolved is NOT inserted
-- (tier_id is NOT NULL) and stays refused — re-run the pre-check above to see any such row.
INSERT INTO public.subscriptions (brokerage_id, tier_id, status, created_at, updated_at)
SELECT b.id,
       COALESCE(t.id, solo.id),
       'active',
       now(), now()
FROM public.brokerages b
LEFT JOIN public.subscription_tiers t    ON t.tier_name = b.plan_tier
LEFT JOIN public.subscription_tiers solo ON solo.tier_name = 'solo_agent'
WHERE NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.brokerage_id = b.id)
  AND COALESCE(t.id, solo.id) IS NOT NULL
RETURNING id, brokerage_id, tier_id, status;
