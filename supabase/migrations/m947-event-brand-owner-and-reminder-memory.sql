-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149F ──
--
-- m947 — C32 TENANT-BRANDED EVENTS + C29 ARBITER-OWNED REMINDERS (owner rulings 15 and 7).
--
-- 1. open_house_events.brand_owner — WHOSE brand an event speaks in. 'tenant' (the default, every existing row) = the creating
--    tenant's brand through THE cascade (lib/branding/resolve-brand-context.ts); 'platform' = the platform's OWN event (its brand
--    kit, lib/platform/product-brand.ts). Owner, 2026-11-03: "Event marketing cannot use 'VIPAgents' — it is the tenant's brand
--    name; the branded registration page is tenant-branded unless it is the platform's own event." Written ONLY by
--    lib/kernel/open-house.ts produceEventRow when app/actions/open-house.ts createOpenHouse has proven the SESSION user
--    holds a platform_role and is not impersonating (code gate; a CHECK cannot see the actor). Readers
--    (lib/open-house/event-marketing.ts resolveEventBrand) read it on its own and treat absent / unreadable as 'tenant'.
-- 2. open_house_rsvp_tracking.last_reminded_at / reminder_count — the ARBITER's memory of reminders already sent to a registration
--    (lib/open-house/event-touches.ts arbitrateEventTouches): evidence the arbiter reasons over ("reminded twice, last 20 h ago"),
--    never a schedule. Without these columns no reminder is sent (fail closed — the module says so).
--
-- Live state read before writing (2026-11-03, read-only): neither column exists; open_house_events and open_house_rsvp_tracking
-- carry 0 rows (lane 148H measured 0 on 2026-11-01; nothing since produced a registration).

ALTER TABLE public.open_house_events
  ADD COLUMN IF NOT EXISTS brand_owner text NOT NULL DEFAULT 'tenant';
ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_brand_owner_check;
ALTER TABLE public.open_house_events ADD CONSTRAINT open_house_events_brand_owner_check
  CHECK (brand_owner = ANY (ARRAY['tenant'::text, 'platform'::text]));
COMMENT ON COLUMN public.open_house_events.brand_owner IS
  'C32 (wave 149): whose brand the event speaks in — tenant (default; the creating tenant''s brand cascade) or platform (the platform''s own event, set only for platform staff). Never the platform name on a tenant event.';

ALTER TABLE public.open_house_rsvp_tracking
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_reminder_count_check;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_reminder_count_check CHECK (reminder_count >= 0);
COMMENT ON COLUMN public.open_house_rsvp_tracking.reminder_count IS
  'C29 (wave 149): reminders the ARBITER released for this registration (lib/open-house/event-touches.ts) — evidence, never a schedule.';

-- VERIFY (expect 1 row each; brand_owner default tenant; 0 rows outside the vocabulary):
--   SELECT column_name, column_default FROM information_schema.columns
--    WHERE table_schema='public' AND ((table_name='open_house_events' AND column_name='brand_owner')
--       OR (table_name='open_house_rsvp_tracking' AND column_name IN ('last_reminded_at','reminder_count')));
--   SELECT count(*) FROM public.open_house_events WHERE brand_owner <> 'tenant';
--
-- ROLLBACK (owner SQL editor — DROP COLUMN):
--   ALTER TABLE public.open_house_events DROP CONSTRAINT IF EXISTS open_house_events_brand_owner_check, DROP COLUMN IF EXISTS brand_owner;
--   ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_reminder_count_check,
--     DROP COLUMN IF EXISTS last_reminded_at, DROP COLUMN IF EXISTS reminder_count;
