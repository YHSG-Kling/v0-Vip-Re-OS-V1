-- ── APPLIED LIVE 2026-11-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 153, lane 153A ── read back: legacy rate columns nullable with no default; assumptions + assumption_history with object/array checks
--
-- ESTIMATED QUARTERLY TAXES: NO DEFAULT RATE — THE USER (OR THEIR ACCOUNTANT) ENTERS IT, WITH ITS SOURCE.
--
-- Owner ruling (2026-11-14, verbatim): "make sure estimate quarterly taxes work (if we cant determine their tax
-- percentages, then the user can enter that in)". Directive §153A A2: "Do not default to an arbitrary rate or suggest a
-- personal tax rate as fact"; expose "period, source and last-updated date".
--
-- WHAT EXISTS (live 2026-11-14, SELECT only): agent_tax_profile (UNIQUE agent_id, tax_year) with
--   estimated_effective_rate numeric NOT NULL DEFAULT 0.12   ← the database itself invents a 12% income-tax rate
--   set_aside_percent        numeric NOT NULL DEFAULT 25     ← and a 25% set-aside, for anyone who never chose one
--   quarterly_payments jsonb NOT NULL DEFAULT '[]'
-- Rows live: 0. The application layer repeated both defaults (app/actions/tax-planning.ts, the concierge), so every
-- reminder quoted a liability computed from a rate nobody entered.
--
-- WHAT THIS CHANGES
--   1. The two invented defaults go, and both columns become NULLABLE: NULL = "not entered". They are now LEGACY — the
--      estimator reads `assumptions` only and never writes them (so a profile saved before this migration is applied
--      still inserts: the old defaults fill the legacy columns and are never read).
--   2. assumptions jsonb — the user/accountant-entered inputs, each carrying value, source (self_entered |
--      accountant_supplied), period (the tax year, or a quarter for an accountant target), updated_at, updated_by and a
--      version. Parsed by ONE function (lib/finance/tax-planning.ts parseTaxAssumptions); the vocabulary lives there.
--   3. assumption_history jsonb — append-only: every change appends the PRIOR value with its version, so a changed
--      assumption reforecasts without rewriting what was recorded (quarterly_payments is likewise append-only in code).
--
-- READERS: app/actions/tax-planning.ts getTaxPlanAction, lib/finance/quarterly-tax-concierge.ts. WRITER:
-- app/actions/tax-planning.ts saveTaxAssumptionsAction (session agent + tenant only).
--
-- ROLLBACK: ALTER TABLE public.agent_tax_profile ALTER COLUMN estimated_effective_rate SET DEFAULT 0.12;
--           ALTER TABLE public.agent_tax_profile ALTER COLUMN set_aside_percent SET DEFAULT 25;
--           UPDATE public.agent_tax_profile SET estimated_effective_rate = 0.12 WHERE estimated_effective_rate IS NULL;
--           UPDATE public.agent_tax_profile SET set_aside_percent = 25 WHERE set_aside_percent IS NULL;
--           ALTER TABLE public.agent_tax_profile ALTER COLUMN estimated_effective_rate SET NOT NULL;
--           ALTER TABLE public.agent_tax_profile ALTER COLUMN set_aside_percent SET NOT NULL;
--           then (owner SQL — DROP COLUMN) ALTER TABLE public.agent_tax_profile DROP COLUMN assumptions, DROP COLUMN assumption_history;

BEGIN;

ALTER TABLE public.agent_tax_profile ALTER COLUMN estimated_effective_rate DROP DEFAULT;
ALTER TABLE public.agent_tax_profile ALTER COLUMN estimated_effective_rate DROP NOT NULL;
ALTER TABLE public.agent_tax_profile ALTER COLUMN set_aside_percent DROP DEFAULT;
ALTER TABLE public.agent_tax_profile ALTER COLUMN set_aside_percent DROP NOT NULL;

ALTER TABLE public.agent_tax_profile
  ADD COLUMN IF NOT EXISTS assumptions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.agent_tax_profile
  ADD COLUMN IF NOT EXISTS assumption_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.agent_tax_profile DROP CONSTRAINT IF EXISTS agent_tax_profile_assumptions_object_chk;
ALTER TABLE public.agent_tax_profile
  ADD CONSTRAINT agent_tax_profile_assumptions_object_chk CHECK (jsonb_typeof(assumptions) = 'object');
ALTER TABLE public.agent_tax_profile DROP CONSTRAINT IF EXISTS agent_tax_profile_assumption_history_array_chk;
ALTER TABLE public.agent_tax_profile
  ADD CONSTRAINT agent_tax_profile_assumption_history_array_chk CHECK (jsonb_typeof(assumption_history) = 'array');

COMMENT ON COLUMN public.agent_tax_profile.estimated_effective_rate IS
  'LEGACY (m901): no longer read or written by the estimator; NULL = never entered. The rate lives in assumptions.federal_rate / state_rate.';
COMMENT ON COLUMN public.agent_tax_profile.set_aside_percent IS
  'LEGACY (m901): no longer read or written by the estimator; NULL = never entered.';
COMMENT ON COLUMN public.agent_tax_profile.assumptions IS
  'Wave 153 (lane 153A, m901): user/accountant-entered tax inputs, each {value, source, period, updated_at, updated_by, version}. No default rate exists; an absent input means "needs input". Parsed by lib/finance/tax-planning.ts parseTaxAssumptions.';
COMMENT ON COLUMN public.agent_tax_profile.assumption_history IS
  'Wave 153 (lane 153A, m901): append-only prior values of assumptions (key, prior value, version, replaced_at, replaced_by).';

COMMIT;
