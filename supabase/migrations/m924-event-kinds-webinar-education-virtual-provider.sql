-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148H ──
--
-- m924 — C22 THE EVENT PRODUCER REGISTRY, storage half (owner ruling 14, 2026-11-01: "any event needs producers or one place
-- all feeds into"; ruling 20: "we use Zoom so maybe use that for virtual open house? or YouTube Live?").
--
-- ONE PLACE EVERYTHING FEEDS INTO: open_house_events is already the survivor for every event this OS runs — its producer
-- (app/actions/open-house.ts createOpenHouse), invitations, RSVPs, attendees, feedback, the kiosk, the join door, the reminder
-- and follow-up crons all key on it. Webinars and education sessions had NO table and NO producer (grepped at ebed6c44:
-- app/actions/ai-sphere-management.ts aiGenerateEventInvitation drafts copy for an "educational_seminar" and nothing stores,
-- registers or verifies one). They join the survivor instead of a fourth event system (constitution law 2).
--
-- Measured live 2026-11-01 (read-only): open_house_events 0 rows, open_house_invitations 0, open_house_rsvp_tracking 0,
-- open_house_attendees 0 — every constraint below validates against an empty table.
--
-- 1. event_type gains 'webinar' and 'education_session'. The registry (lib/open-house/event-registry.ts EVENT_KINDS) and the
--    ONE scheduling door's refusing list (createOpenHouse OPEN_HOUSE_EVENT_TYPES) carry the same five spellings; the census in
--    scripts/event-producer-registry-guard.ts holds CHECK = registry = producer list.
-- 2. listing_id stops being NOT NULL ONLY for the two kinds that are not about one listing: a webinar / education session is
--    about buying, selling, financing or the market. Every listing-anchored kind keeps its listing (CHECK below).
-- 3. The virtual provider an online event is hosted on, and the provider's own meeting id (the key the Zoom participant
--    webhook arrives with): virtual_provider ∈ zoom | youtube | external_link; provider_meeting_id; provider_meta (host owner,
--    registration_enabled as Zoom ANSWERED it — never as requested); replay_url (the recording a registrant who could not
--    attend is offered — an asset that must exist before it is promised as delivered).
-- 4. marketing_assets — the AI-drafted registration-page + invitation copy, held for approval (C5 approver) BEFORE the page is
--    published (is_published) or an invitation leaves. External publication is a human's call (preamble).
-- 5. invitation_type and the RSVP source gain the spellings the new kinds and the public registration page write.

ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_event_type_check;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_event_type_check
  CHECK (event_type = ANY (ARRAY['open_house'::text, 'broker_open'::text, 'virtual_open_house'::text, 'webinar'::text, 'education_session'::text]));

ALTER TABLE public.open_house_events ALTER COLUMN listing_id DROP NOT NULL;
ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_listing_anchor;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_listing_anchor
  CHECK (listing_id IS NOT NULL OR event_type = ANY (ARRAY['webinar'::text, 'education_session'::text]));

ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS virtual_provider text;
ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS provider_meeting_id text;
ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS provider_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS replay_url text;
ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS marketing_assets jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_virtual_provider_check;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_virtual_provider_check
  CHECK (virtual_provider IS NULL OR virtual_provider = ANY (ARRAY['zoom'::text, 'youtube'::text, 'external_link'::text]));
-- An in-person kind is never hosted online; an online-only kind always names its host. education_session may be either.
ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_venue_matches_kind;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_venue_matches_kind
  CHECK (
    (event_type = ANY (ARRAY['open_house'::text, 'broker_open'::text]) AND virtual_provider IS NULL)
    OR (event_type = ANY (ARRAY['virtual_open_house'::text, 'webinar'::text]) AND virtual_provider IS NOT NULL)
    OR event_type = 'education_session'::text
  );
-- A replay is a URL a person will open — https only (the same rule the join door applies to check_in_url).
ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_replay_url_https;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_replay_url_https
  CHECK (replay_url IS NULL OR replay_url ~ '^https://');

-- The Zoom participant webhook arrives with the meeting id; one event per provider meeting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_house_events_provider_meeting
  ON public.open_house_events (virtual_provider, provider_meeting_id) WHERE provider_meeting_id IS NOT NULL;

ALTER TABLE public.open_house_invitations DROP CONSTRAINT IF EXISTS open_house_invitations_invitation_type_check;
ALTER TABLE public.open_house_invitations ADD CONSTRAINT open_house_invitations_invitation_type_check
  CHECK (invitation_type = ANY (ARRAY['open_house'::text, 'broker_preview'::text, 'virtual_open_house'::text, 'webinar'::text, 'education_session'::text]));

ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_source_check;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_source_check
  CHECK (source = ANY (ARRAY['email'::text, 'sms'::text, 'qr_code'::text, 'walk_in'::text, 'ai_reception'::text, 'web_registration'::text]));

COMMENT ON COLUMN public.open_house_events.virtual_provider IS
  'C22 (wave 148, lane 148H): where an online event is hosted — zoom (participant webhooks VERIFY attendance), youtube (registration-gated watch link; YouTube exposes no per-viewer identity, so attendance is never claimed), external_link (attendance unverifiable). Routed through routeCapability(virtual_event_hosting | live_broadcast).';
COMMENT ON COLUMN public.open_house_events.provider_meta IS
  'C22: { host_owner_type, host_owner_id, registration_enabled (as the provider ANSWERED, never as requested), provider_join_url }. Written by createOpenHouse only.';
COMMENT ON COLUMN public.open_house_events.marketing_assets IS
  'C22: the AI-drafted registration page + invitation copy { status: awaiting_approval | approved, draft, fair_housing, drafted_at, approved_by, approved_at }. The registration page renders only once approved (is_published).';

-- VERIFY (read-only, after applying):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('open_house_events_event_type_check','open_house_events_listing_anchor','open_house_events_venue_matches_kind','open_house_events_virtual_provider_check','open_house_events_replay_url_https','open_house_invitations_invitation_type_check','open_house_rsvp_tracking_source_check');
--   SELECT is_nullable FROM information_schema.columns WHERE table_name='open_house_events' AND column_name='listing_id';   -- YES
--   SELECT indexname FROM pg_indexes WHERE indexname='uq_open_house_events_provider_meeting';
-- Then regenerate scripts/check-vocabularies.ts and scripts/schema-snapshot.ts (generated caches — never hand-edited).
--
-- ROLLBACK (owner SQL editor; only while no webinar / education_session row exists):
--   restore the three CHECK lists above to their pre-m924 values, DROP the listing_anchor / venue / provider / replay CHECKs,
--   ALTER COLUMN listing_id SET NOT NULL, DROP INDEX uq_open_house_events_provider_meeting, and DROP the five columns.
