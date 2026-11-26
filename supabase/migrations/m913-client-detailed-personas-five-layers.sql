-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148C ──
--
-- m913 — client_detailed_personas: the FIVE persona layers, kept SEPARATE (owner ruling 1, 2026-11-01).
--
-- OWNER, verbatim: "the read of protected or prohibited can be used to determine the person's persona so users can create ads
-- and posts, etc. around that persona." The persona handed to marketing is MARKETING-SAFE — needs-based, never a protected
-- characteristic or its proxy — and five layers stay separate:
--   1 research attributes   → research_layer      (field NAMES, classes, basis, data rights — NEVER a value; the values stay in
--                                                   their stores: the contact columns with provenance + protected_research_attributes)
--   2 verified stated needs → stated_needs        (evidence items: id, source, summary, the need it supports, confidence)
--   3 behavioural evidence  → behavioural_evidence
--   4 inferred interests    → inferred_interests  (each with its confidence — append is not intent)
--   5 marketing persona     → marketing_persona   (needs-based; the ONE layer ads, posts and custom audiences read)
-- plus service_profile (the customer-service profile — written from canonical columns + the firewalled study), derivation
-- (prompt version, model vs deterministic, actor, the firewall's refusals, which contact_persona it wrote) and derived_at.
--
-- SURVIVOR: client_detailed_personas (written by lib/contacts/persona-builder.ts — the enrichment-time build and, now, derivePersona;
-- read by lead scoring, the open-house invitation and persona-aware content). EXTENDED, not twinned (LAW 1). The legacy columns
-- (persona_name / persona_type / buying_triggers / pain_points / ai_summary) stay and are written from the marketing-safe layer;
-- demographics / psychographics are written '{}' from now on (Layer 1 is not copied — lib/contacts/persona-builder.ts header).
--
-- THE DATABASE HOLDS THE RULE TOO (fail closed beside the code):
--   · a marketing persona is stored only when the firewall passed it  (marketing_persona IS NULL OR marketing_safe);
--   · a stored marketing persona never carries a protected-characteristic campaign persona — the list below is the classifier's
--     output over CAMPAIGN_PERSONAS (lib/contacts/persona-layers.ts PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS) and
--     scripts/persona-compliance-guard.ts asserts the two are the SAME set (the rule, derived — never a waypoint);
--   · the research layer never carries a VALUE (no `value` key on any recorded field).
-- No row is rewritten; existing rows get the defaults ('[]' / '{}' / NULL / false).

ALTER TABLE public.client_detailed_personas
  ADD COLUMN IF NOT EXISTS stated_needs          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS behavioural_evidence  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS inferred_interests    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS research_layer        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS marketing_persona     jsonb,
  ADD COLUMN IF NOT EXISTS marketing_safe        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_profile       jsonb,
  ADD COLUMN IF NOT EXISTS derivation            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS derived_at            timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_detailed_personas_marketing_safe_check') THEN
    ALTER TABLE public.client_detailed_personas
      ADD CONSTRAINT client_detailed_personas_marketing_safe_check CHECK (marketing_persona IS NULL OR marketing_safe = true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_detailed_personas_marketing_needs_based_check') THEN
    ALTER TABLE public.client_detailed_personas
      ADD CONSTRAINT client_detailed_personas_marketing_needs_based_check CHECK (
        marketing_persona IS NULL
        OR coalesce(marketing_persona->>'campaignPersona', '') NOT IN ('probate', 'military', 'divorce', 'senior')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_detailed_personas_research_layer_no_values_check') THEN
    ALTER TABLE public.client_detailed_personas
      ADD CONSTRAINT client_detailed_personas_research_layer_no_values_check CHECK (
        NOT jsonb_path_exists(research_layer, 'lax $.fields[*] ? (exists(@.value))')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_detailed_personas_tenant_contact
  ON public.client_detailed_personas (brokerage_id, contact_id);

COMMENT ON COLUMN public.client_detailed_personas.research_layer IS
  'Layer 1 (wave 148C): research attribute NAMES / classes / basis / data rights considered by the persona study — never a value.';
COMMENT ON COLUMN public.client_detailed_personas.marketing_persona IS
  'Layer 5 (wave 148C): the needs-based, firewalled marketing persona — the only layer ads, posts and custom audiences read.';

-- VERIFY (after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'client_detailed_personas'
--     AND column_name IN ('stated_needs','behavioural_evidence','inferred_interests','research_layer','marketing_persona',
--                         'marketing_safe','service_profile','derivation','derived_at');                       -- → 9 rows
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.client_detailed_personas'::regclass AND contype = 'c'; -- → the 3 CHECKs
--   INSERT … marketing_persona '{"campaignPersona":"senior"}', marketing_safe true → 23514 (refused, as intended)
-- REGENERATE: scripts/schema-snapshot.ts (9 columns on client_detailed_personas). No FK, no `= ANY` vocabulary CHECK.
