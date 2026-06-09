-- m192 — unique (contact_id, property_id) for property_matches.
--
-- The matchers (app/actions/ai-property-matching.ts generatePropertyMatches + the new
-- scheduled lib/buyer-search/market-watch.ts) upsert with onConflict=(contact_id, property_id),
-- but NO unique constraint existed — so every upsert errored ("no unique or exclusion
-- constraint matching the ON CONFLICT specification") and NO matches were ever written.
-- This adds the partial unique index so both matchers write idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS property_matches_contact_property_uniq
  ON public.property_matches (contact_id, property_id)
  WHERE contact_id IS NOT NULL AND property_id IS NOT NULL;
