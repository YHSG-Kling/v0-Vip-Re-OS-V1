-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145B; a DROP … IF EXISTS of an object that did not yet exist was skipped where the MCP would have held the batch ──
--
-- m856 — THE LISTING AGREEMENT'S GOVERNING TERMS: the seller-agreed MLS live date and the seller's Coming Soon street-
-- address instruction, write-once on the executed agreement, amendable ONLY through contract_term_versions (wave 145,
-- lane 145B; owner rulings 1 + 2, 2026-10-27; cross-lane contract C7).
--
-- Owner: "The listing agreement would have the date the seller wants to go live on the MLS so check the listing agreement."
--        "You can advertise a coming soon only if you don't disclose the street address, unless otherwise."
--
-- AUDIT FIRST (CLAUDE.md §1) — survivors extended, nothing parallel:
--   · listing_agreements (the ONE insert: app/actions/seller-listing/execution-engine.ts markAgreementSigned) keeps its
--     terms as columns (total_commission_rate, seller_transaction_fee, effective_date …). Neither term this ruling names
--     had a column; the seller's requested date was typed straight onto listings.go_live_date (a PLAN) and could be
--     overwritten from three other doors.
--   · contract_term_versions (m797) is THE versioned, immutable record of executed contract terms, anchored to an offer
--     chain or a transaction — a listing agreement exists before either, so it had no anchor. This adds one; an executed
--     listing-agreement amendment is a source='amendment', status='executed' version there (lib/listings/listing-
--     agreement-terms.ts recordListingAgreementAmendment), resolved at read time by the m797 precedence rule.
--   · listings.go_live_date stays the PLANNED date (lib/listings/mls-live-date.ts recordPlannedMlsLiveDate, its one
--     writer, now refuses a date the executed agreement does not govern). Verified MLS live stays m796's columns, written
--     only from a RentCast / IDX feed confirmation.
--
-- Additive except PART 2's CHECK swap (a WIDENING: every row the old anchor CHECK admitted, the new one admits).
-- Idempotent. Apply PART 1, verify, then PART 2.

-- ── PART 1 — the two terms on the executed agreement + the write-once trigger ──────────────────────────────────────
ALTER TABLE public.listing_agreements
  ADD COLUMN IF NOT EXISTS seller_requested_mls_live_date date NULL,
  ADD COLUMN IF NOT EXISTS coming_soon_street_address_authorized boolean NULL;

COMMENT ON COLUMN public.listing_agreements.seller_requested_mls_live_date IS
  'm856 (wave 145B, owner ruling 2): the day the SELLER asked to go live on the MLS, as stated on the executed listing agreement. NOT the execution date, NOT the coming-soon period, NOT a verified MLS activation. NULL = the agreement states none. Write-once: a change is an executed amendment (contract_term_versions.listing_agreement_id). listings.go_live_date follows the governing value.';
COMMENT ON COLUMN public.listing_agreements.coming_soon_street_address_authorized IS
  'm856 (wave 145B, owner ruling 1): the seller''s signed instruction on showing the STREET ADDRESS in public Coming Soon advertising. true = authorized, false = withheld, NULL = not recorded (= withheld). Disclosure also needs the brokerage''s attested MLS rule (coming_soon_policy.street_address_disclosure_permitted). Write-once; a change is an executed amendment.';

-- A recorded term is never overwritten in place: the original signed terms are preserved by construction, and a change
-- is a NEW executed version (precedence computed at read time). NULL → value is allowed (the intake's second statement).
CREATE OR REPLACE FUNCTION public.listing_agreement_terms_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.seller_requested_mls_live_date IS NOT NULL
     AND NEW.seller_requested_mls_live_date IS DISTINCT FROM OLD.seller_requested_mls_live_date THEN
    RAISE EXCEPTION 'listing_agreements.seller_requested_mls_live_date is the executed agreement''s term and changes only through an executed amendment (contract_term_versions)'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.coming_soon_street_address_authorized IS NOT NULL
     AND NEW.coming_soon_street_address_authorized IS DISTINCT FROM OLD.coming_soon_street_address_authorized THEN
    RAISE EXCEPTION 'listing_agreements.coming_soon_street_address_authorized is the executed agreement''s term and changes only through an executed amendment (contract_term_versions)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_listing_agreement_terms_write_once ON public.listing_agreements;
CREATE TRIGGER trg_listing_agreement_terms_write_once
  BEFORE UPDATE OF seller_requested_mls_live_date, coming_soon_street_address_authorized ON public.listing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.listing_agreement_terms_write_once();

-- ── PART 2 — the listing-agreement anchor on the versioned terms record (contract C7) ──────────────────────────────
ALTER TABLE public.contract_term_versions
  ADD COLUMN IF NOT EXISTS listing_agreement_id uuid NULL REFERENCES public.listing_agreements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contract_term_versions.listing_agreement_id IS
  'm856 (wave 145B, contract C7): the executed LISTING AGREEMENT this version amends (source amendment). Its terms use the listing-agreement vocabulary (lib/listings/listing-agreement-terms.ts LISTING_AGREEMENT_TERM_KEYS). ON DELETE SET NULL + the anchor CHECK = an agreement that is a version''s only anchor cannot be deleted (the m797 root_offer_id precedent).';

-- The anchor CHECK, WIDENED (old: root offer OR transaction). Every row the old CHECK admitted, the new one admits.
ALTER TABLE public.contract_term_versions DROP CONSTRAINT IF EXISTS contract_term_versions_anchor_check;
ALTER TABLE public.contract_term_versions ADD CONSTRAINT contract_term_versions_anchor_check
  CHECK (root_offer_id IS NOT NULL OR transaction_id IS NOT NULL OR listing_agreement_id IS NOT NULL);

-- One version number per listing agreement PER SOURCE (the m797 chain index keys on COALESCE(root_offer_id, transaction_id),
-- which is NULL for these rows, so it cannot see them — this partial index is their twin). A concurrent duplicate is a refusal.
CREATE UNIQUE INDEX IF NOT EXISTS contract_term_versions_listing_agreement_version_uidx
  ON public.contract_term_versions (brokerage_id, listing_agreement_id, source, version_no)
  WHERE listing_agreement_id IS NOT NULL AND root_offer_id IS NULL AND transaction_id IS NULL;
CREATE INDEX IF NOT EXISTS contract_term_versions_listing_agreement_idx
  ON public.contract_term_versions (brokerage_id, listing_agreement_id) WHERE listing_agreement_id IS NOT NULL;

-- RLS: unchanged — m797's contract_term_versions_tenant_read (brokerage_id = current_user_brokerage_id()) covers the new
-- rows; writes stay service-role only (the amendment door gates on the session, then uses the service client).

-- ── VERIFY (read-only) ─────────────────────────────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='listing_agreements'
--    AND column_name IN ('seller_requested_mls_live_date','coming_soon_street_address_authorized');          -- 2 rows
-- SELECT tgname FROM pg_trigger WHERE tgname='trg_listing_agreement_terms_write_once';                       -- 1 row
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='contract_term_versions_anchor_check';    -- names listing_agreement_id
-- SELECT indexname FROM pg_indexes WHERE indexname LIKE 'contract_term_versions_listing_agreement%';          -- 2 rows
--
-- After applying: regenerate scripts/schema-snapshot.ts (+2 listing_agreements columns, +1 contract_term_versions column),
-- scripts/schema-fk-map.ts (contract_term_versions.listing_agreement_id → listing_agreements.id) and
-- scripts/check-vocabularies.ts (no new single-column vocabulary CHECK; the anchor CHECK is multi-column).
