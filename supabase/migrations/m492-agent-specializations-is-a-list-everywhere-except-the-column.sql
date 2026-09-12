-- m492 — agents.specializations is a LIST in all five places that touch it, and a
-- single varchar in the one place that stores it.
--
-- THE DISAGREEMENT
--   app/actions/agents.ts:436          updateAgent(updates: { specializations: string[] })
--   app/p/[agentSlug]/page.tsx:26      specializations: string[] | null   → .length / .map()
--   app/actions/onboarding/mentorship.ts:39,42                            → rankMentorMatches
--   lib/recruiting/mentor-match.ts:16,27,49,50                            → .map(s => s.toLowerCase())
--   public.agents.specializations      character varying
--
-- Every consumer is unanimous; the column is the outlier. Two things follow from that,
-- and both are already true in production:
--
--   1. IT CAN NEVER BE SAVED. updateAgent spreads a JS array into an UPDATE on a varchar
--      column, so PostgREST sends a JSON array at a scalar text column and the write is
--      refused. That is why the live table has ZERO non-null specializations rows — not
--      because nobody filled the field in, but because filling it in never worked.
--
--   2. IF IT EVER WERE SAVED, TWO READERS WOULD CRASH. A string has a .length, so the
--      public agent-profile page's `specializations.length > 0` guard PASSES on a plain
--      string and then calls .map() on it — "specializations.map is not a function" on a
--      public, unauthenticated route. mentor-match.ts:49-50 does the same .map().
--
-- THE FIX IS THE COLUMN, NOT THE CODE. Five call sites agreeing on `string[]` is the
-- vocabulary; a lone varchar is the typo. And it is free to correct: there is no data to
-- migrate, so the USING clause below is a formality that exists only so the statement is
-- still correct if a row is written between this file being read and being applied.
--
-- No view, index, or constraint depends on the column (checked against pg_depend).

-- A USING expression may not contain a subquery (0A000), so the two shapes a stray value
-- could take — a JSON array `["Luxury","Condos"]` and a typed list `Luxury, Condos` — are
-- normalised by one expression instead of two branches: strip the JSON punctuation, then
-- split on a comma with its surrounding whitespace, which trims each element in the split.
ALTER TABLE public.agents
  ALTER COLUMN specializations TYPE text[]
  USING CASE
    WHEN specializations IS NULL OR btrim(specializations) = '' THEN NULL
    ELSE regexp_split_to_array(btrim(translate(specializations, '[]"', '')), '\s*,\s*')
  END;

COMMENT ON COLUMN public.agents.specializations IS
  'Agent specialties as a list. text[] since m492 — every reader (public profile page, '
  'mentor matcher) and the only writer (updateAgent) type it string[]; as a varchar the '
  'write was refused outright and a stored string would have crashed .map() on the public '
  'profile route.';
