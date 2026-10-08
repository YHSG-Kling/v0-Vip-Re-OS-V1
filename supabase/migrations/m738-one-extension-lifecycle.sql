-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- ONE EXTENSION LIFECYCLE (wave 137, lane 137D). OWNER LAWS 1/2/5 + the wave-137 CONSTITUTION.
-- EXTENDS the survivor table skill_marketplace_listings (m727, 0 live rows at 137D's audit) — no new table:
--   · extension_kind  skill | strategy | provider_adapter | custom_manager | webhook_app
--   · status          ONE vocabulary: draft → validated → approved → enabled → suspended → deprecated → disabled
--                     TOMBSTONE (m727 names, retired here): submitted → draft · evaluated → validated ·
--                     approved → approved · published → enabled · revoked → disabled · rejected → disabled.
--                     SURVIVOR: lib/kernel/skill-registry.ts EXTENSION_STATUSES.
--   · published_at → enabled_at, revoked_at → disabled_at, revoked_reason → disabled_reason (renamed: one
--     vocabulary for the kill switch); suspended_at / suspended_reason / deprecated_at added.
-- The kill switch is SUSPENDED / DISABLED — a status move, never a DELETE: the declaration, its digest and the
-- evaluation evidence stay (the m727 immutability trigger, extended here to extension_kind).
-- Per-tenant ENABLEMENT of a global extension is NOT a column: it is the versioned tenant policy key
-- `extensions` (brokerage_settings.settings, lib/kernel/tenant-policy.ts) — written by mergeBrokerageSettings →
-- appendTenantPolicyVersion, so every enable / disable carries who, when and the previous value.
-- Writers: lib/kernel/skill-marketplace.ts ONLY. After applying: regenerate check-vocabularies.ts,
-- schema-snapshot.ts, live-tables.ts (CLAUDE.md §3).
--
-- Two parts (apply as separate calls; ONE statement per call — wave-108 MCP lesson).

-- ══════════════════════════════ PART A — columns, CHECKs ══════════════════════════════
-- A0 defensive remap (0 rows expected — the m727 table was empty at the audit).
UPDATE public.skill_marketplace_listings SET status = CASE status
  WHEN 'submitted' THEN 'draft' WHEN 'evaluated' THEN 'validated' WHEN 'published' THEN 'enabled'
  WHEN 'revoked' THEN 'disabled' WHEN 'rejected' THEN 'disabled' ELSE status END
WHERE status IN ('submitted', 'evaluated', 'published', 'revoked', 'rejected');

ALTER TABLE public.skill_marketplace_listings RENAME COLUMN published_at TO enabled_at;
ALTER TABLE public.skill_marketplace_listings RENAME COLUMN revoked_at TO disabled_at;
ALTER TABLE public.skill_marketplace_listings RENAME COLUMN revoked_reason TO disabled_reason;

ALTER TABLE public.skill_marketplace_listings
  ADD COLUMN IF NOT EXISTS extension_kind   text NOT NULL DEFAULT 'skill',
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS deprecated_at    timestamptz;

ALTER TABLE public.skill_marketplace_listings ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.skill_marketplace_listings
  DROP CONSTRAINT IF EXISTS skill_marketplace_listings_status_check,
  ADD CONSTRAINT skill_marketplace_listings_status_check CHECK (status IN ('draft', 'validated', 'approved', 'enabled', 'suspended', 'deprecated', 'disabled'));

ALTER TABLE public.skill_marketplace_listings
  ADD CONSTRAINT skill_marketplace_listings_extension_kind_check CHECK (extension_kind IN ('skill', 'strategy', 'provider_adapter', 'custom_manager', 'webhook_app'));

-- The kill switch must say why: a disabled / suspended row carries its stamp + reason (m727's revoked shape, renamed).
ALTER TABLE public.skill_marketplace_listings
  DROP CONSTRAINT IF EXISTS skill_marketplace_listings_revoked_shape_check,
  ADD CONSTRAINT skill_marketplace_listings_disabled_shape_check CHECK (status <> 'disabled' OR (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL));

ALTER TABLE public.skill_marketplace_listings
  ADD CONSTRAINT skill_marketplace_listings_suspended_shape_check CHECK (status <> 'suspended' OR (suspended_at IS NOT NULL AND suspended_reason IS NOT NULL));

-- A published global listing was readable by every tenant; an ENABLED (or deprecated, still running) one is now.
ALTER POLICY skill_marketplace_listings_select ON public.skill_marketplace_listings
  USING (
    is_platform_admin()
    OR (publisher <> 'tenant' AND status IN ('enabled', 'deprecated'))
    OR (publisher = 'tenant' AND has_brokerage_access(brokerage_id))
  );

COMMENT ON TABLE public.skill_marketplace_listings IS
  'ONE EXTENSION LIFECYCLE (m727 wave 108 → m738 wave 137 lane 137D): one row per submitted extension VERSION. extension_kind skill | strategy | provider_adapter | custom_manager | webhook_app; declaration = DATA (lib/kernel/skill-registry.ts SkillDeclaration / CustomManagerDeclaration), never code. status draft → validated → approved → enabled → suspended → deprecated → disabled; suspended / disabled cannot execute and keep every piece of evidence. Per-tenant enablement of a global extension = tenant policy key `extensions`. Written ONLY by lib/kernel/skill-marketplace.ts.';

-- ══════════════════════════════ PART B — indexes, trigger ══════════════════════════════
-- The three retired m727 indexes are dropped by m739 (held for the owner's confirmation of a destructive DDL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_extension_listings_global_version ON public.skill_marketplace_listings (extension_kind, skill_id, version) WHERE publisher <> 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS uq_extension_listings_tenant_version ON public.skill_marketplace_listings (brokerage_id, extension_kind, skill_id, version) WHERE publisher = 'tenant';
CREATE INDEX IF NOT EXISTS idx_extension_listings_kind_status ON public.skill_marketplace_listings (extension_kind, status, skill_id);

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
     OR NEW.extension_kind IS DISTINCT FROM OLD.extension_kind
     OR NEW.brokerage_id IS DISTINCT FROM OLD.brokerage_id THEN
    RAISE EXCEPTION 'skill_marketplace_listings: a submitted declaration is immutable (% % v%) — submit a new version', OLD.extension_kind, OLD.skill_id, OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD.status = 'disabled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'skill_marketplace_listings: a disabled extension is terminal (% v%) — submit a new version', OLD.skill_id, OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Evidence survives the kill switch: a session can never DELETE (m727 REVOKE stands); the service path never deletes.
