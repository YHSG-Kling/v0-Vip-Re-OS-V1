-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- SKILL REGISTRY EXPANSION + AGENT/SKILL MARKETPLACE (wave 108, lane 108A). OWNER LAWS 1/2/3/4/5.
-- Additive only — ONE new table, no existing table altered, no existing CHECK widened.
--
-- A marketplace skill is DATA, never code: a declaration (lib/kernel/skill-registry.ts SkillDeclaration)
-- that COMPOSES registered APP_CAPABILITY_REGISTRY keys owned by its manager, and runs only through the
-- kernel (lib/kernel/skill-marketplace.ts runSkill → mayUseAndAfford → resolveAgentAuthorityLevel →
-- withActionLedger → requestDelegation to the owning manager).
--
-- SURVIVORS EVALUATED (the lane notes carry the audit) — none fits the lifecycle without a rewrite:
--   · template_marketplace — playbook TEMPLATES: author-cloned into plan_tasks (app/actions/academy.ts),
--     visibility-only vocabulary (private | brokerage_only | global), no publisher class, no evaluation
--     evidence, no approval state; a skill row there would surface in the academy clone list unapproved;
--   · strategy_library (m725) — the plan ABOVE managers, platform | tenant tiers, IMMUTABLE once published
--     (its trigger forbids the status moves an approval lifecycle needs); no third_party publisher;
--   · improvement_proposals (m709) — a learning proposal about an existing subject (prompt / policy / …),
--     tenant-scoped, not a publishable catalogue entry;
--   · brokerage_settings.settings.ai_agent_capabilities custom tools (lib/ai-isa/capability-catalogue.ts) —
--     tenant-private, customer-care persona tools, no approval lifecycle (kept; not a manager skill).
--
-- WRITERS: lib/kernel/skill-marketplace.ts ONLY (service client, behind the session gates in
-- app/actions/skill-marketplace.ts). READERS: same module (resolveRunnableSkill, listVisibleSkillListings).
--
-- Two parts so it can be applied in two small calls: PART A table + RLS, PART B indexes + triggers.

-- ══════════════════════════════ PART A — table, RLS ══════════════════════════════
CREATE TABLE IF NOT EXISTS public.skill_marketplace_listings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id             text NOT NULL,
  publisher            text NOT NULL,
  publisher_name       text,
  brokerage_id         uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  declaration          jsonb NOT NULL,
  declaration_digest   text NOT NULL,
  status               text NOT NULL DEFAULT 'submitted',
  evaluation_evidence  jsonb,
  evaluated_at         timestamptz,
  submitted_by         uuid,
  approved_by          uuid,
  approved_at          timestamptz,
  published_at         timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_marketplace_listings_publisher_check CHECK (publisher IN ('platform', 'tenant', 'third_party')),
  CONSTRAINT skill_marketplace_listings_status_check CHECK (status IN ('submitted', 'evaluated', 'approved', 'published', 'revoked', 'rejected')),
  CONSTRAINT skill_marketplace_listings_tenant_shape_check CHECK ((publisher = 'tenant' AND brokerage_id IS NOT NULL) OR (publisher <> 'tenant' AND brokerage_id IS NULL)),
  CONSTRAINT skill_marketplace_listings_version_check CHECK (version >= 1),
  CONSTRAINT skill_marketplace_listings_skill_id_check CHECK (skill_id ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT skill_marketplace_listings_revoked_shape_check CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

ALTER TABLE public.skill_marketplace_listings ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.skill_marketplace_listings FROM anon, authenticated;

-- A PUBLISHED platform / third-party skill is readable by every signed-in tenant; a tenant-authored row
-- (any status) by its own brokerage only; platform staff read everything (approval queue).
DROP POLICY IF EXISTS skill_marketplace_listings_select ON public.skill_marketplace_listings;
CREATE POLICY skill_marketplace_listings_select ON public.skill_marketplace_listings
  FOR SELECT TO authenticated
  USING (
    is_platform_admin()
    OR (publisher <> 'tenant' AND status = 'published')
    OR (publisher = 'tenant' AND has_brokerage_access(brokerage_id))
  );

COMMENT ON TABLE public.skill_marketplace_listings IS
  'Agent/skill MARKETPLACE (wave 108, lane 108A): one row per submitted skill VERSION. declaration = a lib/kernel/skill-registry.ts SkillDeclaration (DATA — composes registered app capabilities owned by manager_owner; never code). status submitted → evaluated → approved → published → revoked (rejected when the evaluation suite fails). third_party / platform rows are approved by platform staff; tenant rows by a tenant admin of that brokerage only. Written ONLY by lib/kernel/skill-marketplace.ts; the declaration is immutable after submission.';

-- ══════════════════════════════ PART B — indexes, triggers ══════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_marketplace_listings_global_version ON public.skill_marketplace_listings (skill_id, version) WHERE publisher <> 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_marketplace_listings_tenant_version ON public.skill_marketplace_listings (brokerage_id, skill_id, version) WHERE publisher = 'tenant';
CREATE INDEX IF NOT EXISTS idx_skill_marketplace_listings_status ON public.skill_marketplace_listings (status, skill_id);

CREATE OR REPLACE FUNCTION public.skill_marketplace_listings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.declaration IS DISTINCT FROM OLD.declaration
     OR NEW.declaration_digest IS DISTINCT FROM OLD.declaration_digest
     OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.publisher IS DISTINCT FROM OLD.publisher
     OR NEW.brokerage_id IS DISTINCT FROM OLD.brokerage_id THEN
    RAISE EXCEPTION 'skill_marketplace_listings: a submitted declaration is immutable (% v%) — submit a new version', OLD.skill_id, OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS skill_marketplace_listings_guard ON public.skill_marketplace_listings;
CREATE TRIGGER skill_marketplace_listings_guard
  BEFORE UPDATE ON public.skill_marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION public.skill_marketplace_listings_guard();
