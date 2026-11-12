-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150EFG ──
--
-- THE SOURCE DISCOVERY PLANNER'S PLANS (wave 150, lane 150EFG; directive lane 150E). One row per plan per territory.
--   WRITER  app/actions/acquisition-plan.ts proposeAcquisitionPlan (status 'proposed') / approveAcquisitionPlan
--           ('approved', the approver + the approved lines + valid_until) — tenant from the SESSION, approver must be a
--           TENANT_COMMERCE_ADMIN seat (may obligate the tenant to pay a vendor).
--   READER  lib/lead-pipeline/pooled-pull.ts productionPooledBatchDataDeps → source-discovery-planner.ts paidPullApproval
--           (the paid pooled BatchData pull refuses a tenant's share without an approved, unexpired line), and the
--           Settings → Territories acquisition panel (getAcquisitionPlanView).
--   lines   jsonb array of PlanLine (source, plays, side, vendor, rights, previewCount, estimatedReach, quoteUsd,
--           expectedNewLeads, expectedBasis, costPerExpectedLead, criteria, status, why, approvedAt, approvedByUserId,
--           maxSpendUsd) — the plan is read and approved as a whole, so its lines live with it.
-- FKs: brokerage_id → brokerages (CASCADE — a plan is the tenant's), territory_id → lead_scraping_markets (SET NULL),
--      created_by_user_id / approved_by_user_id → users (SET NULL). users.id, never agents.id (CLAUDE.md §3).

CREATE TABLE IF NOT EXISTS public.acquisition_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  territory_id        uuid REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  territory_label     text,
  status              text NOT NULL DEFAULT 'proposed',
  budget_usd          numeric(12,2) NOT NULL DEFAULT 0,
  total_quote_usd     numeric(12,2) NOT NULL DEFAULT 0,
  market_mode         text NOT NULL DEFAULT 'unknown',
  tilt                text NOT NULL DEFAULT 'balanced',
  lines               jsonb NOT NULL DEFAULT '[]'::jsonb,
  blind_spots         jsonb NOT NULL DEFAULT '[]'::jsonb,
  planner_version     text NOT NULL,
  created_by_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  valid_until         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_plans_status_check CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  CONSTRAINT acquisition_plans_market_mode_check CHECK (market_mode IN ('hunting', 'farming', 'unknown')),
  CONSTRAINT acquisition_plans_tilt_check CHECK (tilt IN ('seller', 'buyer', 'balanced')),
  -- An approval names who approved it, when, and until when — an approved row without them is not an approval.
  CONSTRAINT acquisition_plans_approval_shape CHECK (
    status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND valid_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_acquisition_plans_brokerage_status ON public.acquisition_plans (brokerage_id, status);
CREATE INDEX IF NOT EXISTS idx_acquisition_plans_territory ON public.acquisition_plans (territory_id) WHERE territory_id IS NOT NULL;

ALTER TABLE public.acquisition_plans ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their own tenant's plans; writes go through the session-gated server actions (service client after
-- the gate — the pattern named at lib/kernel/manager-registry.ts), so no INSERT/UPDATE policy is granted to end users.
DROP POLICY IF EXISTS acquisition_plans_tenant_read ON public.acquisition_plans;
CREATE POLICY acquisition_plans_tenant_read ON public.acquisition_plans
  FOR SELECT USING (brokerage_id = public.current_user_brokerage_id());

COMMENT ON TABLE public.acquisition_plans IS
  'Source Discovery Planner (wave 150, lane 150EFG): per-territory acquisition plans — preview counts, quotes, budget, expected new leads; a paid pooled pull needs an APPROVED unexpired line (source-discovery-planner.ts paidPullApproval).';
