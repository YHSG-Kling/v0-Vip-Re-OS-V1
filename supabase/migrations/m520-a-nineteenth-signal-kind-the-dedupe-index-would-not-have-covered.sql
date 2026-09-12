-- m520 — A NINETEENTH SIGNAL KIND THE DEDUPE INDEX WOULD NOT HAVE COVERED
--
-- The owner asked for motivated-seller signs BEYOND permits. Auditing this
-- lane's coverage against the provider's LIVE dataset catalogue (not against
-- memory) found it already sources 27 of the 38 `quickLists` flags across 18
-- signal kinds — comprehensive. `quickLists.trustOwned` was the one genuine
-- motivated-seller signal among the eleven it did not source, so the code half
-- adds it.
--
-- THIS FILE IS THE OTHER HALF, and without it the feature would be a defect.
-- `motivated_seller_signals_external_dedupe` is a PARTIAL unique index: it is
-- unique on (signal_type, signal_details->>'dedupe_key') only WHERE signal_type
-- is one of an ENUMERATED list. A kind that is not in that list has no
-- uniqueness rule at all, so the scheduled probe — which re-reads the same
-- properties on a rotation — would insert a fresh trust_owned row on every pass
-- and the lead's signal count would climb forever without a single new fact.
--
-- lib/external/batchdata-seller-signals.ts already carries the warning in prose:
-- "Adding a kind above without adding it to the index is how a repeating probe
-- starts duplicating (the defect m499 fixed for the permit lane, arriving here
-- for the same reason)." Two lanes have now hit this. The comment names it; the
-- index still has to be widened by hand, which is why it keeps happening.
--
-- WHY trustOwned AND NOT inherited. The neighbouring provider flag for the same
-- family of situations is `quickLists.inherited`, and it is REFUSED by
-- lib/lead-governance/protected-class-signals.ts — "inherited" is in
-- PROTECTED_CLASS_TOKENS under the owner's probate ruling, alongside "probate",
-- "heirs" and "deceased". `tokenizeFieldPath("quickLists.trustOwned")` yields
-- ["quick","lists","trust","owned"]: no banned token. The distinction is not a
-- loophole, it is the actual line — `inherited` describes what happened to a
-- PERSON, `trustOwned` describes how a PARCEL is titled on a recorded deed.
--
-- The list below is the previous eighteen verbatim plus 'trust_owned'. Read off
-- the live index definition rather than retyped from the migration that created
-- it, because those two can differ and the live one is the source of truth.

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
            'trust_owned'::text
         ]))
         AND (signal_details ? 'dedupe_key'::text));

-- Safe to DROP-then-CREATE rather than build concurrently: motivated_seller_signals
-- holds 0 rows live, so there is no index to rebuild and no window in which a
-- duplicate could slip through the gap. On a populated table this would want
-- CREATE INDEX CONCURRENTLY and a verify step.
