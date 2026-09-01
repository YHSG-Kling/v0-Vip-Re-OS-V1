-- m597 — kernel_event_id: five copies of a link to a table that does not exist
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: WRITTEN, NOT APPLIED. Lane W4 writes migrations; only the integrator
-- applies them (CLAUDE.md §3 — a .sql file is not the database).
--
-- WHAT. Drop the `kernel_event_id` column from all five tables that carry it:
-- social_posts, ad_campaigns, blog_posts, email_campaigns, newsletter_campaigns.
--
-- EVIDENCE, measured 2026-09-01 (fresh grep over stripped source + live schema
-- caches, re-verified this session):
--
--   · NO TARGET TABLE. No `kernel_events` table exists on hrvaqgvukzxfskkcrwbt
--     (absent from scripts/live-tables.ts and scripts/schema-snapshot.ts). The
--     column's name promises a link to a table that has never existed.
--   · NO FK. None of the five copies carries a foreign key anywhere
--     (scripts/schema-fk-map.ts has no kernel_event_id edge).
--   · NO PUBLISHER. The kernel event pipeline's entry point,
--     processKernelEvent (lib/kernel/notification-engine.ts:20, re-exported by
--     lib/kernel/index.ts:11), returns Promise<void> — it produces no id any
--     writer could stamp into the column.
--   · ONE WRITER, WRITING A LITERAL NULL. lib/ads/ad-creator.ts:610 wrote
--     `kernel_event_id: null // Will be set by kernel event` — a promise no
--     code keeps. That line is deleted in the same lane as this file (after
--     this drop it would 42703-refuse every launch, and PGRST204 refuses the
--     whole row, not just the column).
--   · ZERO READERS after wave 21. The last reader — the ROI calculator's
--     social branch, which gated money math on the column being non-null and
--     therefore structurally reported 0 — was repointed onto
--     marketing_campaign_id (tombstone at lib/campaigns/roi-calculator.ts,
--     "§1 repoint (2026-09-01)", now naming this migration).
--
-- WHY DROP RATHER THAN BUILD THE MISSING HALF (§1 adjudication): the durable
-- "what event touched this row" link ALREADY EXISTS as `lifecycle_events`
-- rows written beside every publish —
--   app/actions/social-media-automation.ts:431-443 (SOCIAL_POST_SCHEDULED,
--   entity_type 'social_post', entity_id = the post's id) and
--   lib/ads/ad-creator.ts:625-635 (ad_campaign_launched, entity_type
--   'ad_campaign', entity_id = the campaign's id).
-- A per-row kernel_event_id stamp would be a SECOND SPELLING of the
-- lifecycle_events link (§6): same fact, join direction inverted. The
-- functionality lives there; these five columns retire.
--
-- No backfill concern: a column no reader consults and no writer fills holds
-- nothing anyone can lose. IF EXISTS keeps the file idempotent and tolerant of
-- an integrator ordering it after any partial cleanup.

BEGIN;

ALTER TABLE public.social_posts          DROP COLUMN IF EXISTS kernel_event_id;
ALTER TABLE public.ad_campaigns          DROP COLUMN IF EXISTS kernel_event_id;
ALTER TABLE public.blog_posts            DROP COLUMN IF EXISTS kernel_event_id;
ALTER TABLE public.email_campaigns       DROP COLUMN IF EXISTS kernel_event_id;
ALTER TABLE public.newsletter_campaigns  DROP COLUMN IF EXISTS kernel_event_id;

COMMIT;

-- AFTER APPLYING (integrator): regenerate the schema caches so
-- scripts/schema-snapshot.ts stops listing the five retired copies —
-- pipe the live JSON through scripts/generate-schema-snapshot.ts per its
-- header. No CHECK changed, so the vocabulary cache is untouched.
--
-- VERIFY (expect zero rows):
--   select table_name from information_schema.columns
--    where table_schema = 'public' and column_name = 'kernel_event_id';
