-- m531 — contacts.contact_persona IS FREE TEXT AND HAS DRIFTED OFF THE CANON THE
--        AD-AUDIENCE BASIS QUERIES
--
-- Owner ruling, verbatim (2026-08-22): "audience should be segmented on persona."
--
-- WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator applies them
-- (CLAUDE.md §3). READ THE "WHY THIS RAISES" SECTION BEFORE APPLYING — this
-- migration is DESIGNED to refuse rather than guess, and it will refuse today.
--
-- ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
-- The owner's ruling makes persona the declared BASIS of an ad audience, and
-- lib/kernel/ads.ts `syncAudience` now narrows its Meta/Google upload with
--   .in("contact_persona", spellings)
-- That column is where the answer has to come from, and the column is a mess:
--
--   · `contacts.contact_persona` is `text` with NO CHECK constraint, while the
--     SAME vocabulary IS pinned one table over — `campaign_sequences.persona`
--     carries `campaign_sequences_persona_check`, thirteen values, matching the
--     `Persona` union at lib/kernel/types.ts and `CAMPAIGN_PERSONAS` at
--     lib/campaigns/contact-sources.ts exactly. One idea, one canon, and the
--     table the ads lane actually reads is the one place it is not enforced
--     (CLAUDE.md §6).
--
--   · So it drifted. MEASURED LIVE on 2026-08-22, all four non-null rows:
--
--         contact_persona   rows   canonical?
--         first_time_buyer     1   no  → first_time
--         luxury_buyer         1   no  → luxury
--         listing_seller       1   no  → NO CANONICAL PERSONA (see below)
--         past_client          1   no  → NO CANONICAL PERSONA (see below)
--
--     NOT ONE live row holds a canonical spelling. A query written as
--     `.in("contact_persona", ['luxury'])` therefore matches zero rows and
--     reports drift to the operator as "you have no luxury clients".
--
--   · The writers disagree with each other too, which is what keeps it drifting:
--       lib/lifecycle/offer-lifecycle.ts:164  writes luxury_buyer / investor /
--                                             first_time_buyer / first_time_seller
--       app/actions/listing-lifecycle-core.ts:728  writes "past_seller"
--     — a fifth spelling that no union and no alias map knows.
--
-- ── WHY THE CODE DOES NOT SIMPLY WAIT FOR THIS ──────────────────────────────
-- lib/campaigns/contact-sources.ts already carries the ONE alias map that reads
-- the drifted spellings forward (`normalizeContactPersona`), and the ads query
-- asks for the raw spellings via `rawSpellingsForPersona`, which is computed by
-- INVERTING that same map rather than restating it. So the audience is correct
-- today, with or without this migration. This migration removes the need for the
-- widening by making the column hold the canon, and — more importantly — stops
-- the SIXTH spelling from being written.
--
-- ── WHY THIS RAISES, AND WHY THAT IS THE POINT ──────────────────────────────
-- Two of the four live values name a CONTACT TYPE, not a transaction situation:
--
--   `listing_seller` — that they have a listing with us. The canonical Persona
--                      union has no plain "seller" member, deliberately: the
--                      seller-side personas it does have (fsbo, expired,
--                      foreclosure, downsize, probate, divorce) each name WHY
--                      they are selling. "Has a listing" is lifecycle state, and
--                      the ads lane already segments on that through
--                      SourceRule.type = 'active_sellers'.
--   `past_client`    — post-close relationship. Same story: that is
--                      `lifetime_customers`, an existing SourceRule type and two
--                      shipped audience templates.
--
-- `normalizeContactPersona` maps both to NULL on purpose, and this migration
-- does NOT invent a persona for them, does NOT null them out (that is deleting
-- data to move a number — CLAUDE.md §1) and does NOT add the CHECK while they
-- are present. It RAISES with the offending values named, so the integrator
-- takes it to the owner rather than a migration silently choosing.
--
-- THE OWNER'S CALL, one of:
--   (a) these are CONTACT TYPES, not personas — migrate the two rows to
--       contact_type (`seller` / `lifetime`) and clear contact_persona, then
--       re-run; or
--   (b) the canonical Persona union gains members for them — which is a change
--       to lib/kernel/types.ts, lib/campaigns/contact-sources.ts AND
--       campaign_sequences_persona_check together, and would make them
--       ads-eligible transaction situations, which they are not.
--
-- Recommendation on the evidence: (a). Both are already expressible as audience
-- bases through existing SourceRule types, so (b) would create two spellings of
-- one idea — the defect §6 exists to prevent.
--
-- ── WHAT IS DELIBERATELY NOT DONE HERE ──────────────────────────────────────
-- `users.contact_persona` (23 rows, ALL NULL, measured 2026-08-22) is left
-- alone: no writer was found for it in this lane's sweep and it belongs to the
-- orphan burn-down lane, which owns that call. Recorded, not touched.

BEGIN;

-- ── 1 · Backfill the drifted spellings that DO name a canonical situation ────
-- Exactly the alias map at lib/campaigns/contact-sources.ts PERSONA_ALIASES.
-- Kept in sync by hand ONCE, here, rather than by a second runtime map: the
-- assertion in step 2 is what makes a divergence loud.
UPDATE public.contacts SET contact_persona = 'first_time'
  WHERE lower(btrim(contact_persona)) IN ('first_time_buyer', 'firsttime', 'first_time_seller');
UPDATE public.contacts SET contact_persona = 'luxury'
  WHERE lower(btrim(contact_persona)) IN ('luxury_buyer', 'luxury_seller');
UPDATE public.contacts SET contact_persona = 'downsize'
  WHERE lower(btrim(contact_persona)) IN ('downsizer', 'downsizing');
UPDATE public.contacts SET contact_persona = 'upsize'
  WHERE lower(btrim(contact_persona)) IN ('upsizer', 'upsizing');
UPDATE public.contacts SET contact_persona = 'relocated'
  WHERE lower(btrim(contact_persona)) IN ('relocation');
UPDATE public.contacts SET contact_persona = 'military'
  WHERE lower(btrim(contact_persona)) IN ('veteran');
UPDATE public.contacts SET contact_persona = 'foreclosure'
  WHERE lower(btrim(contact_persona)) IN ('pre_foreclosure');
UPDATE public.contacts SET contact_persona = 'expired'
  WHERE lower(btrim(contact_persona)) IN ('expired_listing');
UPDATE public.contacts SET contact_persona = 'fsbo'
  WHERE lower(btrim(contact_persona)) IN ('for_sale_by_owner');

-- ── 2 · REFUSE rather than guess on anything still off-canon ────────────────
DO $$
DECLARE
  residue text;
BEGIN
  SELECT string_agg(DISTINCT format('%s (%s rows)', contact_persona, cnt), ', ')
    INTO residue
  FROM (
    SELECT contact_persona, count(*) AS cnt
    FROM public.contacts
    WHERE contact_persona IS NOT NULL
      AND contact_persona NOT IN (
        'first_time','relocated','luxury','fsbo','probate','upsize','downsize',
        'military','divorce','senior','expired','foreclosure','other')
    GROUP BY contact_persona
  ) q;

  IF residue IS NOT NULL THEN
    RAISE EXCEPTION
      'm531 REFUSES: contacts.contact_persona still holds non-canonical values: %. '
      'These name a CONTACT TYPE or a spelling no alias map knows, and this migration '
      'will not invent a persona for them or null them out. See the header: the owner '
      'must rule (a) migrate them to contact_type and clear the persona, or (b) widen '
      'the canonical Persona union in lib/kernel/types.ts, lib/campaigns/contact-sources.ts '
      'AND campaign_sequences_persona_check together. Recommendation on the evidence: (a).',
      residue;
  END IF;
END $$;

-- ── 3 · Pin the column to the ONE canon (same members as
--        campaign_sequences_persona_check, deliberately spelled identically) ──
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_contact_persona_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_contact_persona_check
  CHECK (
    contact_persona IS NULL
    OR contact_persona = ANY (ARRAY[
      'first_time'::text, 'relocated'::text, 'luxury'::text, 'fsbo'::text,
      'probate'::text, 'upsize'::text, 'downsize'::text, 'military'::text,
      'divorce'::text, 'senior'::text, 'expired'::text, 'foreclosure'::text,
      'other'::text])
  );

-- ── 4 · POSTCONDITION — the constraint exists and the column is on-canon ────
DO $$
DECLARE
  off_canon integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_contact_persona_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    RAISE EXCEPTION 'm531 postcondition failed: contacts_contact_persona_check was not created';
  END IF;

  SELECT count(*) INTO off_canon
  FROM public.contacts
  WHERE contact_persona IS NOT NULL
    AND contact_persona NOT IN (
      'first_time','relocated','luxury','fsbo','probate','upsize','downsize',
      'military','divorce','senior','expired','foreclosure','other');

  IF off_canon > 0 THEN
    RAISE EXCEPTION 'm531 postcondition failed: % rows still off-canon', off_canon;
  END IF;

  RAISE NOTICE 'm531 OK — contacts.contact_persona pinned to the canonical Persona vocabulary.';
END $$;

COMMIT;

-- ── AFTER APPLYING ──────────────────────────────────────────────────────────
-- 1. Regenerate the vocabulary cache so check-vocabulary-guard holds code and
--    database in agreement (CLAUDE.md §3):
--      scripts/generate-check-vocabularies.ts  (its header carries the SQL)
-- 2. lib/kernel/ads.ts `syncAudience` can then narrow on the canonical value
--    alone; `rawSpellingsForPersona` stays as the reader/query bridge for any
--    row written before the CHECK existed, and becomes a no-op widening rather
--    than a load-bearing one. Do NOT delete it without re-measuring the column.
-- 3. The two literal writers still need fixing or they will violate the new
--    CHECK on their next write (PGRST/23514):
--      lib/lifecycle/offer-lifecycle.ts:164      luxury_buyer / investor /
--                                                first_time_buyer / first_time_seller
--      app/actions/listing-lifecycle-core.ts:728 "past_seller"
--    Both are outside this lane's scope and are reported, not silently changed.
