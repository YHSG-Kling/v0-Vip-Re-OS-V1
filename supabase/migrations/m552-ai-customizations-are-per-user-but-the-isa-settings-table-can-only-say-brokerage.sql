-- m552 — "ai customizations are also per user", but ai_isa_settings can only say
--        "brokerage", so a per-user AI customization is INEXPRESSIBLE.
--
-- APPLICATION STATUS: APPLIED 2026-08-24 hrvaqgvukzxfskkcrwbt
--
-- EVIDENCE (probes run against the live project, then removed).
--
--   BEFORE — the ruling was not merely unbuilt, it was refused by the schema:
--     per-AGENT row   REFUSED  42703  column "agent_id"   of relation "ai_isa_settings" does not exist
--     per-TEAM  row   REFUSED  42703  column "team_id"    of relation "ai_isa_settings" does not exist
--     PLATFORM  row   REFUSED  42703  column "owner_type" of relation "ai_isa_settings" does not exist
--
--   AFTER — the four tiers the cascade needs, ACCEPTED:
--     per-AGENT row      ACCEPTED
--     per-TEAM row       ACCEPTED
--     per-BROKERAGE row  ACCEPTED
--     PLATFORM row       ACCEPTED
--
--   AFTER — NEGATIVE CONTROLS, the shapes that must stay impossible (a guard that
--   only proves the accepts would pass against a table with no constraints at all):
--     two owners at once (team+agent)   REFUSED  23514  ai_isa_settings_owner_shape_check
--     agent row with NO tenant          REFUSED  23514  ai_isa_settings_owner_shape_check
--     platform row carrying a tenant    REFUSED  23514  ai_isa_settings_owner_shape_check
--     unknown owner_type ('tenant')     REFUSED  23514  ai_isa_settings_owner_shape_check
--     second PLATFORM row               REFUSED  23505  ai_isa_settings_platform_uniq
--     second row for the same AGENT     REFUSED  23505  ai_isa_settings_agent_uniq
--
--   The 4 probe rows were deleted and the table re-counted in a SEPARATE statement
--   (a DELETE's own RETURNING sees the pre-delete snapshot): 0 rows remain, which
--   is where it started.
--
--   CACHES REGENERATED from live, never hand-edited (CLAUDE.md §3):
--     scripts/schema-snapshot.ts    + ai_isa_settings (agent_id, team_id, owner_type)
--     scripts/schema-fk-map.ts      + ai_isa_settings.agent_id→agents, .team_id→teams
--     scripts/check-vocabularies.ts + ai_isa_settings.owner_type
--     scripts/live-tables.ts        (unchanged for this table; already listed)
--
-- OWNER RULINGS (2026-08-24), verbatim:
--   A. "ai isa system works for 1 tenant at a time and works for the platform as well"
--   B. "ai customizations are also per user"
--
-- ── THE MEASUREMENT (live, hrvaqgvukzxfskkcrwbt, 2026-08-24) ─────────────────
-- Two tables model the same idea — "an AI behaviour that somebody configured" —
-- and only one of them can say WHO:
--
--   brand_voice_profile   brokerage_id | team_id | agent_id     ← has the grain
--   ai_isa_settings       brokerage_id  (NOT NULL, UNIQUE)      ← tenant-only
--
-- `brand_voice_profile` is the survivor pattern this repo already uses: three
-- nullable owner columns, cascaded agent → team → brokerage by
-- lib/ai/pipeline.ts::resolveBrandVoice. `ai_isa_settings` has ONE owner column,
-- it is NOT NULL, and it carries a single-column UNIQUE — so the table cannot
-- physically hold a second row for the same brokerage, which is exactly what a
-- per-agent or per-team ISA customization is. The ruling was not merely unbuilt;
-- it was structurally forbidden.
--
-- CLAUDE.md §1.2: no duplicate of the GRAIN exists, the capability is wanted,
-- so BUILD the missing half — onto the existing table, in the existing
-- vocabulary, rather than inventing a third scoping spelling (§6).
--
-- ── WHY AN EXPLICIT owner_type AND NOT "all-null means platform" ─────────────
-- lib/kernel/tenant-scope.ts exists because a MISSING tenant id kept decaying
-- into "every tenant". Reproducing that shape in a CHECK constraint would import
-- the same defect into the schema: a row whose brokerage_id failed to be written
-- would silently become the PLATFORM default for every tenant. So the owner tier
-- is NAMED, in the vocabulary lib/connections/scope.ts already cascades over and
-- platform_credentials.owner_type already stores (m548 widened that one to admit
-- 'platform' for precisely this reason):
--
--     owner_type ∈ platform | brokerage | team | agent
--
-- ── ONE TENANT AT A TIME (Ruling A), ENFORCED IN THE ROW SHAPE ───────────────
-- Every NON-platform row carries a brokerage_id NOT NULL. A team row and an
-- agent row are still anchored to exactly ONE tenant, so no row in this table
-- can ever describe two tenants at once, and no row can be tenant-less without
-- declaring itself platform. That is the storage half of "the ISA works for one
-- tenant at a time and works for the platform as well"; the session half lives
-- in lib/ai-isa/isa-acting-scope.ts, which refuses an unset or plural tenant.
--
-- ── ADDITIVE AND SAFE, MEASURED ─────────────────────────────────────────────
--   public.ai_isa_settings  0 rows   (2026-08-24)
--   public.global_settings  0 rows   ← the store the app ACTUALLY read
-- Nothing to backfill, nothing to re-label, and no live behaviour changes value:
-- app/actions/ai-isa-settings.ts read global_settings.additional_settings->
-- 'ai_isa_settings', which has never held a row, so getAIISASettings() has
-- returned DEFAULT_AISA_SETTINGS for every brokerage for its whole life and
-- saveAIISASettings() has returned "Global settings row not found" for every
-- write. Both halves of that pair were dead against live data; this migration is
-- what lets the survivor store express the ruling before either is used.
--
-- The DEFAULT on owner_type is deliberate and temporary-shaped: it exists so the
-- ADD COLUMN is valid on a NOT NULL column, and every writer names owner_type
-- explicitly (lib/ai-isa/resolve-isa-settings.ts). It is NOT a way to omit it.

BEGIN;

ALTER TABLE public.ai_isa_settings
  ADD COLUMN IF NOT EXISTS owner_type text NOT NULL DEFAULT 'brokerage',
  ADD COLUMN IF NOT EXISTS team_id  uuid REFERENCES public.teams(id)  ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE;

-- A platform-tier row has no tenant, so the tenant column can no longer be NOT NULL.
-- The shape CHECK below is what keeps the absence from meaning anything else.
ALTER TABLE public.ai_isa_settings
  ALTER COLUMN brokerage_id DROP NOT NULL;

-- A single-column UNIQUE on brokerage_id is the constraint that made a per-user
-- customization impossible: one row per tenant, full stop. Replaced by four
-- PARTIAL uniques below — one per tier — which keep "one settings row per owner"
-- without collapsing the tiers into each other.
ALTER TABLE public.ai_isa_settings
  DROP CONSTRAINT IF EXISTS ai_isa_settings_brokerage_id_key;

ALTER TABLE public.ai_isa_settings
  DROP CONSTRAINT IF EXISTS ai_isa_settings_owner_type_check;
ALTER TABLE public.ai_isa_settings
  ADD CONSTRAINT ai_isa_settings_owner_type_check
  CHECK (owner_type = ANY (ARRAY['platform'::text, 'brokerage'::text, 'team'::text, 'agent'::text]));

-- THE ONE-OWNER / ONE-TENANT RULE. Exactly one owner column is populated for the
-- declared tier, and every non-platform tier names its single tenant.
ALTER TABLE public.ai_isa_settings
  DROP CONSTRAINT IF EXISTS ai_isa_settings_owner_shape_check;
ALTER TABLE public.ai_isa_settings
  ADD CONSTRAINT ai_isa_settings_owner_shape_check
  CHECK (
       (owner_type = 'platform'  AND brokerage_id IS NULL     AND team_id IS NULL     AND agent_id IS NULL)
    OR (owner_type = 'brokerage' AND brokerage_id IS NOT NULL AND team_id IS NULL     AND agent_id IS NULL)
    OR (owner_type = 'team'      AND brokerage_id IS NOT NULL AND team_id IS NOT NULL AND agent_id IS NULL)
    OR (owner_type = 'agent'     AND brokerage_id IS NOT NULL AND team_id IS NULL     AND agent_id IS NOT NULL)
  );

-- One row per owner, per tier. The platform tier has no id to key on, so its
-- uniqueness is over the constant — there is exactly one platform.
DROP INDEX IF EXISTS public.ai_isa_settings_platform_uniq;
CREATE UNIQUE INDEX ai_isa_settings_platform_uniq
  ON public.ai_isa_settings ((true)) WHERE owner_type = 'platform';

DROP INDEX IF EXISTS public.ai_isa_settings_brokerage_uniq;
CREATE UNIQUE INDEX ai_isa_settings_brokerage_uniq
  ON public.ai_isa_settings (brokerage_id) WHERE owner_type = 'brokerage';

DROP INDEX IF EXISTS public.ai_isa_settings_team_uniq;
CREATE UNIQUE INDEX ai_isa_settings_team_uniq
  ON public.ai_isa_settings (team_id) WHERE owner_type = 'team';

DROP INDEX IF EXISTS public.ai_isa_settings_agent_uniq;
CREATE UNIQUE INDEX ai_isa_settings_agent_uniq
  ON public.ai_isa_settings (agent_id) WHERE owner_type = 'agent';

COMMENT ON COLUMN public.ai_isa_settings.owner_type IS
  'Which tier configured this row: platform | brokerage | team | agent. Same ownership vocabulary as platform_credentials.owner_type and lib/connections/scope.ts. Resolution is most-specific-wins, agent -> team -> brokerage -> platform (lib/ai-isa/resolve-isa-settings.ts).';
COMMENT ON COLUMN public.ai_isa_settings.agent_id IS
  'agents.id (NOT users.id — the two id spaces are disjoint). The per-USER grain the owner ruling asks for, spelled the way brand_voice_profile.agent_id already spells it.';
COMMENT ON COLUMN public.ai_isa_settings.team_id IS
  'teams.id. The team tier of the ownership cascade.';
COMMENT ON COLUMN public.ai_isa_settings.brokerage_id IS
  'The single tenant this row belongs to. NULL only for owner_type = platform. Every team/agent row still names exactly one brokerage: the ISA works for ONE TENANT AT A TIME.';

COMMIT;
