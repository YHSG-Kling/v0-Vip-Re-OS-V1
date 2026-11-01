-- WRITTEN, NOT APPLIED (wave 148, lane 148H) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m925 — C22 REGISTRATION + VERIFIED ATTENDANCE (owner ruling 20, 2026-11-01: "Zoom … participant join/leave webhooks to verify
-- attendance; an anonymous join click is not attendance"; ruling 12: every form carries identity + situation fields AND the
-- creating agent/user, so the person is assigned back to them).
--
-- 1. open_house_rsvp_tracking is THE per-(event, contact) row (UNIQUE (event_id, contact_id), live). It becomes the
--    registration record too — extend, never a sibling registrations table:
--      registered_at, consent_event_id (the C8 consent row the registration form wrote — contact_consent_events),
--      created_by_user_id (the creating agent/user: the event's creator, who the registrant is assigned back to),
--      situation (the situation answers the form asked: intent, timeline BUCKET 1-3 / 3-6 / 6-12 per CLAUDE.md §5, working with
--      an agent, the question they want answered),
--      provider_registrant_id + provider_join_url (Zoom's registrant id + personal join link — the KEY a participant webhook is
--      matched on; a registrant id that is not ours never files anyone),
--      attendance_verified_by (kiosk_signin | agent_walk_in | zoom_participant — NEVER a click), attended_seconds,
--      first_joined_at, last_left_at (derived from the evidence rows below).
-- 2. event_attendance_evidence — one row per provider participant event (joined / left / meeting ended / watch link opened),
--    idempotent on dedupe_key (Zoom retries a delivery on any non-2xx). contact_id is NULL for an unmatched participant: an
--    anonymous or display-name-only join is EVIDENCE that someone joined, never a person's attendance. identity_match says how
--    (registrant_id | email_exact | registration_token | unmatched | host). Tenant from the EVENT row; the webhook never names one.
-- 3. open_house_attendees: one attendee row per (event, contact). The kiosk route already reads 23505 as "already checked in"
--    (app/api/open-house/attend/route.ts) — but no UNIQUE existed live (pg_indexes 2026-11-01), so that arm was inert and a
--    repeated verification could file a second attendee. Live duplicates measured: 0.
--
-- Measured live 2026-11-01 (read-only): all four open_house_* tables hold 0 rows.

ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS registered_at timestamptz;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS consent_event_id uuid;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS situation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS provider_registrant_id text;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS provider_join_url text;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS attendance_verified_by text;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS attended_seconds integer;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS first_joined_at timestamptz;
ALTER TABLE public.open_house_rsvp_tracking ADD COLUMN IF NOT EXISTS last_left_at timestamptz;

ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_consent_event_id_fkey;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_consent_event_id_fkey
  FOREIGN KEY (consent_event_id) REFERENCES public.contact_consent_events(id) ON DELETE SET NULL;
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_created_by_user_id_fkey;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_attendance_verified_by_check;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_attendance_verified_by_check
  CHECK (attendance_verified_by IS NULL OR attendance_verified_by = ANY (ARRAY['kiosk_signin'::text, 'agent_walk_in'::text, 'zoom_participant'::text]));
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_attended_seconds_check;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_attended_seconds_check
  CHECK (attended_seconds IS NULL OR attended_seconds >= 0);
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_provider_join_url_https;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_provider_join_url_https
  CHECK (provider_join_url IS NULL OR provider_join_url ~ '^https://');

CREATE UNIQUE INDEX IF NOT EXISTS uq_open_house_rsvp_provider_registrant
  ON public.open_house_rsvp_tracking (event_id, provider_registrant_id) WHERE provider_registrant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.event_attendance_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  event_id              uuid NOT NULL REFERENCES public.open_house_events(id) ON DELETE CASCADE,
  contact_id            uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  provider              text NOT NULL CHECK (provider = ANY (ARRAY['zoom'::text, 'youtube'::text])),
  provider_event        text NOT NULL CHECK (provider_event = ANY (ARRAY['participant_joined'::text, 'participant_left'::text, 'meeting_ended'::text, 'watch_link_opened'::text])),
  provider_meeting_uuid text,
  participant_key       text,
  registrant_id         text,
  email_normalized      text,
  identity_match        text NOT NULL CHECK (identity_match = ANY (ARRAY['registrant_id'::text, 'email_exact'::text, 'registration_token'::text, 'unmatched'::text, 'host'::text])),
  occurred_at           timestamptz NOT NULL,
  leave_reason          text,
  dedupe_key            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- A matched identity names its person; an unmatched / host row never does (an anonymous join files nobody).
  CONSTRAINT event_attendance_evidence_identity_shape CHECK (
    (identity_match = ANY (ARRAY['registrant_id'::text, 'email_exact'::text, 'registration_token'::text]) AND contact_id IS NOT NULL)
    OR (identity_match = ANY (ARRAY['unmatched'::text, 'host'::text]) AND contact_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_attendance_evidence_dedupe ON public.event_attendance_evidence (dedupe_key);
CREATE INDEX IF NOT EXISTS event_attendance_evidence_event_contact_idx ON public.event_attendance_evidence (event_id, contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS event_attendance_evidence_brokerage_idx ON public.event_attendance_evidence (brokerage_id, created_at DESC);

ALTER TABLE public.event_attendance_evidence ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.event_attendance_evidence FROM anon, authenticated;
DROP POLICY IF EXISTS event_attendance_evidence_select ON public.event_attendance_evidence;
CREATE POLICY event_attendance_evidence_select ON public.event_attendance_evidence
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.event_attendance_evidence IS
  'C22 (wave 148, lane 148H; owner ruling 20): one provider participant event per row — Zoom meeting./webinar.participant_joined / _left, meeting.ended, or a registration-token watch-link open (YouTube). Written ONLY by lib/open-house/event-attendance.ts (service client, tenant from the event row). Attendance is DERIVED from matched join/leave pairs (registrant id or exact email of a registration of THIS event) — an unmatched join is recorded as evidence and never becomes a person''s attendance.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_open_house_attendees_event_contact
  ON public.open_house_attendees (event_id, contact_id) WHERE contact_id IS NOT NULL;

-- VERIFY (read-only, after applying):
--   SELECT column_name FROM information_schema.columns WHERE table_name='open_house_rsvp_tracking' ORDER BY ordinal_position;   -- 18 columns
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.event_attendance_evidence'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.event_attendance_evidence'::regclass;                -- event_attendance_evidence_select
--   SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_open_house_attendees_event_contact','uq_open_house_rsvp_provider_registrant','uq_event_attendance_evidence_dedupe');
-- Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts, scripts/check-vocabularies.ts, scripts/live-tables.ts.
--
-- ROLLBACK (owner SQL editor): DROP TABLE public.event_attendance_evidence; DROP INDEX uq_open_house_attendees_event_contact,
--   uq_open_house_rsvp_provider_registrant; DROP the four rsvp constraints and the ten rsvp columns added above.
