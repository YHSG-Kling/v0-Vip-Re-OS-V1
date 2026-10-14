-- m300-vendor-invoice-billed-to-vendor.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MIGRATION THE CODE WAS WAITING FOR.
--
-- app/dashboard/vendors/page.tsx reads the brokerage's general tenant→vendor
-- charges with `billed_to = 'vendor'`, and says so in its own comment:
--
--   // General tenant→vendor charges (billed_to='vendor' — migration 1104). Safe
--   // pre-migration: the filter simply matches no rows.
--
-- That migration never landed. vendor_invoices.billed_to still admits only
-- brokerage | contact, so the panel has always rendered empty — correctly, and
-- by design, but permanently. The comment is honest about the mechanism and
-- wrong about it being temporary.
--
-- This is the opposite of the other findings in this sweep: the code is not
-- drifted, it is AHEAD, and the fix is to finish what it was written against
-- rather than to bend the code back. billed_to names WHO IS BILLED, and a charge
-- the brokerage raises against a vendor is billed to the vendor — a third party
-- alongside the brokerage itself and a contact.
--
-- Additive: nothing previously accepted is now rejected.

ALTER TABLE public.vendor_invoices
  DROP CONSTRAINT IF EXISTS vendor_invoices_billed_to_check;

ALTER TABLE public.vendor_invoices
  ADD CONSTRAINT vendor_invoices_billed_to_check CHECK (
    billed_to = ANY (ARRAY['brokerage', 'contact', 'vendor'])   -- m300
  );
