-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149F ──
--
-- m948 — THE SESSION HANDOUT'S DELIVERY PATH (lane 148H Still open 3).
--
-- The C22 registry (lib/open-house/event-registry.ts) promises a `session_handout` on webinars and education sessions, and nothing
-- could deliver it: there was no place to record the handout. open_house_events.handout_url is that place — the https link to the
-- handout, set by app/actions/open-house.ts setEventHandout (tenant from the session; an agent only on their own events), read by
-- lib/open-house/event-attendance.ts deliverEventHandout, which sends it ONCE per registration in the approved words, through the
-- governed dispatcher, ledgered `open_house.handout.deliver`. Mirrors replay_url (m924) and its https CHECK.
--
-- Live state read before writing (2026-11-03): the column does not exist; open_house_events has 0 rows.

ALTER TABLE public.open_house_events ADD COLUMN IF NOT EXISTS handout_url text;
ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_handout_url_https;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_handout_url_https
  CHECK (handout_url IS NULL OR handout_url ~ '^https://');
COMMENT ON COLUMN public.open_house_events.handout_url IS
  'Wave 149 (149F): the promised session handout (https). Delivered once per registration by deliverEventHandout only when set.';

-- VERIFY: SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='open_house_events' AND column_name='handout_url';
-- ROLLBACK (owner SQL editor): ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_handout_url_https, DROP COLUMN IF EXISTS handout_url;
