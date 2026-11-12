-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149A ──
--
-- m934 — OWNER RULING 2026-11-03: "Every persona is allowed and this can't change."
--
-- m913 (wave 148, lane 148C) added `client_detailed_personas_marketing_needs_based_check`:
--   CHECK (marketing_persona IS NULL OR COALESCE(marketing_persona->>'campaignPersona','') <> ALL
--          (ARRAY['probate','military','divorce','senior']))
-- It forbade the four situation personas as the marketing persona — the "needs-based only" restriction the owner REVERSED.
-- A persona describes the person's situation so the OS can speak to their pain points; fair housing reads the WORDING of the
-- ad / post (copy scans in lib/compliance-rules/**) and the ad platform's housing rules, never which persona exists.
--
-- This migration DROPS that one CHECK and nothing else. It STAYS (unchanged): m913's
-- `client_detailed_personas_marketing_safe_check` (marketing_persona only with marketing_safe — the copy scans passed) and
-- `client_detailed_personas_research_layer_no_values_check` (no Layer-1 research VALUE is ever persisted on the persona row).
--
-- Live read before writing (2026-11-03, read-only, pg_get_constraintdef): the CHECK exists exactly as above; client_detailed_personas
-- holds 0 rows, so no backfill is needed. Not a `= ANY` vocabulary CHECK → scripts/check-vocabularies.ts is unaffected.

ALTER TABLE public.client_detailed_personas
  DROP CONSTRAINT IF EXISTS client_detailed_personas_marketing_needs_based_check;

-- VERIFY (expect 0 rows):
--   SELECT conname FROM pg_constraint WHERE conname = 'client_detailed_personas_marketing_needs_based_check';
-- VERIFY (expect 2 rows — the two m913 CHECKs that stay):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.client_detailed_personas'::regclass AND contype = 'c'
--     AND conname IN ('client_detailed_personas_marketing_safe_check', 'client_detailed_personas_research_layer_no_values_check');
--
-- ROLLBACK (re-imposes the reversed restriction — only on a new owner ruling):
--   ALTER TABLE public.client_detailed_personas ADD CONSTRAINT client_detailed_personas_marketing_needs_based_check
--     CHECK (marketing_persona IS NULL OR COALESCE(marketing_persona->>'campaignPersona','') <> ALL (ARRAY['probate','military','divorce','senior']));
