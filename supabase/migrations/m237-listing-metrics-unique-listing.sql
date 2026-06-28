-- m237 — make listing_metrics upsertable to ONE cumulative row per listing.
--
-- listing_metrics is read by every seller-facing proof-of-work surface (the portal
-- ListingActivityCard, resolve-seller-context, the seller-updates DOM calc) but had
-- ZERO writers — so sellers saw 0 views / 0 showings / 0 saves / 0 inquiries and DOM
-- computed to 0. The new listing-metrics rollup (lib/listings/listing-metrics-rollup.ts,
-- owned by Listing Concierge) aggregates the REAL written sources (showings,
-- saved_properties, listing_inquiries, property_views) into one cumulative row per
-- listing. The reader contract is "at most one row per listing" (resolve-seller-context
-- reads it with .maybeSingle()), so we maintain exactly one row per listing via UPSERT.
--
-- This unique index is the upsert conflict target. Dedupe-keep-latest first so the index
-- creates cleanly even if stray rows ever appear (the table is empty today).

-- Keep only the most-recent row per listing before enforcing uniqueness.
delete from public.listing_metrics lm
using public.listing_metrics dup
where lm.listing_id = dup.listing_id
  and lm.created_at < dup.created_at;

-- And collapse any exact-tie duplicates (same created_at) down to the lowest id.
delete from public.listing_metrics lm
using public.listing_metrics dup
where lm.listing_id = dup.listing_id
  and lm.created_at = dup.created_at
  and lm.id > dup.id;

create unique index if not exists uq_listing_metrics_listing
  on public.listing_metrics (listing_id);

comment on index public.uq_listing_metrics_listing is
  'm237: one cumulative metrics row per listing — upsert conflict target for the Listing Concierge rollup.';
