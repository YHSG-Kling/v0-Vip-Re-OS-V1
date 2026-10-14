-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m673 — ONE `listing.appointment_set` LIFECYCLE EVENT PER LISTING-APPOINTMENT BOOKING
-- (wave 88, lane 88D).
--
-- Owner, wave 88: "listing appointment already coded and built the listing prep or
-- listing presentation/cma automation with drip including video sections … you now
-- just wrote it again in the last wave." The ORIGINAL chain
-- (lib/workflow-orchestrator/chains/listing-appt-prep.ts, trigger
-- `listing.appointment_set`) is the survivor; lane 87B's second starter is retired onto
-- its foot (fireListingAppointmentSetForBooking).
--
-- Live reads before writing (project hrvaqgvukzxfskkcrwbt, 2026-09-28):
--   · workflow_runs.trigger_event_id is uuid with FK workflow_runs_trigger_event_id_fkey
--     → lifecycle_events(id). Lane 87B keyed the prep run on calendar_events.id (and
--     book-seller-appointment had since it was written) — a 23503 on every insert, so no
--     booking ever produced a run. The survivor keys the run on the EVENT, which is what
--     the FK demands; this migration does NOT touch the FK.
--   · lifecycle_events: 285 rows, 0 with event_type = 'listing.appointment_set'; indexes
--     include idx_le_dedupe (dedupe_key) — NOT unique — and idx_lifecycle_unique_event
--     (entity_type, entity_id, event_type, created_at), which cannot stop two inserts
--     a millisecond apart. No CHECK on event_type / entity_type.
--   · workflow_runs: 0 rows; listing_presentations: 0 rows (m667's one-per-appointment
--     index is live).
-- The index below therefore builds cleanly against the live data.
--
-- WHY. The chain's trigger reads for this booking's event (dedupe_key
-- 'listing.appointment_set:<calendar_events.id>', no time window) before recording one.
-- Two booking paths racing on one appointment (the agent calendar and the cron safety
-- net, or a double-submitted confirm) could both read "none" and both insert — two
-- events, two runs, two CMAs bought and two chapter-reel batches rendered for one seller.
-- m667 already keeps it to one presentation; this keeps it to ONE EVENT, so ONE RUN. The
-- race loser's insert refuses with 23505 and the trigger re-reads the winner.
--
-- Scoped to this event type, so no other lifecycle event's dedupe semantics change.

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_events_one_listing_appointment_set_per_booking
  ON public.lifecycle_events (brokerage_id, dedupe_key)
  WHERE event_type = 'listing.appointment_set' AND dedupe_key IS NOT NULL;
