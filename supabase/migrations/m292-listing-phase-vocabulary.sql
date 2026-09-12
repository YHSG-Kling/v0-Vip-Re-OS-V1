-- m292-listing-phase-vocabulary.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- OWNER-STATED LISTING PHASES:
--
--   listing signed → coming soon → active → withdrawn / cancelled / off market / sold
--
-- A listing is inventory. The DEAL against it is a transaction and carries its
-- own ladder (m291) — which is why `under_contract` does NOT belong here.
--
-- listings.status was missing three of the seven phases outright:
--
--   listing_signed  the agreement is executed, pre-market prep has begun
--   cancelled       terminated by agreement — distinct from withdrawn
--   off_market      taken off market without terminating the relationship
--
-- ADDITIVE ONLY, by owner direction: draft, pending and expired stay valid and
-- no row moves. Nothing that was accepted before is rejected now, so no reader
-- can break on this migration.

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_status_check;

ALTER TABLE public.listings
  ADD CONSTRAINT listings_status_check CHECK (
    status = ANY (ARRAY[
      'draft',
      'listing_signed',   -- m292: agreement executed, pre-market
      'coming_soon',
      'active',
      'pending',
      'withdrawn',
      'cancelled',        -- m292
      'off_market',       -- m292
      'expired',
      'sold'
    ])
  );
