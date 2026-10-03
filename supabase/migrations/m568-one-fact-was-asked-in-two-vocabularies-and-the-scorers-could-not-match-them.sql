-- m568 — ONE FACT WAS ASKED IN TWO VOCABULARIES AND THE SCORERS COULD NOT MATCH THEM.
--
-- THE RULING (§6, adjudicated in the previous wave and recorded at
-- lib/behavior-learning/signal-mapping.ts): the buyer's verdict on the HOUSE is
-- one fact spoken by two different speakers —
--
--   showings.buyer_interest_level        love_it | like_it | maybe | no   (the buyer's own tap,
--   tour_stops.buyer_interest_level      love_it | like_it | maybe | no    via portalInterestToShowingLevel)
--   showing_feedback.overall_impression  loved_it | liked_it | neutral | not_interested
--                                                                         (the third-party SHOWING AGENT's
--                                                                          tokenized form)
--
-- BOTH COLUMNS STAY. showing_feedback.showing_id is NOT NULL, so one showing can
-- carry the buyer's tap AND the showing agent's form — and they can DISAGREE.
-- Merging the columns would destroy who said it. What merges is the VOCABULARY:
-- four rungs, one spelling, so every aggregate scorer (seller sentiment, listing
-- health, the portal feedback card) compares like with like instead of holding a
-- private translation table. tourInterestToRating is the one ladder both columns
-- now land on; impressionToRating is retired into it by the same wave that ships
-- this file.
--
-- NOT TOUCHED, deliberately: showing_feedback.buyer_interest_level
-- (hot | warm | cool | cold) is a DIFFERENT fact — the Q9 buyer TEMPERATURE, the
-- same axis as contacts.lead_temperature — adjudicated not-a-duplicate at
-- signal-mapping.ts (feedbackTemperatureToRating's header). Its CHECK is not in
-- this file and must never be folded into this one.
--
-- ROW COUNT AT WRITE TIME: showing_feedback 0, showings 0, tour_stops 0
-- (project hrvaqgvukzxfskkcrwbt, verified 2026-08-27). The mapping UPDATE below
-- is therefore expected to touch 0 rows — it exists so this file stays correct
-- if a tokenized form lands between now and apply. Zero touched is success here,
-- not silence (§3: the caller decides what zero rows means; here it is the
-- desired outcome, and the NOTICE says which case happened).
--
-- ORDER OF OPERATIONS FOR THE INTEGRATOR — this is the whole ballgame:
--   1. APPLY this migration.
--   2. REGENERATE the vocabulary cache (scripts/generate-check-vocabularies.ts
--      per its header SQL) so check-vocabulary-guard sees the new CHECK.
--   3. DEPLOY the code of this wave. The deployed writer
--      (app/api/showings/feedback/[token]/route.ts) writes the NEW vocabulary
--      and normalises any stale old-vocabulary client at the boundary, so a
--      form tab opened before the deploy still lands correctly after it.
-- Deploying the new writer BEFORE applying this file would have it write
-- 'love_it' into a CHECK that only admits 'loved_it' — every submission refused
-- with 23514. Apply first.

DO $$
DECLARE
  touched integer;
BEGIN
  -- Drop the old-vocabulary CHECK first so the mapping UPDATE cannot be refused
  -- by the very constraint it is escaping. Name verified live 2026-08-27.
  ALTER TABLE public.showing_feedback
    DROP CONSTRAINT IF EXISTS showing_feedback_overall_impression_check;

  -- Defensive mapping for any row that landed since the 0-row verification.
  UPDATE public.showing_feedback
     SET overall_impression = CASE overall_impression
                                WHEN 'loved_it'       THEN 'love_it'
                                WHEN 'liked_it'        THEN 'like_it'
                                WHEN 'neutral'         THEN 'maybe'
                                WHEN 'not_interested'  THEN 'no'
                              END
   WHERE overall_impression IN ('loved_it', 'liked_it', 'neutral', 'not_interested');

  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched = 0 THEN
    RAISE NOTICE 'm568: 0 rows remapped — the table was still empty at apply, as measured at write time';
  ELSE
    RAISE NOTICE 'm568: % row(s) landed between write and apply and were remapped old->new', touched;
  END IF;

  -- The one vocabulary. Same four rungs, same spelling as
  -- showings.buyer_interest_level and tour_stops.buyer_interest_level.
  ALTER TABLE public.showing_feedback
    ADD CONSTRAINT showing_feedback_overall_impression_check
    CHECK (overall_impression = ANY (ARRAY['love_it'::text, 'like_it'::text, 'maybe'::text, 'no'::text]));
END $$;

-- Post-state assertion: no row may hold an old spelling, and the new CHECK must
-- exist under the SAME name the vocabulary generator will read.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.showing_feedback
     WHERE overall_impression IN ('loved_it', 'liked_it', 'neutral', 'not_interested')
  ) THEN
    RAISE EXCEPTION 'm568: old-vocabulary rows survived the remap';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'showing_feedback'
       AND c.conname = 'showing_feedback_overall_impression_check'
       AND pg_get_constraintdef(c.oid) LIKE '%love_it%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%loved_it%'
  ) THEN
    RAISE EXCEPTION 'm568: the new overall_impression CHECK is missing or still speaks the old vocabulary';
  END IF;
END $$;
