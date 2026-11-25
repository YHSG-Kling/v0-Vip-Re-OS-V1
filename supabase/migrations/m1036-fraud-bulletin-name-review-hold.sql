-- m1036 — FRAUD BULLETIN NAME-REVIEW HOLD (wave 156, lane 156J round 2). WRITTEN, NOT APPLIED. Needs m1035 first.
--
-- INTENT. A bulletin text that carries a capitalized two-word personal-name pattern or a business-entity suffix outside an
-- `official_public_warning` is HELD for a SECOND platform-safety moderator (lib/fraud-network/network.ts
-- nameReviewSpans / publishBulletin / clearNameReview). The hold records the matched spans and who asked; the clearance
-- records a DIFFERENT staff user and the fingerprint of the exact spans cleared, so an edit that adds a new name re-holds.
-- It is a hold for human review, never a judgment of who anyone is.
--
-- Additive and idempotent: two nullable jsonb columns on a table m1035 creates. No policy, CHECK or data change.
-- After applying: npm run schema:regen.

alter table public.fraud_bulletins add column if not exists name_review_hold jsonb;
alter table public.fraud_bulletins add column if not exists name_review_clearance jsonb;

comment on column public.fraud_bulletins.name_review_hold is 'Wave 156 (156J r2): {spans, spans_fingerprint, requested_by, at} — publication held for a second moderator because the text matched a personal-name or business-entity pattern.';
comment on column public.fraud_bulletins.name_review_clearance is 'Wave 156 (156J r2): {spans_fingerprint, cleared_by, at, note} — a DIFFERENT moderator cleared exactly these spans.';

-- Read-back: select column_name from information_schema.columns where table_schema = 'public' and table_name = 'fraud_bulletins' and column_name like 'name_review%';  -- 2 rows
