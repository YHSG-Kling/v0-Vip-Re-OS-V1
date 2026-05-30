-- Atomic idempotency backstop for client portal transparency cards (code-review #6).
--
-- writePortalUpdate (lib/kernel/event-fanout.ts) dedupes with a SELECT-then-INSERT over a 10-minute
-- window keyed on (contact_id, update_type, title). That is not atomic: two truly concurrent emits of
-- the same card (e.g. buyer + seller milestone fired by near-simultaneous requests, or the safety-net
-- cron overlapping a reactive emit) can both pass the SELECT before either INSERTs, producing a
-- duplicate card.
--
-- This partial unique index makes the common collision atomic: a second identical card
-- (same contact + event + title) within the same clock-minute hits the unique violation, which the
-- writer's swallowing insert (.then(ok, ignore)) silently absorbs — i.e. the duplicate is dropped
-- with no error and no app change. It never blocks anything the existing 10-minute SELECT wouldn't
-- already collapse (the SELECT window is wider), so it adds no new false-suppression.
CREATE UNIQUE INDEX IF NOT EXISTS transparency_updates_dedupe_idx
  ON transparency_updates (contact_id, update_type, md5(title), date_trunc('minute', created_at))
  WHERE contact_id IS NOT NULL;
