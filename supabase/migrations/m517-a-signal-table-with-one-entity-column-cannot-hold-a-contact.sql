-- m517-a-signal-table-with-one-entity-column-cannot-hold-a-contact.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT: `motivated_seller_signals` has exactly ONE entity column —
-- `lead_id` — and the owner has ruled that the lane feeding it covers TWO
-- populations.
--
-- Owner ruling, verbatim: "motivated sellers source is for leads and contacts."
--
-- `leads.id` and `contacts.id` are DISJOINT uuid namespaces. With one column
-- there is no honest way to file a contact: the only options are to put a
-- `contacts.id` into a column every reader treats as `leads(id)`, or not to
-- cover contacts at all.
--
-- THE FIRST OPTION HAS ALREADY BEEN TAKEN ONCE AND PAID FOR. A now-deleted
-- writer wrote `lead_id: signal.contact_id || null`; the tombstone is at
-- app/actions/lead-intelligence.ts:2444. Every row it filed was unreadable:
-- lib/services/lead-management.service.ts and app/actions/ai-predictions.ts both
-- select on `lead_id`, so a contacts id there matches nothing, forever. A
-- SECOND writer with the same shape was still live when this file was written —
-- `detectMotivatedSellerSignals` resolved its brokerage by querying **contacts**
-- on the id it was handed and then wrote that id into **`lead_id`** — and is
-- fixed in the same change as this migration.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--   1. `contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE`
--   2. A CHECK that EXACTLY ONE of (lead_id, contact_id) is set
--   3. Read indexes for the new column, matching the ones lead_id already has
--   4. The m514 dedupe index WIDENED to the six signal types the BatchData lane
--      gained in the same change
--
-- ── (1) WHY contacts(id) AND NOT contacts.contact_id ────────────────────────
-- `contacts` carries TWO uuid columns: `id` (PRIMARY KEY) and `contact_id` (a
-- secondary UNIQUE). CLAUDE.md §3 names this as a trap that costs real time —
-- picking the wrong one produces a query that always returns nothing. `id` is
-- the correct target and it is not a judgement call: `leads.contact_id`
-- REFERENCES contacts(id) already (constraint leads_contact_id_fkey, read live),
-- so pointing anywhere else would give this table a different notion of "the
-- same contact" than the leads table has. Measured live 2026-08-21: all 4
-- contact rows have `id <> contact_id`, so the two are genuinely different
-- values and choosing wrong would have been silent.
--
-- ON DELETE CASCADE: a signal about a deleted contact is unreadable by
-- construction. `brokerage_id` uses ON DELETE SET NULL because a signal survives
-- a brokerage record change; an ENTITY reference cannot, because the entity is
-- the whole subject of the row.
--
-- NOTE, STATED RATHER THAN QUIETLY FIXED: `lead_id` carries NO foreign key to
-- `leads` and this migration does not add one. Not an oversight — it is a
-- separate decision with a separate blast radius (it would begin refusing any
-- writer still filing a non-lead id, which is the right outcome but is a
-- behaviour change that belongs in its own file with its own measurement). The
-- CHECK below constrains SHAPE, not referential integrity, and this comment is
-- here so the next reader does not mistake "exactly one is set" for "and it
-- points at a real row".
--
-- ── (2) WHAT THE CHECK DOES AND DOES NOT CLOSE ──────────────────────────────
-- It makes "exactly one entity" a database fact. It refuses BOTH failure modes:
--   · BOTH set   — a row claiming to be about two different people
--   · NEITHER set — the orphan row lib/external/permit-signals.ts's header has
--                   always refused to write in application code, now refused by
--                   the database as well
-- It does NOT and CANNOT detect a row where the WRONG column is populated with a
-- correct-looking uuid. A `contacts.id` sitting in `lead_id` satisfies this
-- CHECK perfectly. Only a foreign key would catch that, and per the note above
-- this file does not add one to `lead_id`. Do not read this constraint as
-- closing the misattribution class; it closes the SHAPE class.
--
-- ── (2b) REPAIR: THERE IS NOTHING TO REPAIR ─────────────────────────────────
-- Measured against the live project (hrvaqgvukzxfskkcrwbt) on 2026-08-21,
-- before this file was written:
--
--   select count(*) from motivated_seller_signals                         → 0
--   select count(*) from motivated_seller_signals where lead_id is null   → 0
--   -- lead_id values matching no leads row:                              → 0
--   --   …of those, matching a contacts.id:                               → 0
--   --   …of those, matching a contacts.contact_id:                       → 0
--
-- The table is EMPTY. So no row is mis-filed, no row needs moving from `lead_id`
-- to `contact_id`, and no backfill is written — a backfill over zero rows that
-- LOOKED like a repair would be worse than none, because it would suggest the
-- misattribution had been cleaned up rather than never having landed.
--
-- HAD there been mis-filed rows, this migration could not have repaired them
-- automatically and that is worth stating: a uuid in `lead_id` that matches a
-- `contacts.id` is *probably* a mis-filed contact, but `leads.id` and
-- `contacts.id` are independent uuid spaces, so "matches a contacts row" is
-- evidence, not proof, and moving a row on that basis could relocate a genuine
-- lead signal onto a stranger's record.
--
-- IT CANNOT FAIL ON LIVE DATA. The CHECK is added NOT VALID — so it binds every
-- future write immediately and does NOT scan or reject anything already stored —
-- and is then validated only inside a guard that first counts violating rows.
-- With the live count at 0 the validation runs and succeeds; if rows have landed
-- between this being written and being applied, the migration RAISES A NOTICE
-- naming the count and leaves the constraint NOT VALID rather than aborting.
-- An un-validated constraint that is enforcing new writes is a partial win that
-- can be reported; a failed migration is a lane that stops.
--
-- ── (4) WHY THE DEDUPE INDEX IS TOUCHED AT ALL ──────────────────────────────
-- lib/external/batchdata-seller-signals.ts gained SIX signal types in the same
-- change (the owner asked twice for more motivated-seller signs):
--   for_sale_by_owner, listed_below_market, corporate_owned, fix_and_flip,
--   vacant_lot, active_listing
-- m514's index lists its covered signal_types literally, so a type added to the
-- lane and not to the index carries NO uniqueness guarantee — not a weaker one,
-- none — and the probe re-reads the same unchanged property every rotation. That
-- is the defect m490, m499 and m514 were each written for, and this is the
-- fourth file on the same lesson: adding a kind without adding it to the index
-- is how a repeating probe starts duplicating, and lead scoring COUNTS signals.
--
-- `active_listing` is in the list even though it is a SUPPRESSION signal ("this
-- owner is already represented — do not solicit, NAR Code of Ethics Article
-- 16"). It is written by the same repeating probe as every other type and needs
-- the same guarantee; a suppression fact re-filed daily is still a duplicate.
--
-- The `signal_details ? 'dedupe_key'` predicate is RETAINED and is still
-- load-bearing for exactly the reason m514 records: app/actions/lead-intelligence.ts
-- writes `high_equity`, `market_timing`, `property_condition` and `life_event`
-- with NO dedupe_key, and those rows must stay unconstrained by this rule.
--
-- ── m500 IS UNTOUCHED ───────────────────────────────────────────────────────
-- `motivated_seller_signals_signal_strength_check` (weak|moderate|strong|urgent,
-- or NULL) is neither dropped nor redefined here. Every new signal type above
-- emits a word from that same four-value ladder — the vocabulary owned by
-- lib/lead-governance/seller-signal-strength.ts — so nothing about the strength
-- CHECK has to change, and this file deliberately does not open it.
--
-- ADDITIVE AND SAFE. No column is dropped, no data is rewritten.

-- ── 1. the second entity column ─────────────────────────────────────────────
ALTER TABLE public.motivated_seller_signals
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.motivated_seller_signals.contact_id IS
  'The CONTACT this seller signal is about, when it is about a contact. Exactly one of (lead_id, contact_id) is set — see motivated_seller_signals_one_entity. References contacts(id), the PRIMARY KEY and the same column leads.contact_id points at; NOT contacts.contact_id, the secondary unique uuid this table also carries. Added by m517 for the owner ruling "motivated sellers source is for leads and contacts": before it, a contact could only be filed by putting a contacts id into lead_id, which produced rows no reader could ever match (tombstone: app/actions/lead-intelligence.ts:2444).';

-- ── 2. exactly one entity, enforced ─────────────────────────────────────────
-- NOT VALID: binds every future write from the moment it is applied, scans and
-- rejects nothing already stored. See the header — this migration must not be
-- able to fail on live data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'motivated_seller_signals_one_entity'
       AND conrelid = 'public.motivated_seller_signals'::regclass
  ) THEN
    ALTER TABLE public.motivated_seller_signals
      ADD CONSTRAINT motivated_seller_signals_one_entity
      CHECK ((lead_id IS NOT NULL) <> (contact_id IS NOT NULL))
      NOT VALID;
  END IF;
END $$;

-- …and validate it only if nothing already stored would fail. Measured live at
-- 0 rows on 2026-08-21, so this branch is expected to validate.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
    FROM public.motivated_seller_signals
   WHERE (lead_id IS NOT NULL) = (contact_id IS NOT NULL);

  IF offending = 0 THEN
    ALTER TABLE public.motivated_seller_signals
      VALIDATE CONSTRAINT motivated_seller_signals_one_entity;
    RAISE NOTICE 'm517: motivated_seller_signals_one_entity VALIDATED (0 pre-existing rows violate it).';
  ELSE
    -- Left NOT VALID on purpose. It still binds every new write; the existing
    -- rows are named by COUNT so somebody can look at them, rather than the
    -- migration aborting and taking the rest of this file with it.
    RAISE NOTICE 'm517: % pre-existing row(s) set both or neither entity column. motivated_seller_signals_one_entity is ENFORCED FOR NEW WRITES but left NOT VALID; those rows need a human decision (a uuid in lead_id that matches a contacts row is evidence, not proof, and moving it could relocate a genuine lead signal onto a stranger''s record).', offending;
  END IF;
END $$;

COMMENT ON CONSTRAINT motivated_seller_signals_one_entity ON public.motivated_seller_signals IS
  'Exactly one of (lead_id, contact_id) is set. Refuses a row about two people and refuses an orphan row about nobody — the latter being unreadable by construction, since every reader filters on one of these two columns. It does NOT catch a correct-looking uuid in the WRONG column: lead_id carries no FK to leads, so a contacts id sitting there satisfies this constraint. This closes the SHAPE class, not the misattribution class.';

-- ── 3. read paths for the new column, matching lead_id's ────────────────────
CREATE INDEX IF NOT EXISTS idx_motivated_seller_signals_contact
  ON public.motivated_seller_signals (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_motivated_seller_signals_brokerage_contact
  ON public.motivated_seller_signals (brokerage_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- ── 4. the dedupe guarantee, widened to the six new signal types ────────────
-- Created under the SAME NAME as m514's, so this is a redefinition of one rule
-- rather than a fifth parallel index. Dropped and recreated in that order
-- inside one transaction: unlike m514 (which crossed two index NAMES and so
-- created-then-dropped to avoid an unguarded window), here the name is
-- identical, CREATE cannot precede DROP, and the whole file is one transaction —
-- so there is no window in which a concurrent writer sees no rule.
DROP INDEX IF EXISTS public.motivated_seller_signals_external_dedupe;

CREATE UNIQUE INDEX motivated_seller_signals_external_dedupe
  ON public.motivated_seller_signals
     (signal_type, (signal_details ->> 'dedupe_key'))
  WHERE signal_type IN (
          -- lib/external/permit-signals.ts (Socrata + ArcGIS)
          'permit_activity', 'code_violation',
          -- lib/external/batchdata-seller-signals.ts — the original ten
          'sale_propensity', 'preforeclosure', 'tax_delinquent', 'involuntary_lien',
          'vacancy', 'absentee_owner', 'tired_landlord', 'listing_withdrawn',
          'high_equity', 'market_timing',
          -- …and the six added 2026-08-21 on the owner's second request for more
          -- motivated-seller signs. `active_listing` is a SUPPRESSION signal and
          -- is covered for the same reason as the rest: it is written by the
          -- same repeating probe, and a suppression fact re-filed daily is
          -- still a duplicate.
          'for_sale_by_owner', 'listed_below_market', 'corporate_owned',
          'fix_and_flip', 'vacant_lot', 'active_listing'
        )
    AND signal_details ? 'dedupe_key';

COMMENT ON INDEX public.motivated_seller_signals_external_dedupe IS
  'One signal per (signal_type, dedupe_key) for every EXTERNAL seller-signal sweep — the Socrata/ArcGIS permit + code-violation lane and the BatchData property-probe lane, across BOTH entity kinds (the dedupe_key itself names lead: or contact:, so the same fact about a lead and about a contact are two distinct keys). Both lanes re-read the same facts on a repeating cadence; without this, one fact becomes one signal per pass and lead scoring counts each as an independent reason to believe somebody is selling. m517 widens m514''s list by the six signal types the BatchData lane gained on 2026-08-21. The `signal_details ? dedupe_key` predicate is deliberate: app/actions/lead-intelligence.ts also writes high_equity, market_timing, property_condition and life_event WITHOUT a dedupe_key and must stay unconstrained by this rule.';
