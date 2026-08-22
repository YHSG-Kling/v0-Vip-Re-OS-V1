-- m521 — FOUR PROTECTED-CLASS-DERIVED SIGNAL KINDS THE DEDUPE INDEX WOULD NOT
--        HAVE COVERED
--
-- Owner rulings, verbatim (2026-08-22):
--   "297 just release it from fairhousing."
--   "all motivatied seller classifiers are necessary for data especially
--    demographics and protected class."
--   "304 needs inherited and probate"
--
-- Finding #297 released the last fair-housing REFUSAL on the data lane, and
-- finding #304 asked for inherited/probate. lib/external/batchdata-seller-signals.ts
-- now declares four new signal kinds, each derived from a source the classifier
-- labels protected:
--
--   inherited_property  — quickLists.inherited plus the recorded probate deed
--                         instrument (deedHistory.documentType /
--                         sale.lastSale.documentType)
--   senior_owner        — quickLists.seniorOwner, demographics.age
--   recent_divorce      — demographics.recentlyDivorced, demographics.maritalStatus
--   household_outgrown  — demographics.householdSize vs building.bedroomCount
--
-- WHY THE PROVIDER FIELD NAMES ARE THESE AND NOT OTHERS. They were read live
-- from BatchData's own dataset catalogue on 2026-08-22, not from memory:
-- `list_property_datasets` (15 datasets), `list_property_dataset_fields
-- quicklist` (39 entries, one of which is quickLists.inherited), `demographic`
-- (32 entries), `deed` (27) and `core` (258). THE PROVIDER PUBLISHES NO FIELD,
-- FILTER OR QUICKLIST SLUG NAMED "probate" ANYWHERE — `quickLists.inherited` IS
-- its probate list, which is why one signal kind carries both words rather than
-- two kinds carrying one each (CLAUDE.md §6).
--
-- THIS FILE IS THE OTHER HALF, and without it the feature would be a defect.
-- `motivated_seller_signals_external_dedupe` is a PARTIAL unique index: unique
-- on (signal_type, signal_details->>'dedupe_key') only WHERE signal_type is one
-- of an ENUMERATED list. A kind absent from that list has no uniqueness rule at
-- all, so the scheduled probe — which re-reads the same properties on a rotation
-- — would insert a fresh inherited_property row on every pass and the lead's
-- signal count would climb forever without one new fact. Lead scoring COUNTS
-- these rows.
--
-- SIX MIGRATIONS ON THIS ONE LESSON NOW (m490, m499, m514, m517, m520, m521).
-- The code carries the warning in prose and the index still has to be widened by
-- hand, which is why it keeps happening. The check that catches it lives in
-- scripts/batchdata-seller-signal-simulator.ts and reads the NEWEST definition
-- of the index rather than a pinned filename, so this file needs no follow-up
-- edit there.
--
-- WHAT DID *NOT* CHANGE, stated because it is the thing a reader will worry
-- about. `signal_type` has no CHECK constraint on this table (verified against
-- scripts/check-vocabularies.ts, which records only signal_strength for
-- motivated_seller_signals), so no vocabulary cache needs regenerating. And
-- `signal_details` is jsonb, so the new
-- `signal_details.protected_class_basis` key — the source AND the classifier's
-- reason sentence for every protected-class-derived signal — needs no column at
-- all. It is added by lib/external/batchdata-seller-signals.ts
-- `buildBatchDataSignalRow` and is on every row, `[]` for the seventeen kinds
-- derived purely from parcel state.
--
-- The list below is m520's nineteen verbatim plus the four new kinds, read off
-- m520's definition rather than retyped from memory.

DROP INDEX IF EXISTS public.motivated_seller_signals_external_dedupe;

CREATE UNIQUE INDEX motivated_seller_signals_external_dedupe
  ON public.motivated_seller_signals
  USING btree (signal_type, ((signal_details ->> 'dedupe_key'::text)))
  WHERE ((signal_type = ANY (ARRAY[
            'permit_activity'::text,
            'code_violation'::text,
            'sale_propensity'::text,
            'preforeclosure'::text,
            'tax_delinquent'::text,
            'involuntary_lien'::text,
            'vacancy'::text,
            'absentee_owner'::text,
            'tired_landlord'::text,
            'listing_withdrawn'::text,
            'high_equity'::text,
            'market_timing'::text,
            'for_sale_by_owner'::text,
            'listed_below_market'::text,
            'corporate_owned'::text,
            'fix_and_flip'::text,
            'vacant_lot'::text,
            'active_listing'::text,
            'trust_owned'::text,
            'inherited_property'::text,
            'senior_owner'::text,
            'recent_divorce'::text,
            'household_outgrown'::text
         ]))
         AND (signal_details ? 'dedupe_key'::text));

-- Safe to DROP-then-CREATE rather than build concurrently: motivated_seller_signals
-- held 0 rows at the last live measurement against project hrvaqgvukzxfskkcrwbt
-- (2026-08-21, recorded in m517 and m520), so there is no index to rebuild and no
-- window in which a duplicate could slip through the gap. RE-MEASURE BEFORE
-- APPLYING: on a populated table this wants CREATE INDEX CONCURRENTLY and a
-- verify step, and the row count is the only thing that decides which.
--
-- NOT APPLIED BY THIS LANE. Files are not the database (CLAUDE.md §3); the
-- integrator applies it.
