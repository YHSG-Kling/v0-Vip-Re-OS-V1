-- l42-s02 — photo_enhancement_jobs.photo_id → NULLABLE (applied live 2026-07-09).
-- The real photo-intelligence engine (lib/listings/photo-intelligence.ts)
-- writes an audit-trail job row for EVERY AI edit (enhance / virtual_staging /
-- twilight). Staging can legitimately run on a photo URL that has no
-- listing_photos row (marketing flows, uploaded one-offs) — the NOT NULL
-- constraint would have dropped exactly the audit rows the MLS-disclosure
-- discipline depends on. Caught by the live shape verification before any
-- production insert failed.
ALTER TABLE photo_enhancement_jobs ALTER COLUMN photo_id DROP NOT NULL;
