-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m731 — CONTROLLED AUTONOMOUS BUDGETING + AUTONOMOUS EXPERIMENTATION (wave 108, lane 108F).
-- Owner: "explicit envelopes … Finance watches all; no unlimited AI spend" + "proposal → historical replay →
-- policy/risk → budget → cohort → measure → statistical evaluation → promote/reject; humans control which
-- experiment classes may deploy autonomously."
--
-- SURVIVORS EVALUATED (live, 2026-10-07): tier_budgets (channel default per tier), budgets (an agent's income
-- plan), agent_credit_budgets (agent credits) — none is a per-manager autonomy envelope; the per-action caps
-- (resource_allocation / procurement_autonomy / MAX_AD_DAILY_BUDGET_USD) have NO period total and nothing atomic.
-- improvement_proposals (m709/m721/m726) is the ONE proposal object — experiments ride it (no second table).
--
-- PART A — the envelope ledger + the ATOMIC consume (pg_advisory_xact_lock per tenant+envelope, sum, refuse
--          over-cap, insert — one transaction). Writer: lib/kernel/autonomy-budgets.ts consumeAutonomyEnvelope
--          (RPC) / releaseAutonomyEnvelope (status → released). Reader: buildAutonomyBudgetReport (Finance).
-- PART B — improvement_proposals CHECK widening, the SUPERSET of m726 (+ subject_kind 'experiment',
--          + proposer 'experimentation'). If another wave-108 lane widens the same CHECKs, the integrator restates
--          the union in the HIGHEST-numbered migration (latest-definer rule).
-- AFTER APPLYING: add autonomy_budget_consumptions to scripts/live-tables.ts + schema-snapshot (delta regen),
-- regenerate scripts/check-vocabularies.ts, restamp line 1.

-- ══════════════════════════════ PART A — envelope ledger ══════════════════════════════
CREATE TABLE IF NOT EXISTS public.autonomy_budget_consumptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  envelope       text NOT NULL,
  period_key     text NOT NULL,
  scope_key      text NOT NULL DEFAULT 'all',
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  unit           text NOT NULL,
  period_cap     numeric(12,2),
  scope_cap      numeric(12,2),
  manager        text,
  policy_ref     text,
  reason         text,
  status         text NOT NULL DEFAULT 'consumed',
  released_at    timestamptz,
  release_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autonomy_budget_consumptions_envelope_check CHECK (envelope IN ('ads_budget_shift', 'provider_high_value', 'asset_renders', 'recruiting_prospect_data', 'experiment_budget', 'procurement_auto_book')),
  CONSTRAINT autonomy_budget_consumptions_unit_check CHECK (unit IN ('usd', 'renders')),
  CONSTRAINT autonomy_budget_consumptions_status_check CHECK (status IN ('consumed', 'released')),
  CONSTRAINT autonomy_budget_consumptions_has_cap CHECK (period_cap IS NOT NULL OR scope_cap IS NOT NULL)
);

ALTER TABLE public.autonomy_budget_consumptions ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.autonomy_budget_consumptions FROM anon, authenticated;
DROP POLICY IF EXISTS autonomy_budget_consumptions_select ON public.autonomy_budget_consumptions;
CREATE POLICY autonomy_budget_consumptions_select ON public.autonomy_budget_consumptions
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.autonomy_budget_consumptions IS
  'm731 (wave 108F): one row per AUTONOMOUS spend authorised against a tenant envelope (autonomy_budgets policy key). Written ONLY by public.consume_autonomy_budget (lib/kernel/autonomy-budgets.ts consumeAutonomyEnvelope — the one enforcement function) and released by releaseAutonomyEnvelope. Read by buildAutonomyBudgetReport (Finance Manager daily report). The spend itself books its cost on its own ledger row; amount here is the envelope draw.';

CREATE OR REPLACE FUNCTION public.consume_autonomy_budget(
  p_brokerage_id uuid, p_envelope text, p_period_key text, p_scope_key text, p_amount numeric, p_unit text,
  p_period_cap numeric, p_scope_cap numeric, p_manager text, p_policy_ref text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_period numeric := 0;
  v_scope  numeric := 0;
  v_id     uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount must be positive');
  END IF;
  IF p_period_cap IS NULL AND p_scope_cap IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'an envelope always has a cap — refused');
  END IF;
  -- ONE consumer at a time per tenant + envelope: the sum and the insert are atomic.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_brokerage_id::text || ':' || p_envelope, 731));
  SELECT coalesce(sum(amount), 0) INTO v_period FROM public.autonomy_budget_consumptions
   WHERE brokerage_id = p_brokerage_id AND envelope = p_envelope AND period_key = p_period_key AND status = 'consumed';
  IF p_period_cap IS NOT NULL AND v_period + p_amount > p_period_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'period cap', 'period_consumed', v_period, 'period_cap', p_period_cap);
  END IF;
  IF p_scope_cap IS NOT NULL THEN
    SELECT coalesce(sum(amount), 0) INTO v_scope FROM public.autonomy_budget_consumptions
     WHERE brokerage_id = p_brokerage_id AND envelope = p_envelope AND period_key = p_period_key AND scope_key = p_scope_key AND status = 'consumed';
    IF v_scope + p_amount > p_scope_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'scope cap', 'scope_consumed', v_scope, 'scope_cap', p_scope_cap);
    END IF;
  END IF;
  INSERT INTO public.autonomy_budget_consumptions (brokerage_id, envelope, period_key, scope_key, amount, unit, period_cap, scope_cap, manager, policy_ref, reason)
  VALUES (p_brokerage_id, p_envelope, p_period_key, coalesce(p_scope_key, 'all'), p_amount, p_unit, p_period_cap, p_scope_cap, p_manager, p_policy_ref, left(p_reason, 500))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'period_consumed', v_period + p_amount, 'scope_consumed', v_scope + p_amount);
END
$fn$;

REVOKE ALL ON FUNCTION public.consume_autonomy_budget(uuid, text, text, text, numeric, text, numeric, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_autonomy_budget(uuid, text, text, text, numeric, text, numeric, numeric, text, text, text) TO service_role;

CREATE INDEX IF NOT EXISTS autonomy_budget_consumptions_period_idx ON public.autonomy_budget_consumptions (brokerage_id, envelope, period_key) WHERE status = 'consumed';
CREATE INDEX IF NOT EXISTS autonomy_budget_consumptions_created_idx ON public.autonomy_budget_consumptions (brokerage_id, created_at DESC);

-- ══════════════════════════════ PART B — proposal vocabulary (superset of m726) ══════════════════════════════
ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_subject_kind_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_subject_kind_check
  CHECK (subject_kind IN ('policy', 'prompt', 'variant', 'threshold', 'allocation', 'strategy', 'experiment'));

ALTER TABLE public.improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_proposer_check;
ALTER TABLE public.improvement_proposals ADD CONSTRAINT improvement_proposals_proposer_check
  CHECK (proposer IN ('copy_learning', 'predictor_learning', 'prompt_calibrator', 'outcome_autopsy', 'human', 'media_intelligence', 'resource_allocation', 'strategy_learning', 'experimentation'));
