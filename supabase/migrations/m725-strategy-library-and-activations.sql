-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- STRATEGY ENGINE + PLATFORM STRATEGY LIBRARY (wave 107, lane 107E; owner: "Managers should stop inventing
-- every plan from scratch" + "VIPAgents Seller Reactivation v12 … the local OS adapts it to tenant policy and
-- history"). OWNER LAWS 1/2/4/5. Additive only — two NEW tables, no existing table altered.
--
-- SURVIVORS EVALUATED (the lane notes carry the audit): no playbook / strategy TABLE fits —
--   · strategy_recommendations / strategy_outcomes / offer_strategy_templates / negotiation_strategies are the
--     per-OFFER negotiation strategy (price, contingencies, counter) — a different object;
--   · campaign_sequences is ONE channel sequence (steps, enrollments) — a strategy REFERENCES sequences by their
--     persona / type vocabulary, it is not one;
--   · missions (m710) is the per-subject RUN a strategy becomes (activateStrategy) — not the reusable plan;
--   · improvement_proposals (m709) is the learning proposal object 107F records findings on.
-- So the missing half is BUILT: strategy_library (the versioned plan, platform + tenant tiers) and
-- strategy_activations (a tenant's activation of a version + its RECORDED local adaptation).
--
-- WRITERS: lib/kernel/strategy-engine.ts ONLY (service client): ensurePlatformVersionPublished (insert-only,
-- digest-verified) and activateLibraryStrategy. Tenants READ: platform rows (all tenants) + their own rows.
-- A published version is IMMUTABLE: an UPDATE may only stamp retired_at; a platform row is never deleted.
--
-- Two parts so it can be applied in two small calls: PART A tables + RLS, PART B indexes + triggers.

-- ══════════════════════════════ PART A — tables, RLS ══════════════════════════════
CREATE TABLE IF NOT EXISTS public.strategy_library (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier              text NOT NULL,
  brokerage_id      uuid NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  strategy_key      text NOT NULL,
  version           integer NOT NULL,
  title             text NOT NULL,
  definition        jsonb NOT NULL,
  definition_digest text NOT NULL,
  published_at      timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_library_tier_check CHECK (tier IN ('platform', 'tenant')),
  CONSTRAINT strategy_library_tier_tenant_check CHECK ((tier = 'platform' AND brokerage_id IS NULL) OR (tier = 'tenant' AND brokerage_id IS NOT NULL)),
  CONSTRAINT strategy_library_version_check CHECK (version >= 1),
  CONSTRAINT strategy_library_key_check CHECK (strategy_key ~ '^[a-z][a-z0-9_]*$')
);

CREATE TABLE IF NOT EXISTS public.strategy_activations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  strategy_key        text NOT NULL,
  version             integer NOT NULL,
  tier                text NOT NULL,
  library_id          uuid NULL REFERENCES public.strategy_library(id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'active',
  adaptation          jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapted_from_digest text NOT NULL,
  activated_by        uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deactivated_at      timestamptz NULL,
  CONSTRAINT strategy_activations_status_check CHECK (status IN ('active', 'superseded', 'deactivated')),
  CONSTRAINT strategy_activations_tier_check CHECK (tier IN ('platform', 'tenant')),
  CONSTRAINT strategy_activations_version_check CHECK (version >= 1)
);

ALTER TABLE public.strategy_library     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.strategy_activations ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.strategy_library     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.strategy_activations FROM anon, authenticated;

-- Platform tier is readable by every signed-in tenant; tenant tier by its own brokerage only.
DROP POLICY IF EXISTS strategy_library_select ON public.strategy_library;
CREATE POLICY strategy_library_select ON public.strategy_library
  FOR SELECT TO authenticated
  USING (tier = 'platform' OR is_platform_admin() OR has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS strategy_activations_select ON public.strategy_activations;
CREATE POLICY strategy_activations_select ON public.strategy_activations
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.strategy_library IS
  'Reusable STRATEGIES (wave 107, lane 107E): one row per published version. tier platform (brokerage_id NULL, readable by all tenants) = the VIPAgents library, published insert-only from lib/kernel/strategy-library.ts PLATFORM_STRATEGY_LIBRARY by lib/kernel/strategy-engine.ts with definition_digest = strategyDigest(definition); tier tenant = a brokerage''s own. IMMUTABLE once published: UPDATE may only set retired_at; a platform row is never deleted.';
COMMENT ON TABLE public.strategy_activations IS
  'A tenant ACTIVATES a strategy version (wave 107, lane 107E): adaptation = the RECORDED local adaptation (tenant policy strategy_overrides → budget / authority / timing; tenant history → eligibility thresholds) with every change and its source; adapted_from_digest = the version digest it adapted. One active row per (brokerage, strategy_key); a re-activation supersedes. Written ONLY by lib/kernel/strategy-engine.ts activateLibraryStrategy.';

-- ══════════════════════════════ PART B — indexes, triggers ══════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_library_platform_version ON public.strategy_library (strategy_key, version) WHERE tier = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_library_tenant_version   ON public.strategy_library (brokerage_id, strategy_key, version) WHERE tier = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_activations_one_active   ON public.strategy_activations (brokerage_id, strategy_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_strategy_activations_tenant_status      ON public.strategy_activations (brokerage_id, status);
CREATE INDEX IF NOT EXISTS idx_strategy_activations_library            ON public.strategy_activations (library_id) WHERE library_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.strategy_library_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.tier = 'platform' THEN
      RAISE EXCEPTION 'strategy_library: a published platform version is never deleted (% v%)', OLD.strategy_key, OLD.version
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.definition_digest IS DISTINCT FROM OLD.definition_digest
     OR NEW.strategy_key IS DISTINCT FROM OLD.strategy_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.brokerage_id IS DISTINCT FROM OLD.brokerage_id
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'strategy_library: a published version is immutable (% v%) — publish a new version instead', OLD.strategy_key, OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strategy_library_immutable ON public.strategy_library;
CREATE TRIGGER strategy_library_immutable
  BEFORE UPDATE OR DELETE ON public.strategy_library
  FOR EACH ROW EXECUTE FUNCTION public.strategy_library_immutable();

CREATE OR REPLACE FUNCTION public.strategy_activations_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strategy_activations_touch_updated_at ON public.strategy_activations;
CREATE TRIGGER strategy_activations_touch_updated_at
  BEFORE UPDATE ON public.strategy_activations
  FOR EACH ROW EXECUTE FUNCTION public.strategy_activations_touch_updated_at();
