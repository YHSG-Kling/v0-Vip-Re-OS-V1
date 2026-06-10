-- m208 — listing property features + price-change tracking (Listing Concierge burn).
-- The workflow-intelligence proactive checks (septic inspection nudges, pool/solar
-- disclosure prep, flood-zone insurance reminders) and the income-engine price-drop
-- recommender have selected these since day one — the columns never existed, so the
-- checks never fired. Standard property attributes (BatchData/RentCast return them).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS has_pool             boolean,
  ADD COLUMN IF NOT EXISTS has_septic           boolean,
  ADD COLUMN IF NOT EXISTS has_solar            boolean,
  ADD COLUMN IF NOT EXISTS flood_zone           text,
  ADD COLUMN IF NOT EXISTS sub_category         text,
  ADD COLUMN IF NOT EXISTS last_price_change_at timestamptz;
