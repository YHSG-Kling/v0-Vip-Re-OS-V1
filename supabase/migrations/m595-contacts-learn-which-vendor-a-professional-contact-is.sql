-- m595 — contacts learn WHICH vendor a professional contact is
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-09-01.
-- Verified after applying: contacts.vendor_id present (count=1). (§3: files are not the
-- database; lanes write migrations, only the integrator applies them).
--
-- WHY. contact_type legitimately admits 'vendor' and 'referral_partner'
-- (contacts_contact_type_check, m593), so the CRM can HOLD a professional
-- contact — but contacts had NO identity bridge to the vendor bench. Every
-- existing contacts↔vendors table is a RELATIONSHIP, not an identity:
--   contact_vendors     "this vendor was introduced to this client"
--   vendor_bookings     "this vendor is booked on this job"
-- None can answer "this contact IS the person at that vendor company". The
-- unapplied scripts/250-add-contact-agent-referral-tracking.sql tried to solve
-- the same need by DENORMALIZING vendor facts onto contacts (vendor_type,
-- service_area TEXT, rating SMALLINT, total_transactions …) — stored copies
-- with no writer, one of them a free-text geography the measured grain ruling
-- at lib/vendors/vendor-service-area.ts:44-70 forbids outright.
--
-- ONE FK resolves all of it with ZERO stored aggregates:
--   rating        → vendor_id → vendors.rating   (rollups: vendor_ratings)
--   service_area  → vendor_id → vendors.platform_vendor_id →
--                   vendor_service_areas (state + zip_code grain — the two-hop
--                   lib/vendors/vendor-service-area.ts +
--                   app/actions/vendor-service-areas.ts already implement)
--   vendor_type   → vendor_id → vendors.category (already the survivor named
--                   by the vendor_type tombstone in types/contact.ts)
-- The read side is already written to be safe both BEFORE and AFTER this
-- applies: lib/services/contact-management.service.ts getContact fetches the
-- vendor join as a separate best-effort query keyed on the row's vendor_id
-- (absent until this lands → the block no-ops; refused → {error} read and the
-- derived fields stay absent, never a crash, never a silent zero).
--
-- CONSIDERED AND REJECTED: a CHECK tying vendor_id to
-- contact_type IN ('vendor','referral_partner'). A professional contact can be
-- RE-TYPED (a stager who becomes a seller keeps being the same person at the
-- same company); a CHECK would force dropping the identity link — or refuse the
-- re-type — to record a life event. The FK carries no such coupling.

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN vendor_id uuid REFERENCES public.vendors(id);

COMMENT ON COLUMN public.contacts.vendor_id IS
  'Identity bridge: this professional contact IS (a person at) this vendor bench row. Derived reads hang off it (rating, coverage); nothing vendor-shaped is stored on contacts. m595.';

-- Partial: almost every contact is a client, not a professional — index only
-- the rows that carry the bridge.
CREATE INDEX idx_contacts_vendor_id
  ON public.contacts (vendor_id)
  WHERE vendor_id IS NOT NULL;

COMMIT;

-- AFTER APPLYING (integrator): regenerate the schema caches so the guards see
-- the new column — scripts/generate-schema-snapshot.ts (contacts gains
-- vendor_id) and scripts/generate-schema-fk-map.ts (contacts gains
-- vendor_id → vendors). No CHECK is added, so the vocabulary cache is
-- unaffected.
