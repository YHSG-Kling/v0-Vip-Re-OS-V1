-- m236-property-alerts-snooze.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- BUYER ALERT SNOOZE (auto-resume). property_alerts already models cadence (frequency:
-- instant/twice_daily/daily/weekly, enforced by lib/alerts/alert-engine.shouldRunNow) and a manual
-- pause (is_active=false + paused_by/paused_reason). What was missing — and what buyers explicitly
-- ask for (RealScout wishlist: "snooze and mute this neighborhood/feature WITHOUT turning off the
-- search") — is a TEMPORARY mute that auto-resumes. snoozed_until is that: while it's in the future
-- the alert engine skips the search; once it passes, the search resumes on its own (no manual action,
-- the search is never deactivated). NULL = not snoozed (default, no behavior change for existing rows).

ALTER TABLE property_alerts ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

COMMENT ON COLUMN property_alerts.snoozed_until IS
  'When set and in the future, the alert engine skips this search until then, then auto-resumes (buyer snooze). NULL = active.';
