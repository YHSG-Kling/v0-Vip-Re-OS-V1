-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148Z ──
--
-- m926 — C22, THE SIXTH EVENT KIND: `client_event` (client appreciation / holiday gathering for past clients and their sphere).
--
-- WHY (lane 148H Still open 5, owner ruling 22 "go with the recommendation on every recorded open item"): the sphere's event
-- invitation generator (app/actions/ai-sphere-management.ts aiGenerateEventInvitation) drafted copy for client-appreciation and
-- holiday events that NOTHING stored, registered or verified. Lane 148H recommended a sixth kind; ruling 22 takes it. Every
-- event is one row of open_house_events ("one place everything feeds into", ruling 14) — so the kind is added to the ONE
-- vocabulary, never a second events table.
--
-- WHAT IT IS (lib/open-house/event-registry.ts EVENT_PRODUCER_REGISTRY.client_event): consumer audience, IN PERSON, no listing,
-- produced by the ONE scheduling door (app/actions/open-house.ts createOpenHouse), registered through the C15 form, attended at
-- the kiosk sign-in or the agent's walk-in check-in.
--
-- The live definitions were READ before writing (pg_get_constraintdef, 2026-11-01): they equal m924's. Each CHECK below is that
-- definition with `client_event` added — nothing else changes.
--
-- 1. open_house_events.event_type gains 'client_event'.
-- 2. open_house_events_listing_anchor: a client event has no listing (like webinar / education_session).
-- 3. open_house_events_venue_matches_kind: a client event is in person (virtual_provider IS NULL).
-- 4. open_house_invitations.invitation_type gains 'client_event' (the invitation a client event sends).

ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_event_type_check;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_event_type_check
  CHECK (event_type = ANY (ARRAY['open_house'::text, 'broker_open'::text, 'virtual_open_house'::text, 'webinar'::text, 'education_session'::text, 'client_event'::text]));

ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_listing_anchor;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_listing_anchor
  CHECK (listing_id IS NOT NULL OR event_type = ANY (ARRAY['webinar'::text, 'education_session'::text, 'client_event'::text]));

ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_venue_matches_kind;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_venue_matches_kind
  CHECK (
    (event_type = ANY (ARRAY['open_house'::text, 'broker_open'::text, 'client_event'::text]) AND virtual_provider IS NULL)
    OR (event_type = ANY (ARRAY['virtual_open_house'::text, 'webinar'::text]) AND virtual_provider IS NOT NULL)
    OR event_type = 'education_session'::text
  );

ALTER TABLE public.open_house_invitations DROP CONSTRAINT IF EXISTS open_house_invitations_invitation_type_check;
ALTER TABLE public.open_house_invitations ADD CONSTRAINT open_house_invitations_invitation_type_check
  CHECK (invitation_type = ANY (ARRAY['open_house'::text, 'broker_preview'::text, 'virtual_open_house'::text, 'webinar'::text, 'education_session'::text, 'client_event'::text]));

-- VERIFY (run after applying; each must return the definition above, with 'client_event'):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('open_house_events_event_type_check',
--     'open_house_events_listing_anchor','open_house_events_venue_matches_kind','open_house_invitations_invitation_type_check');
-- Then regenerate scripts/check-vocabularies.ts (open_house_events.event_type, open_house_invitations.invitation_type — lane 148Z
-- hand-mirrored exactly those two arrays so code and cache agree until the regeneration).
--
-- ROLLBACK (only while no row carries 'client_event' — check first: SELECT count(*) FROM open_house_events WHERE event_type =
-- 'client_event'; SELECT count(*) FROM open_house_invitations WHERE invitation_type = 'client_event'): re-run m924's four
-- ADD CONSTRAINT statements for these constraints.
