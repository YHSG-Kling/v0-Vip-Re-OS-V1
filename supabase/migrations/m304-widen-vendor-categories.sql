-- m304 — ONE vendor taxonomy. The bookable bench stops being capped at six trades.
-- ─────────────────────────────────────────────────────────────────────────────
-- A BROKERAGE COULD CURATE A PHOTOGRAPHER AND NEVER BOOK ONE.
--
-- The two vendor tables described the same real-world vendor with two different
-- category vocabularies:
--
--   vendors.category           6, Title Case
--                              Lender | Inspector | Title Company | Contractor |
--                              Stager | Other
--   vendor_directory.category  38, lowercase_snake
--                              inspector | lender | title | attorney |
--                              contractor | stager | photographer | cleaner |
--                              mover | insurance | handyman | landscaping |
--                              hvac | plumber | roofer | solar | tax_pro |
--                              videographer | drone_pilot | 3d_tour | …
--
-- Two consequences, one structural and one commercial:
--
--   · 'Title Company' can never equal 'title'. Postgres string comparison is
--     case-sensitive, so any correlation between the two tables by category was
--     unsound — which is why the retired name+category bridge could never have
--     been reliable, and why m303 gave them a real FK instead.
--   · `vendors` is the FK target of vendor_bookings. A trade the bench cannot
--     SPELL is a trade the platform cannot BOOK. The directory could describe a
--     photographer, a landscaper, a roofer, a solar installer — 32 categories
--     the bench had no value for — and none of them could ever be assigned to a
--     deal or booked for a client. The marketplace was capped at six trades by
--     a CHECK constraint nobody had revisited.
--
-- ── THE WIDEN ───────────────────────────────────────────────────────────────
-- vendors.category adopts the directory's 38-value taxonomy VERBATIM, including
-- its lowercase_snake spelling. One vocabulary, both tables, no mapping layer
-- and no case trap.
--
-- Canonicalising on the directory's spelling rather than the bench's is
-- deliberate: it is the larger set (38 vs 6), it is already the shape every
-- curated row uses, and 'title' is the token lib/compliance/vendor-respa.ts
-- normalises toward when it classifies a settlement-service vendor across
-- vendors / vendor_directory / referral_partners.
--
-- SAFE: `vendors` holds ONE row (category 'Other') and vendor_directory holds
-- none, verified before applying. The UPDATE below maps the six legacy values
-- onto their new spelling; with the app unreleased this is the cheapest this
-- migration will ever be.
--
-- The code half rides with it: lib/kernel/vendor-categories.ts already existed
-- as the ONE vocabulary module and every consumer reads its constants, so
-- changing the values there propagates to the lender panel, the title pipeline,
-- the title partner dashboard, the coverage forecast, the verification gate and
-- the card classifier at once. Three files that bypassed it with hardcoded
-- 'Lender' / 'Inspector' literals are repointed in the same commit — those are
-- precisely the "missed literal becomes a permanently empty query" failure the
-- module's own header documents from the last time this vocabulary moved.

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_category_check;

UPDATE vendors SET category = CASE category
  WHEN 'Contractor'    THEN 'contractor'
  WHEN 'Inspector'     THEN 'inspector'
  WHEN 'Lender'        THEN 'lender'
  WHEN 'Stager'        THEN 'stager'
  WHEN 'Title Company' THEN 'title'
  WHEN 'Other'         THEN 'other'
  ELSE lower(btrim(category))
END
WHERE category IS NOT NULL;

ALTER TABLE vendors ADD CONSTRAINT vendors_category_check CHECK (
  category = ANY (ARRAY[
    'inspector','lender','title','attorney','contractor','stager','photographer',
    'cleaner','mover','insurance','handyman','property_management','landscaping',
    'pest_control','pool_service','hvac','plumber','electrician','roofer','painter',
    'flooring','solar','security','smart_home','appliance_repair','window_treatment',
    'garage_door','refinance_lender','home_warranty','tax_pro','financial_advisor',
    'interior_design','organizer','estate_sale','videographer','drone_pilot',
    '3d_tour','other'
  ])
);

COMMENT ON COLUMN vendors.category IS
  'The trade this bench vendor performs. Shares vendor_directory.category''s 38-value taxonomy exactly (m304) — before that the bench admitted only 6 Title-Case values, so 32 trades the directory could describe could never be booked.';
