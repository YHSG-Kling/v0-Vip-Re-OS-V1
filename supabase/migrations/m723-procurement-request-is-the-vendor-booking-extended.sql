-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
-- m723 (wave 107, lane 107B) — MARKETPLACE PROCUREMENT: the owner's PROCUREMENT_REQUEST is the EXISTING
-- vendor_bookings row extended, never a parallel request table (owner: "Don't build if capability is
-- already present, only improve").
--
-- Survivor map (lib/kernel/procurement.ts PROCUREMENT_REQUEST_FIELDS is the code mirror):
--   service           vendor_bookings.service_type            (existing)
--   property          vendor_bookings.listing_id / transaction_id / contact_id (existing)
--   territory         vendor_bookings.territory               (NEW — the job's {state, zip} the ranking judged)
--   needed_by         vendor_bookings.needed_by               (NEW; scheduled_date stays the BOOKED slot)
--   budget            vendor_bookings.budget                  (NEW; cost stays the BOOKED price)
--   requirements      vendor_bookings.requirements            (NEW jsonb; request_message stays free text)
--   preferred_vendors vendor_bookings.preferred_vendor_ids    (NEW)
--   quotes            vendor_booking_quotes                   (NEW — no quote/bid OBJECT existed: the only
--                     quote rail, lib/transactions/vendor-quote-workflow.ts, is a TC's client-approval TASK
--                     carrying one amount in activities.metadata for inspector/insurance — no vendor row,
--                     no vendor isolation, nothing to compare)
--   selected_vendor   vendor_bookings.vendor_id               (existing; the top-ranked or approved pick)
--   recommendation    vendor_bookings.recommendation          (NEW jsonb: ranked candidates + per-factor reasons)
--   approval          vendor_bookings.approval_status / approved_by / approved_at / approval_policy_ref /
--                     approval_message_id                     (NEW; the queue itself is the existing
--                     agent_client_messages proposal rail, entity_type 'vendor_booking')
--   payment           vendor_invoices.booking_id → vendor_earnings → vendor_payouts (existing; derived)
--   completion        vendor_bookings.status 'completed' + completed_at (existing)
--   review            vendor_bookings.agent_rating → vendor_ratings / vendors.rating (existing rollup)
--
-- vendor_bookings.status gains 'requested' (a recommendation awaiting approval — the booking writer
-- moves it to 'booked'). Nobody else widens this CHECK in wave 107 to this lane's knowledge.
--
-- Apply in TWO parts (wave 98 rule). AFTER APPLYING: regenerate the vocabulary cache (vendor_bookings
-- status + approval_status, vendor_booking_quotes.status), the schema snapshot, the FK map and live-tables.

-- ══════════════════════════════ PART A — columns, CHECKs, table, RLS ══════════════════════════════

ALTER TABLE public.vendor_bookings
  ADD COLUMN IF NOT EXISTS needed_by            date,
  ADD COLUMN IF NOT EXISTS budget               numeric(12,2),
  ADD COLUMN IF NOT EXISTS requirements         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS preferred_vendor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS territory            jsonb,
  ADD COLUMN IF NOT EXISTS recommendation       jsonb,
  ADD COLUMN IF NOT EXISTS approval_status      text,
  ADD COLUMN IF NOT EXISTS approved_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at          timestamptz,
  ADD COLUMN IF NOT EXISTS approval_policy_ref  text,
  ADD COLUMN IF NOT EXISTS approval_message_id  uuid REFERENCES public.agent_client_messages(id) ON DELETE SET NULL;

ALTER TABLE public.vendor_bookings DROP CONSTRAINT IF EXISTS vendor_bookings_budget_check;
ALTER TABLE public.vendor_bookings ADD CONSTRAINT vendor_bookings_budget_check
  CHECK (budget IS NULL OR budget >= 0);

ALTER TABLE public.vendor_bookings DROP CONSTRAINT IF EXISTS vendor_bookings_approval_status_check;
ALTER TABLE public.vendor_bookings ADD CONSTRAINT vendor_bookings_approval_status_check
  CHECK (approval_status IS NULL OR approval_status IN ('pending', 'approved', 'auto_approved', 'declined'));

ALTER TABLE public.vendor_bookings DROP CONSTRAINT IF EXISTS vendor_bookings_status_check;
ALTER TABLE public.vendor_bookings ADD CONSTRAINT vendor_bookings_status_check
  CHECK (status IN ('requested', 'booked', 'confirmed', 'completed', 'cancelled', 'no_show')) NOT VALID;
ALTER TABLE public.vendor_bookings VALIDATE CONSTRAINT vendor_bookings_status_check;

CREATE TABLE IF NOT EXISTS public.vendor_booking_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE RESTRICT,
  booking_id    uuid NOT NULL REFERENCES public.vendor_bookings(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
  available_on  date,
  notes         text,
  status        text NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'accepted', 'declined', 'withdrawn')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, vendor_id)
);

ALTER TABLE public.vendor_booking_quotes ENABLE ROW LEVEL SECURITY;

-- Tenant staff: their own brokerage's quotes (same predicate as vb_brokerage on vendor_bookings).
DROP POLICY IF EXISTS vbq_brokerage ON public.vendor_booking_quotes;
CREATE POLICY vbq_brokerage ON public.vendor_booking_quotes FOR SELECT
  USING (brokerage_id = public.current_user_brokerage_id());

-- A vendor seat reads ONLY its own quotes (same predicate as vendor_bookings_vendor_read_own) —
-- never a competitor's amount on the same request.
DROP POLICY IF EXISTS vbq_vendor_read_own ON public.vendor_booking_quotes;
CREATE POLICY vbq_vendor_read_own ON public.vendor_booking_quotes FOR SELECT
  USING (vendor_id IN (SELECT ura.vendor_id FROM public.user_role_assignments ura
                       WHERE ura.user_id = auth.uid() AND ura.vendor_id IS NOT NULL));

-- Writes go through the service client only (lib/kernel/procurement.ts, gated by requireVendorActor /
-- the session tenant before the service client is used).
REVOKE INSERT, UPDATE, DELETE ON public.vendor_booking_quotes FROM anon, authenticated;

-- ══════════════════════════════ PART B — indexes ══════════════════════════════

CREATE INDEX IF NOT EXISTS vendor_booking_quotes_booking_idx ON public.vendor_booking_quotes (booking_id);
CREATE INDEX IF NOT EXISTS vendor_booking_quotes_vendor_idx  ON public.vendor_booking_quotes (vendor_id, brokerage_id);
CREATE INDEX IF NOT EXISTS vendor_bookings_requested_idx ON public.vendor_bookings (brokerage_id, status)
  WHERE status = 'requested';
