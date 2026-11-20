-- ── APPLIED LIVE 2026-11-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 149, lane 149D ──
--
-- m942 — lead_capture_forms: THE CREATOR and THE QR CODE of a lead-magnet package (wave 149, lane 149D — contract C30;
-- owner rulings 10 and 11, 2026-11-03):
--   10. "Do not assume the tenant is a brokerage — solo agent, team or brokerage; the user who creates the lead magnet in their
--       dashboard is tied to their user id."
--   11. "Lead magnets and events carry a QR code to the landing page."
--
-- WHY COLUMNS (and not settings jsonb):
--   · created_by_user_id — until now the creator lived only in lifecycle_events.actor_user_id (the lead_magnet_created echo)
--     and, for a published magnet, settings.lifecycle.approved_by (the PUBLISHER, not the creator). A solo agent, a team member
--     and a brokerage admin each own what they create; the FK (users.id — agents.id is DISJOINT, CLAUDE.md §3) lets the
--     dashboard, transfer and the ledger read the owner without parsing jsonb.
--   · qr_code_id — the package mints ONE tracked QR to the landing page (lib/kernel/lead-magnets.ts generateQRCode →
--     lib/marketing/tracked-qr.ts, deduped on label 'lead_magnet:<form id>'). The FK names it from the magnet's side so the
--     package, the library and the print surfaces read one link (a QR whose row is deleted leaves NULL, never a dangling id).
--   · The package ORDER (magnet → landing_page → funnel) is EVIDENCE, recorded on the ledger row
--     (agent_action_ledger.detail.order of marketing.lead_magnet_funnel.create) and in settings.package — no column: nothing
--     filters on it, and a CHECKed column would pin a waypoint.
--
-- WRITERS: created_by_user_id — lib/kernel/lead-magnets.ts createLeadMagnet (the ONE writer of lead_capture_forms; resolves the
-- creator: a users.id in the tenant, or an agents.id crossed via agents.user_id; else NULL). qr_code_id —
-- lib/lead-magnets/lead-magnet-package.ts createLeadMagnetPackage (tenant-pinned, counted update). READERS:
-- lib/lead-magnets/lead-magnet-package.ts createLeadMagnetPackage (re-reads both on the drafted form; the package reports them).
--
-- BACKFILL (idempotent; only NULLs are filled; nothing invented):
--   created_by_user_id ← the earliest lead_magnet_created lifecycle event's actor_user_id for the form (a users.id by its FK),
--                        else the owner agent's users.id (agents.user_id via lead_capture_forms.agent_id) — the person the
--                        magnet was filed to, the honest default for rows written before the creator was recorded.
--   qr_code_id         ← the tenant's qr_codes row labelled 'lead_magnet:<form id>' (the ONE lead-magnet QR identity).

BEGIN;

ALTER TABLE public.lead_capture_forms
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qr_code_id uuid NULL REFERENCES public.qr_codes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.lead_capture_forms.created_by_user_id IS
  'Wave 149 (149D, ruling 10): users.id of the person who created this lead magnet (solo agent / team member / brokerage admin). Written by createLeadMagnet; agents.id is disjoint (crossed via agents.user_id).';
COMMENT ON COLUMN public.lead_capture_forms.qr_code_id IS
  'Wave 149 (149D, ruling 11, C30): the tracked QR (qr_codes, label lead_magnet:<id>) that points at this magnet''s landing page on the tenant site.';

CREATE INDEX IF NOT EXISTS lead_capture_forms_creator_idx ON public.lead_capture_forms (brokerage_id, created_by_user_id) WHERE created_by_user_id IS NOT NULL;

-- Backfill 1 — the creator from the create echo (earliest), tenant-matched.
UPDATE public.lead_capture_forms f
   SET created_by_user_id = ev.actor_user_id
  FROM (
    SELECT DISTINCT ON (le.entity_id) le.entity_id, le.actor_user_id
      FROM public.lifecycle_events le
      JOIN public.users u ON u.id = le.actor_user_id
     WHERE le.entity_type = 'lead_capture_form'
       AND le.event_type = 'lead_magnet_created'
       AND le.actor_user_id IS NOT NULL
     ORDER BY le.entity_id, le.created_at ASC
  ) ev
 WHERE f.id = ev.entity_id
   AND f.created_by_user_id IS NULL;

-- Backfill 2 — the owner agent's seat for rows the echo never recorded.
UPDATE public.lead_capture_forms f
   SET created_by_user_id = a.user_id
  FROM public.agents a
 WHERE a.id = f.agent_id
   AND a.brokerage_id = f.brokerage_id
   AND a.user_id IS NOT NULL
   AND f.created_by_user_id IS NULL;

-- Backfill 3 — the magnet's ONE QR (label lead_magnet:<id>), same tenant; the newest active row when there are several.
UPDATE public.lead_capture_forms f
   SET qr_code_id = q.id
  FROM (
    SELECT DISTINCT ON (q.label, q.brokerage_id) q.id, q.label, q.brokerage_id
      FROM public.qr_codes q
     WHERE q.label LIKE 'lead_magnet:%'
     ORDER BY q.label, q.brokerage_id, q.is_active DESC NULLS LAST, q.created_at DESC
  ) q
 WHERE q.label = 'lead_magnet:' || f.id::text
   AND q.brokerage_id = f.brokerage_id
   AND f.qr_code_id IS NULL;

COMMIT;

-- VERIFY (integrator, read-only):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'lead_capture_forms' AND column_name IN ('created_by_user_id', 'qr_code_id');
--   SELECT conname, confrelid::regclass FROM pg_constraint WHERE conrelid = 'public.lead_capture_forms'::regclass AND contype = 'f';
--   SELECT count(*) FILTER (WHERE created_by_user_id IS NULL) AS no_creator, count(*) FILTER (WHERE qr_code_id IS NOT NULL) AS with_qr, count(*) FROM public.lead_capture_forms;
