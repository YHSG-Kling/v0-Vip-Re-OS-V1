-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m706 — CONSENTED website-visitor email capture on behavioral_signals (wave 103, lane 103D; owner
-- answer 1, 2026-10-05: "YES build CONSENTED website-visitor email capture (the identify loop fires
-- only on a consent artifact)").
--
-- WHY. Wave 102.1 (lane 102E) wired the visitor-identify loop — app/actions/lead-intelligence.ts
-- resolveIdentity matches a behavioral signal to a tenant contact on `email_captured` and the
-- person-evidence writer records the link — but the column it reads NEVER EXISTED live
-- (scripts/schema-snapshot.ts behavioral_signals: no email_captured) and no door ever wrote it, so
-- the loop could not fire. The capability was left dark on compliance grounds until the owner ruled.
--
-- WHAT. Three ADDITIVE columns on the existing table; nothing else changes.
--   email_captured     text         the visitor's email, stored by the ONE capture door
--                                   (lib/lead-intelligence/visitor-email-capture.ts) and ONLY once a
--                                   consent artifact exists
--   email_captured_at  timestamptz  when it was captured
--   consent_event_id   uuid → contact_consent_events(id)   THE consent artifact: the row the canonical
--                                   consent writer (lib/kernel/compliance/require-contact-consent.ts
--                                   persistContactConsent) inserted for this capture
-- FAIL CLOSED AT THE DATABASE TOO: the CHECK below refuses an email on a signal that names no consent
-- artifact, so no second writer can ever store a bare form field. The FK carries NO ON DELETE action on
-- purpose: a consent event a stored email depends on cannot be removed first — an erasure clears the
-- email (the value) before the artifact, which is the right privacy order; SET NULL would collide with
-- the CHECK and CASCADE would delete a signal row over an audit-ledger housekeeping.
--
-- SURVIVORS EVALUATED (LAW 1/2): contact_consent_events is the ONE consent ledger (tcpa / unsubscribe /
-- sms_stop …; every door — forms, widget, open house, ads — writes through persistContactConsent);
-- privacy_acceptances records policy acceptances by user/contact (terms, privacy, cookie) and is not
-- a per-capture consent artifact, so the FK targets the consent ledger.
--
-- Apply in TWO parts (wave 98 rule): PART A (columns + CHECK), PART B (index). AFTER APPLYING:
-- regenerate scripts/schema-snapshot.ts (behavioral_signals gains three columns) and
-- scripts/schema-fk-map.ts (behavioral_signals.consent_event_id → contact_consent_events), and
-- restamp this header's line 1 the way m702's is stamped (one provenance line, dated).

-- ══════════════════════════════ PART A — columns, CHECK ══════════════════════════════

ALTER TABLE public.behavioral_signals
  ADD COLUMN IF NOT EXISTS email_captured text,
  ADD COLUMN IF NOT EXISTS email_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_event_id uuid REFERENCES public.contact_consent_events(id);

ALTER TABLE public.behavioral_signals
  DROP CONSTRAINT IF EXISTS behavioral_signals_email_requires_consent_check;
ALTER TABLE public.behavioral_signals
  ADD CONSTRAINT behavioral_signals_email_requires_consent_check
    CHECK (email_captured IS NULL OR consent_event_id IS NOT NULL);

COMMENT ON COLUMN public.behavioral_signals.email_captured IS
  'Visitor email captured by the ONE consented capture door (lib/lead-intelligence/visitor-email-capture.ts). NULL unless consent_event_id names the consent artifact (CHECK). m706.';
COMMENT ON COLUMN public.behavioral_signals.email_captured_at IS
  'When email_captured was stored (m706).';
COMMENT ON COLUMN public.behavioral_signals.consent_event_id IS
  'THE consent artifact behind email_captured: contact_consent_events.id written by persistContactConsent for this capture (m706). No ON DELETE action: erase the email before the artifact.';

-- ══════════════════════════════ PART B — index ══════════════════════════════

CREATE INDEX IF NOT EXISTS behavioral_signals_consent_event_idx
  ON public.behavioral_signals (consent_event_id)
  WHERE consent_event_id IS NOT NULL;
