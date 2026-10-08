-- m629-property-intelligence-vision-columns.sql
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m629_property_intelligence_vision_columns) ──
-- ─────────────────────────────────────────────────────────────────────────────
-- WIRES lib/external/vision-property.ts::scorePropertyImage (an orphan export —
-- no caller anywhere in the repo, orphan-export-guard category A) into
-- app/actions/lead-intelligence.ts::enrichPropertyIntelligence, which already
-- writes property_intelligence from BatchData public-record data. This adds
-- columns for the vision call's own output; nothing existing is touched.
--
-- vision-property.ts's own header: "derives motivation / staging / condition
-- signals text-scraping competitors miss ... the lead pipeline can fold into
-- motivationScore." lib/lead-pipeline/* is frozen this wave (lead-scraping
-- audit lane, 2026-09-15) so that fold-in is NOT done here — these columns are
-- additive and ready for that lane to consume next.
--
-- ADDITIVE AND SAFE. No column is dropped, no data is rewritten. Application
-- code (enrichPropertyIntelligence) already retries the insert WITHOUT these
-- columns on PGRST204, so the write path degrades safely if this migration is
-- applied after that code ships — not a hazard either direction.

ALTER TABLE public.property_intelligence
  ADD COLUMN IF NOT EXISTS vision_motivation_score integer,
  ADD COLUMN IF NOT EXISTS vision_condition_score  integer,
  ADD COLUMN IF NOT EXISTS vision_staging_score    integer,
  ADD COLUMN IF NOT EXISTS vision_signals          jsonb,
  ADD COLUMN IF NOT EXISTS vision_rationale        text,
  ADD COLUMN IF NOT EXISTS vision_photo_url         text,
  ADD COLUMN IF NOT EXISTS vision_analyzed_at        timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'property_intelligence_vision_motivation_score_range'
       AND conrelid = 'public.property_intelligence'::regclass
  ) THEN
    ALTER TABLE public.property_intelligence
      ADD CONSTRAINT property_intelligence_vision_motivation_score_range
      CHECK (vision_motivation_score IS NULL OR (vision_motivation_score BETWEEN 0 AND 100))
      NOT VALID;
    ALTER TABLE public.property_intelligence
      VALIDATE CONSTRAINT property_intelligence_vision_motivation_score_range;
  END IF;
END $$;

COMMENT ON COLUMN public.property_intelligence.vision_motivation_score IS
  '0-100 — from lib/external/vision-property.ts::scorePropertyImage (deferred maintenance / poor staging / overgrown yard / boarded windows). NULL when no photo was scored (no Street View coverage or the vision call errored).';
