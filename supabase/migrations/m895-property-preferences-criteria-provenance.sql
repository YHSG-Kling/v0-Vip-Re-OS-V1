-- WRITTEN, NOT APPLIED (wave 147, lane 147C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m895 — property_preferences: PER-FIELD PROVENANCE, LIFESTYLE ASKS, LISTING TYPE on THE ONE buyer criteria store
-- (wave 147, lane 147C — owner ruling 16, contract C10: "Natural language / voice → structured, editable criteria with
-- provenance per field (said | inferred | default) … preferences persist across portal, mobile, email and AI conversation").
--
-- WHY THESE COLUMNS AND NOT A NEW TABLE (orphan doctrine §1 / LAW 1, audited against scripts/schema-snapshot.ts at 4d527cc3):
--   · property_preferences IS the survivor store: lib/buyer-search/buyer-criteria.ts loadBuyerCriteria is "THE single
--     normalized reader" (wave 65) and the matcher, the market watch, the showing brief, the portal search page and the
--     buyer insights all read it. It has one row per contact (upserts ON CONFLICT contact_id) and no column that says WHO
--     stated a value: preferred_price_* and every inferred_* column are rewritten by the behaviour learner
--     (lib/behavior-learning/preference-updater.ts), so a buyer who SAID "under $600k" is indistinguishable from a learned band.
--   · property_interests is the agent-side CRM criteria form (app/crm/contacts/[contactId]/search) and property_alerts is a
--     saved SEARCH (cadence, delivery, approval) — neither is the buyer's own evolving criteria; widening either would put a
--     second criteria vocabulary beside the one the matcher reads (CLAUDE.md §6).
--   · contacts.notes JSON (ai_inference.search) is free text with no schema; its writer and reader already disagreed on keys.
--
-- Columns (all additive, nullable or defaulted — no existing reader changes behaviour until it chooses to read them):
--   criteria_provenance   jsonb  { <field>: { source: said|inferred|default, value, evidence, channel, at, reason } } —
--                                the said VALUE rides inside the entry so it survives the learner overwriting the column
--                                (buyer-criteria.ts normalizeCriteriaRow lets a said value win and reports the override).
--   lifestyle_preferences jsonb  [ { kind, label, direction, target, maxMinutes, evidence } ] — the buyer's own lifestyle asks
--                                (natural_light, commute, layout, accessibility, nearby_amenity, outdoor_space, quiet_setting);
--                                answered ONLY from source data, never a listing filter.
--   listing_type          text   sale | rent (NULL = never stated → the search treats it as the for-sale market) — the same
--                                vocabulary as property_alerts.listing_type (m657 property_alerts_listing_type_check).
--
-- Writer: lib/buyer-search/buyer-criteria.ts saveBuyerCriteria (the ONE writer; every conversational channel calls it through
-- app/actions/buyer-search/conversational-search.ts). Readers: buyer-criteria.ts loadBuyerCriteria (BUYER_CRITERIA_STATE_SELECT).
-- Until this is applied both degrade by name (42703) and say so; nothing breaks.
--
-- After applying: regenerate scripts/schema-snapshot.ts (property_preferences +3 columns) and scripts/check-vocabularies.ts
-- (property_preferences_listing_type_check: sale, rent). No FK, no index, no RLS change (the table's existing policies apply).

ALTER TABLE public.property_preferences
  ADD COLUMN IF NOT EXISTS criteria_provenance   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lifestyle_preferences jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS listing_type          text  NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.property_preferences'::regclass AND conname = 'property_preferences_listing_type_check'
  ) THEN
    ALTER TABLE public.property_preferences
      ADD CONSTRAINT property_preferences_listing_type_check CHECK (listing_type IS NULL OR listing_type IN ('sale', 'rent'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.property_preferences'::regclass AND conname = 'property_preferences_criteria_provenance_shape'
  ) THEN
    ALTER TABLE public.property_preferences
      ADD CONSTRAINT property_preferences_criteria_provenance_shape CHECK (jsonb_typeof(criteria_provenance) = 'object'),
      ADD CONSTRAINT property_preferences_lifestyle_shape CHECK (jsonb_typeof(lifestyle_preferences) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN public.property_preferences.criteria_provenance IS
  'Wave 147C (C10): per-field provenance { field: { source said|inferred|default, value, evidence, channel, at, reason } }. A said value outranks the column it shadows. Writer: lib/buyer-search/buyer-criteria.ts saveBuyerCriteria.';
COMMENT ON COLUMN public.property_preferences.lifestyle_preferences IS
  'Wave 147C (C10): the buyer''s own lifestyle asks with their literal words; answered only from source data (explainCriteriaFit), never inferred, never a filter.';
COMMENT ON COLUMN public.property_preferences.listing_type IS
  'Wave 147C (C10): sale | rent as the buyer stated it; NULL = never stated (for-sale market). Same vocabulary as property_alerts.listing_type (m657).';

-- VERIFY (read-only, after applying):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'property_preferences'
--      AND column_name IN ('criteria_provenance', 'lifestyle_preferences', 'listing_type');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.property_preferences'::regclass
--      AND (conname = 'property_preferences_listing_type_check' OR conname LIKE 'property_preferences_%_shape');
