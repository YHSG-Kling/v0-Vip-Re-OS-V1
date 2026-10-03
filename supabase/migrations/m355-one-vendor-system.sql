-- ═══════════════════════════════════════════════════════════════════════════
-- m355 — ONE VENDOR SYSTEM. vendor_directory is absorbed into vendors.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER RULING: "if there are 2 vendor systems, that can cause a drift should be
-- one system with a note of placement."
--
-- This supersedes the earlier decision to keep both tables in sync via
-- ensureDirectoryEntryForVendor. Keeping two rows for one vendor and reconciling
-- them IS the drift; the reconciler was a symptom, not a fix.
--
-- ── WHY `vendors` SURVIVES AND `vendor_directory` IS ABSORBED ───────────────
-- The argument is FK topology, not row count (1 vs 0 — neither is evidence):
--
--   1. SIXTEEN tables declare REFERENCES vendors(id) — bookings, assignments,
--      jobs, ratings, reviews, invitations, messages, tax documents, contact
--      assignments, communications, contact_vendors, title orders, lender
--      applications, referral partners, listing marketing services, and
--      vendor_directory itself. NOTHING anywhere references vendor_directory(id).
--      Surviving as vendors rewrites zero constraints; the reverse rewrites 16.
--
--   2. vendor_directory ALREADY DECLARES ITSELF THE DEPENDENT:
--      vendor_directory_vendor_id_fkey -> vendors(id) ON DELETE CASCADE (m303).
--      A cascade from parent to child is a formal statement that the curation
--      row has no independent existence. You do not promote a CASCADE child.
--
--   3. The identity a BOOKING resolves is a vendors.id. resolve-contact-vendors
--      already returns the bench id rather than the directory id, because portal
--      bookings FK to vendors(id). The product had already decided which id is
--      the vendor's identity — this stops pretending there is a second one.
--
--   4. vendor_directory.brokerage_id is NOT NULL, so it cannot represent a
--      GLOBAL vendor. The only live vendor row is a global one.
--
--   5. Broker approval (vendors.status) — the gate deciding whether a vendor may
--      be booked or shown at all — exists only on vendors. So do verification,
--      access level, W-9 linkage and invite attribution.
--
--   6. ux_vendor_directory_brokerage_vendor exists SOLELY to stop one bench
--      vendor being curated twice and having two rows disagree about `preferred`.
--      With placement as a column, the primary key gives that for free. That
--      index is the drift, written down.
--
-- The one state m303 argued for keeping — "curated but not yet approved to
-- book" — is not lost: post-merge it is status='pending' with visible_in_portal
-- set. Nothing becomes unrepresentable.
--
-- ── NO CHECK IS CREATED, WIDENED, OR DROPPED FOR CATEGORY ───────────────────
-- vendor_directory_category_check and vendors_category_check are BYTE-IDENTICAL
-- (same 38 literals, same order — m304 made them so), as are the two rating
-- CHECKs. Nothing needs carrying across.
--
-- Live at apply time: vendors=1, vendor_directory=0, vendor_invoices=0,
-- vendor_earnings=0, vendor_payouts=0. The backfill and remap below are no-ops
-- today. THAT IS EXACTLY WHY THEY GO IN NOW, while they are free.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The placement columns move onto the vendor row ──────────────────────
-- Defaults are IDENTICAL to the live vendor_directory defaults, so every
-- existing vendors row lands in exactly the state the resolver's "uncurated"
-- fallback branch used to synthesise. The fallback becomes structurally
-- unnecessary rather than being deleted with a behaviour change.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS preferred         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_priority  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS visible_in_portal boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS audience_tags     text[]  NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS stage_tags        text[]  NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS team_id           uuid    REFERENCES teams(id) ON DELETE SET NULL;

COMMENT ON COLUMN vendors.preferred IS
  'Placement flag. Was vendor_directory.preferred (m355). Set by markPlacementPaid, cleared by expirePlacements.';
COMMENT ON COLUMN vendors.display_priority IS
  'Placement ordering. Was vendor_directory.display_priority (m355). 10 = paid premium placement, 0 = standard.';
COMMENT ON COLUMN vendors.visible_in_portal IS
  'Placement visibility in the client portal. Was vendor_directory.visible_in_portal (m355).';

-- ── 2. Fold linked curation rows onto their bench row ──────────────────────
-- COALESCE precedence matches what resolve-contact-vendors already applied at
-- read time: bench wins on identity/contact fields, DIRECTORY wins on notes
-- (the curation note is the brokerage's own annotation and is the more specific
-- of the two). Preserving the resolver's semantics keeps the merge invisible.
UPDATE vendors v
   SET preferred         = d.preferred,
       display_priority  = d.display_priority,
       visible_in_portal = d.visible_in_portal,
       audience_tags     = d.audience_tags,
       stage_tags        = d.stage_tags,
       team_id           = d.team_id,
       notes             = COALESCE(d.notes, v.notes),
       rating            = COALESCE(v.rating, d.rating),
       phone             = COALESCE(v.phone, d.phone),
       email             = COALESCE(v.email, d.email),
       website           = COALESCE(v.website, d.website),
       updated_at        = now()
  FROM vendor_directory d
 WHERE d.vendor_id = v.id;

-- ── 3. Orphan curation rows become bench rows — as 'pending', NEVER 'active' ─
-- An orphan directory row was curated but never granted broker booking
-- approval. Minting it 'active' would FABRICATE an approval that no broker gave,
-- and status='active' is what lets a vendor be booked and shown to clients.
INSERT INTO vendors (brokerage_id, name, category, phone, email, website, rating,
                     notes, status, preferred, display_priority, visible_in_portal,
                     audience_tags, stage_tags, team_id)
SELECT d.brokerage_id, d.name, d.category, d.phone, d.email, d.website, d.rating,
       d.notes, 'pending', d.preferred, d.display_priority, d.visible_in_portal,
       d.audience_tags, d.stage_tags, d.team_id
  FROM vendor_directory d
 WHERE d.vendor_id IS NULL;

-- ── 4. THE IDENTITY LANDMINE — remap the money tables ──────────────────────
-- vendor_invoices.vendor_id has NO foreign key. Every writer fills it with a
-- vendors.id except premium-placement, which wrote a vendor_directory.id. The
-- consequences were already live and already wrong:
--   · app/vendor/invoices filters .eq("vendor_id", <vendors.id>) — the vendor
--     you charged for placement could not see their own invoice.
--   · The superadmin console's per-vendor invoice aggregate could not join
--     placement invoices, so placement revenue was missing from every tenant's
--     billed total.
--   · readVendorStripeConnect resolved nothing; the Stripe line item fell back
--     to the literal "Vendor".
-- And one that was latent: markInvoicePaid mints a vendor_earnings row — a
-- PAYOUT CLAIM — keyed on invoice.vendor_id whenever billed_to <> 'vendor'.
-- offerPremiumPlacement never set billed_to and the column defaults to
-- 'brokerage', so a placement invoice qualified. Nothing but the absence of a
-- caller was holding that.
UPDATE vendor_invoices i
   SET vendor_id = d.vendor_id
  FROM vendor_directory d
 WHERE i.vendor_id = d.id
   AND d.vendor_id IS NOT NULL;

UPDATE vendor_earnings e
   SET vendor_id = d.vendor_id
  FROM vendor_directory d
 WHERE e.vendor_id = d.id
   AND d.vendor_id IS NOT NULL;

UPDATE vendor_payouts p
   SET vendor_id = d.vendor_id
  FROM vendor_directory d
 WHERE p.vendor_id = d.id
   AND d.vendor_id IS NOT NULL;

-- The placement line item duplicated the same id into JSONB as `directory_id`;
-- rewrite it to `vendor_id` so the panel, the console and markPlacementPaid all
-- key on the one identity.
UPDATE vendor_invoices i
   SET line_items = (
     SELECT jsonb_agg(
       CASE
         WHEN li ? 'directory_id'
           THEN (li - 'directory_id') || jsonb_build_object(
                  'vendor_id',
                  COALESCE((SELECT d.vendor_id::text FROM vendor_directory d
                             WHERE d.id::text = li->>'directory_id'),
                           li->>'directory_id'))
         ELSE li
       END
     )
     FROM jsonb_array_elements(i.line_items) li
   )
 WHERE jsonb_typeof(i.line_items) = 'array'
   AND i.line_items::text LIKE '%directory_id%';

-- Close the class permanently. This is a NEW constraint on a column that never
-- had one — it is what makes "a vendors.id belongs here" enforced rather than
-- merely conventional.
ALTER TABLE vendor_invoices
  ADD CONSTRAINT vendor_invoices_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES vendors(id);

ALTER TABLE vendor_earnings
  ADD CONSTRAINT vendor_earnings_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES vendors(id);

ALTER TABLE vendor_payouts
  ADD CONSTRAINT vendor_payouts_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES vendors(id);

-- ── 5. Drop the second system ──────────────────────────────────────────────
-- Deliberately NOT `CASCADE`. Nothing references vendor_directory(id), so a
-- plain DROP succeeds — and will fail loudly if that ever stops being true.
-- That failure is the check we want, not something to suppress.
DROP TABLE vendor_directory;

-- ── 6. Rebuild the read paths the directory's indexes served ───────────────
CREATE INDEX IF NOT EXISTS idx_vendors_portal
  ON vendors (brokerage_id, visible_in_portal, display_priority DESC);
CREATE INDEX IF NOT EXISTS idx_vendors_audience ON vendors USING gin (audience_tags);
CREATE INDEX IF NOT EXISTS idx_vendors_stage    ON vendors USING gin (stage_tags);
CREATE INDEX IF NOT EXISTS idx_vendors_team     ON vendors (team_id) WHERE team_id IS NOT NULL;
-- ux_vendor_directory_brokerage_vendor is NOT rebuilt: vendors_pkey now provides
-- the guarantee it existed to provide.

-- ── 7. The hazard the merge would otherwise introduce: GLOBAL vendors ──────
-- vendors.brokerage_id is nullable and the only live row is NULL. With placement
-- as columns on vendors, a global vendor would carry ONE set of placement flags
-- shared by every tenant — and the live UPDATE policy allowed any tenant to
-- write rows where brokerage_id IS NULL. So any brokerage could flip `preferred`
-- on a global vendor and change what every OTHER brokerage's clients see.
-- On vendor_directory this was impossible: brokerage_id was NOT NULL, so
-- curation was tenant-scoped by construction. Two defences, both narrowings:
--
-- (a) Writes stop crossing tenants. Reads keep the IS NULL branch, so global
--     vendors stay browsable and bookable. This also closes a hole that already
--     existed: any tenant could edit a global vendor's name, category or status.
DROP POLICY IF EXISTS vendors_tenant_update ON vendors;
CREATE POLICY vendors_tenant_update ON vendors
  FOR UPDATE
  USING (brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS vendors_tenant_delete ON vendors;
CREATE POLICY vendors_tenant_delete ON vendors
  FOR DELETE
  USING (brokerage_id = current_user_brokerage_id());

DROP POLICY IF EXISTS vendors_tenant_insert ON vendors;
CREATE POLICY vendors_tenant_insert ON vendors
  FOR INSERT
  WITH CHECK (brokerage_id = current_user_brokerage_id());

-- (b) And make "a global vendor cannot be sold placement" unrepresentable
--     rather than merely discouraged. New CHECK on new columns; widens nothing.
ALTER TABLE vendors ADD CONSTRAINT vendors_global_not_curated CHECK (
  brokerage_id IS NOT NULL
  OR (preferred = false AND display_priority = 0 AND team_id IS NULL
      AND audience_tags = ARRAY[]::text[] AND stage_tags = ARRAY[]::text[])
);

COMMIT;
