-- supabase/migrations/m632-cash-buyer-is-a-twentyfourth-signal-type-the-dedupe-index-would-not-have-covered.sql
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m632_cash_buyer_dedupe_index) ──
--
-- Lane 65B (wave 65). CLAUDE.md §1/§3: files are not the database.
--
-- WHAT THIS DOES: lib/external/batchdata-seller-signals.ts BATCHDATA_SELLER_SIGNAL_SOURCES
-- gained a 24th declared source this wave — CASH_BUYER_SIGNAL_TYPE ("cash_buyer",
-- quickLists.cashBuyer) — the buyer/investor-side counterpart the owner asked
-- for verbatim: "batchdata has information that can help us with finding new
-- leads like motivated sellers... cash buyer/investor for buyer side". Every
-- migration on this lesson (m490, m499, m514, m517, m520, m521) widens the SAME
-- partial unique index rather than adding a parallel one, because
-- `motivated_seller_signals_external_dedupe` lists its covered signal_types
-- LITERALLY: a type declared in code and NOT added here carries NO uniqueness
-- rule at all, and a repeating daily/weekly probe re-files the same unchanged
-- fact every pass. Lead scoring COUNTS these rows.
--
-- The list below is m521's twenty-three verbatim plus 'cash_buyer', read off
-- m521's definition (supabase/migrations/m521-four-protected-class-derived-signal-kinds-the-dedupe-index-would-not-have-covered.sql)
-- rather than retyped from memory. scripts/batchdata-seller-signal-simulator.ts
-- reads the NEWEST migration defining this index (sorted by filename) and
-- asserts it covers every current BATCHDATA_SIGNAL_TYPES entry — so this file
-- needs no follow-up edit there, and neither does the next one.
--
-- signal_type carries no CHECK constraint on this table (scripts/check-vocabularies.ts
-- records only signal_strength for motivated_seller_signals) — no vocabulary
-- cache needs regenerating.
--
-- RE-MEASURE BEFORE APPLYING: m517/m520/m521 recorded 0 live rows against
-- project hrvaqgvukzxfskkcrwbt at time of writing, which is why DROP-then-CREATE
-- was safe rather than CREATE INDEX CONCURRENTLY. If the table has since taken
-- rows, re-check the count and use CONCURRENTLY + a verify step instead.

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
            'household_outgrown'::text,
            'cash_buyer'::text
         ]))
         AND (signal_details ? 'dedupe_key'::text));

COMMENT ON INDEX public.motivated_seller_signals_external_dedupe IS
  'One signal per (signal_type, dedupe_key) for every EXTERNAL seller-signal sweep. m632 widens m521''s list by cash_buyer, the BUYER-side demand signal added wave 65 (owner: cash buyer/investor for buyer side). The `signal_details ? dedupe_key` predicate stays deliberate: app/actions/lead-intelligence.ts also writes high_equity, market_timing, property_condition and life_event WITHOUT a dedupe_key and must stay unconstrained by this rule.';
