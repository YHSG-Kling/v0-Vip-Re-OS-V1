-- m303 — give vendor_directory a REAL link to the vendors bench.
-- ─────────────────────────────────────────────────────────────────────────────
-- A VENDOR PAID FOR PLACEMENT AND THE PLACEMENT NEVER APPEARED.
--
-- The platform has two vendor tables and both are real:
--
--   vendors           — the brokerage's OPERATIONAL bench. FK target of
--                       vendor_bookings / vendor_assignments, carries status
--                       (broker approval), rating, verification.
--   vendor_directory  — the CURATED + MONETIZED directory. Carries the columns
--                       vendors does not have: preferred, display_priority,
--                       visible_in_portal, audience_tags, stage_tags, team_id.
--
-- lib/vendors/premium-placement.ts is the monetization path: a brokerage
-- charges a vendor for featured placement (offer → vendor_invoices → mark paid
-- → flip the directory row preferred + display_priority + visible_in_portal →
-- nightly sweep un-features it when the paid term lapses). Its own header says
-- those flags are "surfaced on the Vendors page Preferred tab / contact portal".
--
-- They are not. A previous burn-down concluded vendor_directory was a
-- "writer-less legacy twin" and repointed the consumer-facing readers onto
-- `vendors`. That conclusion was wrong — premium-placement IS its writer — and
-- the repoint disconnected four things at once, because `vendors` has none of
-- those columns. lib/vendor-marketplace/resolve-contact-vendors.ts still
-- carries the full vendor_directory docstring while its body reads `vendors`
-- and hardcodes every curation field:
--
--     preferred: null, audience_tags: [], stage_tags: [],
--     display_priority: null, visible_in_portal: true
--
-- What that silently turned off:
--   1. REVENUE — paid placement is collected, flipped, swept for expiry, and
--      never rendered to a single consumer.
--   2. COMPLIANCE — resolveVendorDisclosure() decides the RESPA disclosure from
--      `preferred`. With preferred permanently false, the 'preferred_general'
--      disclosure (business-relationship transparency for a NON-regulated
--      featured vendor) can never fire. Settlement-service categories are
--      unaffected — that branch keys on the category, not the flag — so the
--      exposure is narrow but real: a brokerage takes money to feature a
--      landscaper/stager/contractor to its clients and the client is never told
--      a business relationship exists.
--   3. CURATION — audience_tags / stage_tags are the persona + lifecycle
--      targeting the resolver's docstring describes at length. Stubbed to []
--      they match EVERYTHING, so every contact sees every vendor.
--   4. VISIBILITY — visible_in_portal stubbed to true means a broker cannot
--      hide a vendor from clients at all.
--
-- ── WHY AN FK, RATHER THAN RE-ADDING THE NAME-MATCH BRIDGE ──────────────────
-- The root cause of every symptom above is that these two tables describe the
-- same real-world vendor with NO link between them. That absence is what forced
-- a fuzzy (brokerage, name, category) bridge, what made the tables look like
-- twins, and what made "just repoint onto vendors" look safe. Re-adding fuzzy
-- matching would rebuild the ambiguity.
--
-- vendor_directory.vendor_id makes the relationship explicit and checkable. The
-- backfill still uses the normalized (brokerage, name, category) match — that
-- is the only correlation available for pre-existing rows — but it runs ONCE,
-- here, instead of on every read forever.
--
-- SAFE: vendor_directory holds 0 rows and vendors holds 1 (verified before
-- applying), so the backfill is effectively a no-op and nothing can mis-link.
-- The column is NULLABLE on purpose: a directory entry for a vendor that is not
-- on the bench is a legitimate state (curated but not yet approved to book),
-- and forcing it NOT NULL would make that unrepresentable.

ALTER TABLE vendor_directory
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id) ON DELETE CASCADE;

-- One-time correlation for any pre-existing rows, on the same normalized key
-- the retired bridge used: same brokerage, case/space-insensitive name+category.
UPDATE vendor_directory d
   SET vendor_id = v.id
  FROM vendors v
 WHERE d.vendor_id IS NULL
   AND v.brokerage_id = d.brokerage_id
   AND lower(btrim(coalesce(v.name, ''))) = lower(btrim(coalesce(d.name, '')))
   AND lower(btrim(coalesce(v.category, ''))) = lower(btrim(coalesce(d.category, '')));

-- A bench vendor may be curated at most once per brokerage — otherwise two
-- directory rows could disagree about whether the same vendor is preferred.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_directory_brokerage_vendor
  ON vendor_directory (brokerage_id, vendor_id)
  WHERE vendor_id IS NOT NULL;

-- The portal read path: brokerage + portal-visible, ordered by placement.
CREATE INDEX IF NOT EXISTS idx_vendor_directory_portal
  ON vendor_directory (brokerage_id, visible_in_portal, display_priority DESC);

COMMENT ON COLUMN vendor_directory.vendor_id IS
  'The operational bench row (vendors) this curated entry describes. Added m303 — before it, the two tables had no link, which is why the consumer-facing readers were repointed onto vendors and the paid placement flags stopped surfacing.';
