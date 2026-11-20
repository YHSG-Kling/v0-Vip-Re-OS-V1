-- m378 — home_value_estimates: let the record say what actually produced the number.
--
-- WHY
-- The seller-facing home-value lane used to ask a chat model to "Provide exactly
-- 3 comparable sales" and stored whatever came back in comps_json, which the
-- public result page renders as "N similar properties recently sold near you" —
-- addresses, sale prices and sale dates that no transaction ever produced. It
-- also stamped methodology='ai_cma' on every row regardless, so the record
-- asserted a comparative market analysis had been performed when none had.
--
-- That lane now runs lib/cma/ai-cma-orchestrator.runAiCma (grounded comps,
-- state appraiser-guideline adjustments, citations) — the same engine the
-- workflow AVM/CMA adapter and the listing-presentation builder already use.
-- Two states the old vocabulary could not express, and which the code now
-- needs to write:
--
--   methodology='sqft_regional_average'
--     No comparable sale could be sourced. The range is sqft x a conservative
--     regional rate. That is NOT a CMA. Forcing it into 'ai_cma' is the lie
--     that let invented sales reach a homeowner; forcing it into 'manual' is a
--     different lie (no human did it). It needs its own name.
--
--   market_trend='unknown'
--     No market_data row covers the property's ZIP or city yet, so the
--     direction of the market is genuinely not known. The old vocabulary
--     offered only appreciating/stable/depreciating, so the code defaulted to
--     'stable' — an assertion the seller cannot check and we cannot support.
--     NULL is not a substitute: NULL cannot be told apart from "this column was
--     never written", and the distinction between "we looked and there was no
--     data" and "we never looked" is the entire point.
--
-- Both are pure vocabulary WIDENING. Every value the old CHECKs admitted is
-- still admitted, so no existing row can be invalidated.

BEGIN;

ALTER TABLE public.home_value_estimates
  DROP CONSTRAINT IF EXISTS home_value_estimates_methodology_check;

ALTER TABLE public.home_value_estimates
  ADD CONSTRAINT home_value_estimates_methodology_check
  CHECK (methodology = ANY (ARRAY[
    'ai_cma'::text,
    'housecanary'::text,
    'attom'::text,
    'manual'::text,
    'sqft_regional_average'::text
  ]));

ALTER TABLE public.home_value_estimates
  DROP CONSTRAINT IF EXISTS home_value_estimates_market_trend_check;

ALTER TABLE public.home_value_estimates
  ADD CONSTRAINT home_value_estimates_market_trend_check
  CHECK (market_trend = ANY (ARRAY[
    'appreciating'::text,
    'stable'::text,
    'depreciating'::text,
    'unknown'::text
  ]));

COMMIT;

-- Prove both constraints accept the new vocabulary AND still reject garbage,
-- so a silently-dropped constraint cannot pass as success.
DO $$
DECLARE
  m_def text;
  t_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO m_def
    FROM pg_constraint WHERE conname = 'home_value_estimates_methodology_check';
  SELECT pg_get_constraintdef(oid) INTO t_def
    FROM pg_constraint WHERE conname = 'home_value_estimates_market_trend_check';

  IF m_def IS NULL OR m_def NOT LIKE '%sqft_regional_average%' THEN
    RAISE EXCEPTION 'm378: methodology CHECK missing or does not admit sqft_regional_average (got: %)', m_def;
  END IF;
  IF m_def NOT LIKE '%ai_cma%' THEN
    RAISE EXCEPTION 'm378: methodology CHECK dropped the pre-existing ai_cma value (got: %)', m_def;
  END IF;
  IF t_def IS NULL OR t_def NOT LIKE '%unknown%' THEN
    RAISE EXCEPTION 'm378: market_trend CHECK missing or does not admit unknown (got: %)', t_def;
  END IF;
  IF t_def NOT LIKE '%appreciating%' THEN
    RAISE EXCEPTION 'm378: market_trend CHECK dropped the pre-existing appreciating value (got: %)', t_def;
  END IF;
END $$;
