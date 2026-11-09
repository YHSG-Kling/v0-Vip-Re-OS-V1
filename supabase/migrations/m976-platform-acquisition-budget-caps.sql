-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151F ──
--
-- m976 — THE PLATFORM'S INTERNAL ACQUISITION BUDGET CAPS (wave 151, lane 151F; directive 151F: "The platform may use a small
-- controlled internal acquisition budget … 'Small' is not an authorized dollar amount: implement owner-configurable caps and
-- stop-before-spend approvals, not made-up defaults.").
--
-- SURVIVOR EXTENDED (no new table): one jsonb column on the platform_settings SINGLETON, beside self_healing_ceilings (m753 —
-- the same idiom). Reader: lib/vendor-governance/platform-acquisition-caps.ts loadPlatformAcquisitionCaps → platformCapRemainingFor,
-- consumed by decideSpendBackpressure (budget-eval.ts `platformCapRemainingUsd`) on the existing paid-pull path. Writer:
-- setPlatformAcquisitionCaps, called only by app/actions/superadmin/platform-controls.ts setAcquisitionCapsAction (superadmin,
-- superadmin_audit_log).
--
-- NULL = NO CAP SET = STOP BEFORE SPEND. Unlike m753 there is NO code default behind a null: a platform-paid acquisition want
-- is REFUSED until the owner writes every cap. Before this is applied the reader sees 42703 / PGRST204 and reports "not applied"
-- — the backpressure decision refuses exactly as for a null cap (said, never silently).
--
-- Shape (validated in code by validateAcquisitionCapsEdit; the CHECK pins only that it is an object or NULL):
--   { monthly_usd, per_tenant_monthly_usd, per_pull_usd, set_by, set_at }   — each cap a number ≥ 0 or null

-- PART 1 — the column.
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS acquisition_budget_caps jsonb;

-- PART 2 — the shape pin (an object or NULL; never a scalar / array that would read as "a cap").
ALTER TABLE public.platform_settings DROP CONSTRAINT IF EXISTS platform_settings_acquisition_budget_caps_object_check;
ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_acquisition_budget_caps_object_check
  CHECK (acquisition_budget_caps IS NULL OR jsonb_typeof(acquisition_budget_caps) = 'object');

COMMENT ON COLUMN public.platform_settings.acquisition_budget_caps IS
  'Wave 151F: owner-configurable caps on the platform''s own acquisition spend (lib/vendor-governance/platform-acquisition-caps.ts). NULL or any null field = stop before spend; no default exists.';
