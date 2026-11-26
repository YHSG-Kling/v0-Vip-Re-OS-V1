-- ── APPLIED LIVE 2026-11-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150W ──
--
-- m991 — A SAVED HOME CARRIES ITS ORIGIN (owner ruling 2026-11-06, wave 150 lane 150W):
--   "the portal DISPLAYS RentCast sale listings (facts, with the MLS name shown as the source) and a buyer may SAVE one —
--    a saved home carries its origin (idx_mls | rentcast_listing with the RentCast listing id + MLS number | buyer_url),
--    and a buyer may also save a home by pasting the property's URL, stored as `source_url` on the saved home and
--    resolved to an address + RentCast facts where possible (the existing saved_properties / property_interests
--    survivor, never a second table)."
--
-- SURVIVOR: public.saved_properties (live 2026-11-06: 0 rows; property_interests is the CRITERIA table, 0 rows).
-- ONE VOCABULARY (CLAUDE.md §6): the origin is read from the EXISTING `source` column — no parallel `origin` column.
--   idx_mls          ← source 'idx' | 'mls'
--   rentcast_listing ← source 'rentcast'  (RentCast listing id = external_property_id, existing; MLS number = mls_number,
--                                          existing; MLS name = mls_name, NEW below)
--   buyer_url        ← source 'buyer_url' (NEW in the CHECK) + source_url (NEW)
--   tenant_listing   ← listing_id / 'brokerage_listing';  manual ← 'manual' / NULL
-- (lib/portal/saved-homes.ts savedHomeOrigin is the reader; scripts/buyer-constraints-guard.ts holds this file and the
--  reader in agreement.)
--
-- `source_url` is NOT `listing_url`: listing_url is the attribution link the SOURCE supplies (IDX display rules link
-- back; alert e-mails render it as "View details"). source_url is what the BUYER pasted — user-supplied, never mailed
-- as a link, never a photo source — and a buyer_url save keeps listing_url NULL, so the two never hold one value twice.
--
-- Additive only; 0 live rows → no backfill. Writers: lib/portal/saved-homes.ts (saveHomeFromLink,
-- stampRentcastListingSave). Readers: app/portal/[contactId]/search/page.tsx, lib/portal/collaborative-share.ts.

BEGIN;

ALTER TABLE public.saved_properties
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS mls_name   text;

COMMENT ON COLUMN public.saved_properties.source_url IS
  'The property link the BUYER pasted (origin buyer_url, wave 150 lane 150W). User-supplied; never a photo source; distinct from listing_url (the source''s own attribution link).';
COMMENT ON COLUMN public.saved_properties.mls_name IS
  'The originating MLS''s own name as a RentCast /listings/sale row reports it (mlsName) — shown to the buyer as the listing''s source (wave 150 lane 150W).';

-- The source vocabulary gains 'buyer_url' (the live CHECK: brokerage_listing | rentcast | idx | mls | manual | NULL).
ALTER TABLE public.saved_properties DROP CONSTRAINT IF EXISTS saved_properties_source_check;
ALTER TABLE public.saved_properties ADD CONSTRAINT saved_properties_source_check
  CHECK (source IS NULL OR source = ANY (ARRAY['brokerage_listing'::text, 'rentcast'::text, 'idx'::text, 'mls'::text, 'manual'::text, 'buyer_url'::text]));

-- A pasted link is a web link, bounded; a buyer_url save always carries the link it came from.
ALTER TABLE public.saved_properties ADD CONSTRAINT saved_properties_source_url_shape
  CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND char_length(source_url) <= 2048));
ALTER TABLE public.saved_properties ADD CONSTRAINT saved_properties_buyer_url_has_link
  CHECK (source IS DISTINCT FROM 'buyer_url' OR source_url IS NOT NULL);
ALTER TABLE public.saved_properties ADD CONSTRAINT saved_properties_mls_name_len
  CHECK (mls_name IS NULL OR char_length(mls_name) <= 120);

COMMIT;

-- READ-BACK (integrator, after apply):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='saved_properties' AND column_name IN ('source_url','mls_name');   -- 2 rows, text
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.saved_properties'::regclass AND conname LIKE 'saved_properties_%';   -- source_check lists buyer_url
-- Then regenerate scripts/schema-snapshot.ts and scripts/check-vocabularies.ts (saved_properties.source += buyer_url).
