-- supabase/migrations/m657-property-alerts-listing-type.sql
--
-- ── APPLIED LIVE 2026-09-21 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- Lane 77C, blind spot (1) from the wave-76 open list: "rental alerts not
-- enrolled — property_alerts has no listing-type column".
--
-- THE GAP. lib/ai-isa/customer-context-tools.ts::buildSendMatchingListingsTool
-- already takes `listing_type: 'sale' | 'rent'` and, for a renter, searches
-- RentCast's RENTAL endpoint (searchRentcastRentalListings) with a MONTHLY-rent
-- budget. It then refused to enroll the standing alert for a renter, because
-- property_alerts (scripts/schema-snapshot.ts: agent_user_id … zip_codes, no
-- listing-type column) could only describe a for-sale search, and
-- lib/property-alerts/idx-alert-search.ts would have re-run the renter's
-- monthly budget against for-sale list prices on every sweep. So a renter got
-- the listings once and never again — the "keep sending as new matches come
-- in" half of the tool was silently missing for one persona.
--
-- THE COLUMN. One text column with a CHECK, defaulting to 'sale' so every
-- existing row and every existing writer (lib/buyer-search/written-criteria-
-- alert.ts, lib/voice/call-analysis.ts, app/actions/property-alerts/
-- alert-actions.ts, app/actions/instant-property-alerts.ts) keeps its meaning
-- byte-for-byte. Only the AI qualification tool writes 'rent' today.
--
-- READERS THAT HONOUR IT (same commit): lib/property-alerts/idx-alert-search.ts
-- routes a 'rent' alert to RentCast's rental endpoint and skips the two
-- FOR-SALE boards (the tenant's IDX feed and the brokerage's own `listings`
-- table, whose status/lifecycle vocabularies carry no rental spelling —
-- scripts/check-vocabularies.ts). The matcher (alert-matcher.ts) scores
-- list_price against min/max_price, which for a rental row IS the monthly rent
-- against the monthly budget — same arithmetic, no second scorer.
--
-- VOCABULARY. Until this applies, scripts/check-vocabularies.ts cannot carry
-- `property_alerts.listing_type` — that file is MACHINE-WRITTEN and
-- scripts/schema-cache-drift-guard.ts pins its body-sha256, so a hand-edit
-- fails offline (CLAUDE.md §3). The code-side spelling lives in ONE place,
-- lib/property-alerts/alert-matcher.ts::PROPERTY_ALERT_LISTING_TYPES
-- (["rent", "sale"]), and the integrator's regenerated cache must agree with
-- it — the check-vocabulary guard holds them together from then on.
--
-- AFTER APPLYING (integrator):
--   1. `npm run schema:regen` — schema-snapshot.ts gains the column,
--      check-vocabularies.ts gains  property_alerts.listing_type: ["rent", "sale"]
--   2. re-run `npm run -s test:check-vocabulary` and `npm run -s test:schema-cache-drift`
--   3. flip this header to the applied banner m654 carries on its line 3 (the
--      date + "via Supabase MCP apply_migration" form scripts/migration-status.ts
--      recognises) and the prose mention in lib/ai-isa/customer-context-tools.ts
--      (search "m657"). This instruction deliberately does not spell that
--      banner out: migration-status.ts reads the first 3000 bytes for BOTH
--      claims, and quoting the applied form here made this file read as
--      self-contradictory (lane 77C found that the hard way).
--
-- IDEMPOTENT: safe to re-run; the column and constraint are added only when absent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'property_alerts' AND column_name = 'listing_type'
  ) THEN
    ALTER TABLE public.property_alerts
      ADD COLUMN listing_type text NOT NULL DEFAULT 'sale';
    RAISE NOTICE 'm657: property_alerts.listing_type added (default sale)';
  ELSE
    RAISE NOTICE 'm657: property_alerts.listing_type already present — no change';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'property_alerts_listing_type_check' AND conrelid = 'public.property_alerts'::regclass
  ) THEN
    ALTER TABLE public.property_alerts
      ADD CONSTRAINT property_alerts_listing_type_check
      CHECK (listing_type IN ('sale', 'rent'));
    RAISE NOTICE 'm657: property_alerts_listing_type_check added (sale|rent)';
  ELSE
    RAISE NOTICE 'm657: property_alerts_listing_type_check already present — no change';
  END IF;
END $$;

COMMENT ON COLUMN public.property_alerts.listing_type IS
  'sale (default) | rent — which market the saved search sweeps. rent = min/max_price are a MONTHLY budget and the sweep uses the rental listing source only (lib/property-alerts/idx-alert-search.ts). m657.';
