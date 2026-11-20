-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m539_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m539 — contact_type ADMITS THREE SPELLINGS OF ONE IDEA
--
-- APPLIED BY THIS LANE, by explicit narrow delegation from the integrator.
-- Every other migration in this directory is WRITTEN, NOT APPLIED (CLAUDE.md §3);
-- this one carries its live before/after evidence in the lane report, with a
-- POSITIVE CONTROL (CLAUDE.md §2) so a CHECK that refuses everything is
-- distinguishable from a correct one.
--
-- OWNER RULING, verbatim, on contact_type admitting three spellings of the same
-- idea: "collapse". And, separately: "vocabulary needs to be defined to prevent
-- drifting."
--
-- ══ THE FINDING ══════════════════════════════════════════════════════════════
--
-- MEASURED LIVE on hrvaqgvukzxfskkcrwbt, 2026-08-23:
--
--   contacts_contact_type_check CHECK (contact_type = ANY (ARRAY[
--     'lead','prospect','client',
--     'lifetime','lifetime_customer','past_client',      ← THREE. ONE IDEA.
--     'sphere','vendor','referral_partner','investor',
--     'buyer','seller','both','other']))
--
-- `lifetime`, `lifetime_customer` and `past_client` are the same thing: a person
-- we have already closed with. CLAUDE.md §6 — two spellings of one idea are a
-- defect, not a style choice, because a scorer cannot match a writer across them.
-- This has already cost real behaviour here: migration 433 renamed past_client →
-- lifetime_customer and the scattered `contact_type === 'lifetime'` readers were
-- left behind, so canonical past clients were silently classed as BUYERS and got
-- the wrong reel, the wrong voicemail and the wrong portal persona
-- (lib/contact-types.ts:10-13 records that autopsy).
--
-- SURVIVOR: `lifetime_customer`. Not a coin toss — it is
--   (a) the only one of the three any live row holds (contact_type census
--       2026-08-23: buyer 2, lifetime_customer 1, seller 1 — `lifetime` 0,
--       `past_client` 0), so the collapse is data-safe; and
--   (b) the spelling contacts.lifecycle_state already uses ('lifetime_customer',
--       1 row), so picking it makes the two columns on the SAME TABLE agree
--       instead of disagreeing.
--
-- ══ THE SAME COLUMN NAME ON campaign_sequences ═══════════════════════════════
--
--   campaign_sequences_contact_type_check CHECK ((contact_type IS NULL) OR
--     (contact_type = ANY (ARRAY['buyer','seller','both','lifetime'])))
--
-- This is the COARSE axis of the same vocabulary — lib/campaign-sequences/
-- auto-enroll.ts selects a sequence by (source_key, contact_type, persona) and
-- lib/campaigns/contact-sources.ts `contactTypeForContact` maps a
-- contacts.contact_type onto it. Leaving `lifetime` here while contacts says
-- `lifetime_customer` would rebuild the exact drift this migration removes, one
-- table over. campaign_sequences has 0 rows live (2026-08-23), so this half is
-- data-safe by inspection as well as by backfill.
--
-- ══ contacts_lifetime_consistent — DELETED, NAMING ITS SURVIVOR (§1) ═════════
--
--   contacts_lifetime_consistent
--     CHECK ((contact_type <> 'lifetime') OR (status = 'lifetime_customer'))
--
-- Its SUBJECT is the spelling this migration retires, so the moment `lifetime`
-- leaves the vocabulary the predicate is permanently, trivially TRUE — a live
-- orphan that reads like an enforced invariant and enforces nothing.
--
-- It was already close to that: it anchors on contacts.STATUS, and status on
-- every live row is 'active' with a default of 'new'. The lifecycle word
-- 'lifetime_customer' lives in contacts.LIFECYCLE_STATE, not in status. So the
-- constraint's practical effect was to make `contact_type='lifetime'` almost
-- unwritable — which is a large part of why no row has ever held it.
--
-- IT IS NOT RE-POINTED ONTO THE SURVIVOR, and that is a measured decision, not a
-- shrug. `CHECK (contact_type <> 'lifetime_customer' OR lifecycle_state =
-- 'lifetime_customer')` would REFUSE both live promotion writes:
--
--   lib/kernel/transactions.ts:1278       .update({ contact_type: "lifetime_customer", … })
--   lib/transactions/stage-progression.ts:445 .update({ contact_type: LIFETIME_CUSTOMER_TYPE, … })
--
-- Neither names lifecycle_state, and — CLAUDE.md §3, first trap — supabase-js
-- RESOLVES a refusal. Both of those call sites swallow the result outright
-- (`.then(() => null, () => null)`, no `{ error }` destructure), so a refused
-- UPDATE would look exactly like a successful one and closed deals would simply
-- stop becoming lifetime customers, in silence, forever. A constraint that
-- converts a code omission into silent data loss on the highest-value transition
-- in the product is worse than no constraint.
--
-- SURVIVOR OF THE INVARIANT — all three, so it is enforced where it can be seen:
--   · BOTH writers above now set `lifecycle_state: "lifetime_customer"` beside
--     the contact_type (this wave), so the two columns agree by CONSTRUCTION at
--     the only two places either is promoted;
--   · lib/contact-types.ts `canonicalContactType` / `LIFETIME_CONTACT_TYPES` —
--     the one definition every reader shares;
--   · scripts/contact-vocabulary-guard.ts (npm run test:contact-vocabulary),
--     which fails CI, loudly, at the moment a promotion writer stops setting
--     both columns — the opposite of a silent refusal.
--
-- ══ WHAT THIS DOES NOT TOUCH, DELIBERATELY (the blind spots, §2) ═════════════
--
-- `lifetime` and `past_client` also appear in vocabularies for DIFFERENT
-- functions. One vocabulary per FUNCTION — not one spelling per repository — so
-- none of these is in scope and none is changed:
--
--   portal_contact_invites.portal_view        'lifetime'   — which portal UI to render (1 live row)
--   revenue_protection_snapshots.snapshot_type 'lifetime'  — a time WINDOW (daily/weekly/…/lifetime)
--   referral_sources.source_type              'past_client' — where a referral came FROM
--   contacts.source / STANDARD_SOURCES        'past_client' — lead SOURCE, not contact type
--   contacts.buyer_stage                      'BUYER_LIFETIME'
--   listings.lifecycle_stage                  'LIFETIME_CUSTOMER'
--   newsletter_subscribers.source             'auto_lifetime'
--   facebook_custom_audiences source_rule     'lifetime_customers' (an audience name)
--   contacts.lifetime_segment                 local_owner | relocated
--
-- ══ THE CHANGE ═══════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. BACKFILL FIRST. A CHECK is added to data, never to hope. ──────────────
--
-- Both are expected to move 0 rows on hrvaqgvukzxfskkcrwbt (census above), and
-- they are written anyway: this file is the migration for every environment, and
-- an environment whose census differs must be carried forward, not refused.

UPDATE public.contacts
   SET contact_type = 'lifetime_customer',
       updated_at   = now()
 WHERE contact_type IN ('lifetime', 'past_client');

UPDATE public.campaign_sequences
   SET contact_type = 'lifetime_customer',
       updated_at   = now()
 WHERE contact_type = 'lifetime';

-- ── 2. contacts_lifetime_consistent — DROP, tombstoned above. ────────────────
--
-- Dropped BEFORE the vocabulary narrows. If the vocabulary went first this
-- constraint would already be vacuous and the drop would read as unrelated
-- cleanup rather than as the consequence of the collapse that it is.

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_lifetime_consistent;

-- ── 3. contacts.contact_type — 14 spellings → 12. ───────────────────────────

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_contact_type_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_contact_type_check
  CHECK (contact_type = ANY (ARRAY[
    'lead'::text,
    'prospect'::text,
    'client'::text,
    'lifetime_customer'::text,   -- SURVIVOR of lifetime / lifetime_customer / past_client
    'sphere'::text,
    'vendor'::text,
    'referral_partner'::text,
    'investor'::text,
    'buyer'::text,
    'seller'::text,
    'both'::text,
    'other'::text
  ]));

-- ── 4. campaign_sequences.contact_type — the coarse axis, same vocabulary. ───

ALTER TABLE public.campaign_sequences DROP CONSTRAINT IF EXISTS campaign_sequences_contact_type_check;

ALTER TABLE public.campaign_sequences
  ADD CONSTRAINT campaign_sequences_contact_type_check
  CHECK (contact_type IS NULL OR contact_type = ANY (ARRAY[
    'buyer'::text,
    'seller'::text,
    'both'::text,
    'lifetime_customer'::text    -- was 'lifetime'; now agrees with contacts.contact_type
  ]));

COMMIT;

-- ══ VERIFICATION (run after apply; the lane report quotes the output) ════════
--
-- THE CONSTRAINTS, AFTER:
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname IN ('contacts_contact_type_check',
--                      'campaign_sequences_contact_type_check',
--                      'contacts_lifetime_consistent');
--
-- NO ROW LEFT ON A RETIRED SPELLING (must be 0, 0):
--
--   SELECT (SELECT count(*) FROM contacts
--            WHERE contact_type IN ('lifetime','past_client'))          AS contacts_stranded,
--          (SELECT count(*) FROM campaign_sequences
--            WHERE contact_type = 'lifetime')                            AS sequences_stranded;
--
-- POSITIVE CONTROL (CLAUDE.md §2) — a CHECK that refuses EVERYTHING and a CHECK
-- that refuses exactly the two retired spellings both make the two REFUSAL
-- probes below fail. The ACCEPT probe is what tells them apart, so all three run
-- together, inside one rolled-back transaction:
--
--   BEGIN;
--   SAVEPOINT p; INSERT … contact_type='lifetime'          → EXPECT 23514; ROLLBACK TO p;
--   SAVEPOINT p; INSERT … contact_type='past_client'       → EXPECT 23514; ROLLBACK TO p;
--   SAVEPOINT p; INSERT … contact_type='lifetime_customer' → EXPECT SUCCESS (the control);
--   ROLLBACK;
