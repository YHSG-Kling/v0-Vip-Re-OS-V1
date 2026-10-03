-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m667 — ONE LISTING PRESENTATION PER BOOKED APPOINTMENT, AND D-ID IS ALWAYS THE
-- FIRST LIVE FACE (wave 87, lane 87B).
--
-- Live reads before writing (project hrvaqgvukzxfskkcrwbt, 2026-09-28):
--   · listing_presentations: 0 rows (count(*)=0, count(appointment_id)=0), indexes
--     idx_listing_presentations_agent / _appt (appointment_at) / _awaiting_release /
--     _pkey — NO uniqueness on appointment_id.
--   · brokerage_settings: 0 rows; live_agent_face_provider_order is TEXT[] NOT NULL
--     DEFAULT ARRAY['did','simli'] (m627) with no CHECK on its order.
-- Both statements therefore apply cleanly against the live data.
--
-- 1. Owner: "listing presentation prep which inlcudes the cma needs to be for a
--    seller as this is started from the listing appointmtent booking." The prep now
--    starts from the booking (lib/listing-presentation/booking-prep.ts) AND the
--    listing-presentation-prep cron is its safety net, so two producers can reach
--    one appointment. lib/workflow/intelligence/listing-presentation-builder.ts
--    reads first and returns the existing row; this index makes the race loser's
--    insert refuse with 23505 (which the builder re-reads) instead of landing a
--    second presentation — and with it a second seller drip.
CREATE UNIQUE INDEX IF NOT EXISTS listing_presentations_one_per_appointment
  ON public.listing_presentations (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- 2. Owner: "d-id is always first and the perferred." The session doors always start
--    D-ID first and the tenant-admin writer (lib/live-agent/face-render.ts
--    validateFaceProviderOrder) refuses any order that does not lead with it; the
--    read side now pins it first too (normalizeProviderOrder). This CHECK closes the
--    last path — a direct row write — so the stored setting can never say another
--    provider goes first.
ALTER TABLE public.brokerage_settings
  DROP CONSTRAINT IF EXISTS brokerage_settings_face_provider_did_first;
ALTER TABLE public.brokerage_settings
  ADD CONSTRAINT brokerage_settings_face_provider_did_first
  CHECK (live_agent_face_provider_order[1] = 'did');
