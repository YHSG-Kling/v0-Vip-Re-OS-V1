-- supabase/migrations/m654-platform-prospects-demo-scheduled-status.sql
--
-- ── APPLIED LIVE 2026-09-20 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- Lane 76B. Owner verbatim (wave 76): "need to be sure the platform 'potential'
-- customers are being saved/created as 'potential' subscribers and if they do
-- decide to setup a demo or want to purchase a subscription we have a way for
-- the agents to create a demo appointment or given a way to either sign up
-- online or with a human."
--
-- THE MISSING STAGE. platform_prospects.status admits new|contacted|trial|
-- converted|lost (platform_prospects_status_check, live). A prospect who has
-- BOOKED A DEMO on a platform sales rep's calendar is neither 'contacted'
-- (that stamp means the platform's own cold intro went out — and the follow-up
-- sweep, lib/platform/prospect-followup.ts, keeps nudging a 'contacted' row)
-- nor 'trial' (no tenant exists yet). Without its own value the funnel cannot
-- count demos, the ops board cannot show them, and the cold follow-up loop
-- keeps emailing a person who already has a meeting on the calendar.
--
-- 'demo_scheduled' sits between contacted and trial. The demo booking writer
-- (lib/ai-isa/listing-appointment.ts::bookDemoAppointment → lib/platform/
-- prospect-capture.ts::markProspectDemoScheduled) stamps it; the follow-up
-- sweep reads ONLY new|contacted and therefore stops touching the row; the
-- growth board (app/dashboard/superadmin/growth) renders it with the demo time.
--
-- After applying: regenerate scripts/check-vocabularies.ts (CLAUDE.md §3) —
-- this lane hand-adds the literal there so check-vocabulary-guard agrees with
-- the CODE now and the regeneration will produce the identical line.

alter table public.platform_prospects
  drop constraint if exists platform_prospects_status_check;

alter table public.platform_prospects
  add constraint platform_prospects_status_check
  check (status = any (array['new'::text, 'contacted'::text, 'demo_scheduled'::text, 'trial'::text, 'converted'::text, 'lost'::text]));

comment on column public.platform_prospects.status is
  'Funnel stage: new → contacted → demo_scheduled → trial → converted | lost. demo_scheduled = a demo appointment is booked on a platform sales rep''s calendar (calendar_events.event_type=demo_appointment, entity_type=platform_prospect); the cold follow-up sweep never touches it. m654.';
