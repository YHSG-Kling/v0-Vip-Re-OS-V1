-- m260 — Vendor earnings booking link (the marketplace take-rate income stream).
--
-- The platform fee was coded but dormant: vendor_earnings only ever linked to an invoice (invoice_id),
-- so a vendor booking that COMPLETED generated no earning — the marketplace never captured its take-rate
-- on real activity. This adds a booking_id link so the auto-capture sweep
-- (lib/vendors/marketplace-earnings-capture.ts, finance_manager) creates ONE earning per completed
-- booking, idempotently. Invoice-sourced earnings keep booking_id null.

alter table public.vendor_earnings
  add column if not exists booking_id uuid references public.vendor_bookings(id) on delete set null;

-- One earning per booking (the sweep relies on this to never double-charge a booking).
create unique index if not exists uq_vendor_earnings_booking
  on public.vendor_earnings (booking_id) where booking_id is not null;
