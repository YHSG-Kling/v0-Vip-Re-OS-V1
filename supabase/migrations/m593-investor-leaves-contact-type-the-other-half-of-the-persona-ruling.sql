-- m593 — 'investor' leaves contact_type: the other half of the m589 ruling
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31
-- (renumbered m590 -> m593 at commit: lane M5's newsletter drop claimed m590
-- first). Verified after: contacts_contact_type_check lists TEN values with
-- 'investor' gone, zero rows were touched by the backfill (none existed), and
-- the code-side follow-ups in this header were executed the same session —
-- contact-types roster + RETIRED map, the runner's transitional arms dropped,
-- check-vocabularies regenerated (§3). (Was WRITTEN-NOT-APPLIED — updated per
-- §2.)
--
-- THE RULING, verbatim (same ruling m589 implemented the persona half of):
-- "one thing to note that investor is a persona and not a contact type."
--
-- m589 (APPLIED) added 'investor' to contacts_contact_persona_check — the
-- fourteenth persona. This migration retires it from contacts_contact_type_check:
-- contact_type answers WHICH SIDE of a transaction a person is on, and an
-- investor's side is BUYER; the investing is the situation, which now lives on
-- contact_persona.
--
-- LIVE MEASUREMENTS THE INTEGRATOR MUST RE-VERIFY BEFORE APPLYING:
--
--   1. The CHECK this migration replaces (expected: the m563 eleven — lead,
--      prospect, lifetime_customer, sphere, vendor, referral_partner, investor,
--      buyer, seller, both, other):
--
--        select pg_get_constraintdef(oid)
--          from pg_constraint
--         where conrelid = 'public.contacts'::regclass
--           and conname  = 'contacts_contact_type_check';
--
--   2. The stranded-row census (measured 2026-08-31: ZERO rows carried
--      contact_type='investor' — buyer:2, lifetime_customer:1, seller:1):
--
--        select contact_type, count(*) from public.contacts
--         group by contact_type order by 2 desc;
--
-- THE BACKFILL RUNS EVEN THOUGH TODAY'S COUNT IS ZERO — correct on any data,
-- not only on the data measured (§2): a row typed 'investor' between the census
-- and the apply is mapped to the ruling's shape (side = buyer, situation =
-- investor) rather than stranded against the narrowed CHECK. COALESCE keeps a
-- persona somebody already set.
--
-- CODE-SIDE FOLLOW-UPS OWED IMMEDIATELY AFTER APPLYING (integrator, same
-- session, then regenerate scripts/check-vocabularies.ts per §3):
--   · lib/contact-types.ts — remove "investor" from CONTACT_TYPES and add
--     `investor: "buyer"` to RETIRED_CONTACT_TYPES (the tolerant reader maps a
--     legacy spelling to its side; the guard then proves no retired spelling
--     reaches Postgres).
--   · lib/buyer-search/investor-offmarket-runner.ts — drop the TRANSITIONAL
--     `.or("contact_persona.eq.investor,contact_type.eq.investor")` arm and the
--     `contact_type === "investor"` tolerant read (both are commented as
--     transitional); post-backfill the persona filter alone is complete, and
--     scripts/contact-vocabulary-guard.ts will flag the .or clause the moment
--     'investor' joins RETIRED_CONTACT_TYPES.
--   · app/crm/contacts/new/page.tsx — the CONTACT_TYPE_LABELS "investor" entry
--     becomes a compile error when CONTACT_TYPES drops the member; delete it
--     (the ORDER list already stopped offering it).
--   · app/crm/contacts/[contactId]/page.tsx + lib/kernel/client-welcome.ts +
--     lib/them-first/empathy-library.ts — the tolerant `contact_type ===
--     "investor"` reads may stay (readers stay tolerant, per the guard's
--     asymmetry) or be swept once no row can carry the value.
--
-- Everything else was repointed in the same change set as this file (see the
-- lane report): every code WRITER of contact_type='investor' now writes
-- buyer + persona, and every DB FILTER on it now filters contact_persona.
--
-- AFTER-APPLY VERIFICATION:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid='public.contacts'::regclass
--      and conname='contacts_contact_type_check';
--   → must list TEN values, without 'investor';
--   select count(*) from public.contacts where contact_type='investor';  → 0
--   select count(*) from public.contacts where contact_persona='investor';
--   → the number the backfill moved (0 if the census held).

BEGIN;

-- 1. Map any investor-typed row onto the ruling's shape BEFORE narrowing the
--    CHECK, so the ADD CONSTRAINT below cannot fail on live data. An investor
--    is a buyer whose situation is the investment purchase.
UPDATE public.contacts
   SET contact_type    = 'buyer',
       contact_persona = COALESCE(contact_persona, 'investor')
 WHERE contact_type = 'investor';

-- 2. Retire the value from the vocabulary.
ALTER TABLE public.contacts DROP CONSTRAINT contacts_contact_type_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_contact_type_check
  CHECK (contact_type = ANY (ARRAY[
    'lead', 'prospect', 'lifetime_customer', 'sphere', 'vendor',
    'referral_partner', 'buyer', 'seller', 'both', 'other'
  ]));

COMMIT;

-- NOT MIGRATED HERE, LISTED FOR THE INTEGRATOR (DB-side vocabulary that names
-- 'investor' but does NOT mean the contact_type value):
--   · facebook_custom_audiences_source_rule_type_check (m532) — the jsonb CHECK
--     admits the SOURCE-RULE TYPE STRING 'investor_contacts'. That is a rule
--     name, not a contact_type value; the rule's resolver was repointed in code
--     onto contact_persona='investor', so the CHECK member stays valid and no
--     migration is owed.
--   · scraping_keywords keyword_type 'investor' / motivated_seller signal
--     vocabularies — the lead-scraping fence: untouched by standing instruction.
