-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m509_…`. It was one of TWENTY files in this directory whose header said
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

-- m509 — A LEDGER ROW CAN NAME A MODEL THE PLATFORM CANNOT PRICE.
--
-- ── NOT APPLIED. WRITTEN, NOT RUN. The integrator applies this. ──────────────
--
-- WHAT THIS IS ABOUT
--
-- m508 said the first half of the rule: a row that claims tokens must name the
-- model that produced them. This says the other half, and it is the half that
-- decides the invoice.
--
-- `ai_tool_usage.cost_cents` is not stored independently of `model_used` — it
-- is DERIVED from it. lib/ai/cost-tracking.ts::calculateCost looks the label up
-- in getModelPricing() and, on a miss, does this:
--
--     console.warn(`Unknown model "${model}" - returning 0 cost`)
--     return 0
--
-- So a row that names a model outside the platform's ten-name vocabulary is
-- priced at ZERO while claiming real tokens. It satisfies m508 — it named
-- something — and it is silently unbilled. lib/finance/usage-metering.ts sums
-- BOTH columns into meter_readings.ai_tokens (units) and total_cost_cents
-- (cost), so such a row lands on the tenant's meter as consumption that cost
-- nothing, and the per-tier overage projection is derived from those same rows.
--
-- WHY THIS BECAME REACHABLE NOW
--
-- Until wave 13 every writer of this column handed calculateCost an `AIModel`
-- that had come from a routing decision, so the label could not be anything
-- else. Wave 13 added a second source: lib/ai/models.ts::modelIdentityFor turns
-- the GATEWAY model string a lane pinned ("anthropic/claude-sonnet-4-20250514")
-- back into a billing identity ("claude-sonnet"), so the AI Toolkit can record
-- the model that ACTUALLY served a call instead of the one it believed the lane
-- pins. That function is deliberately conservative — it returns NULL for a
-- string it cannot name unambiguously, and its callers book zero rather than a
-- guess — but the shape of the risk changed: a raw gateway string is now one
-- careless edit away from the column, and a raw gateway string prices at zero.
--
-- THE INVARIANT THE APPLICATION HOLDS, SAID IN THE SCHEMA
--
--   A row may leave the model unnamed. If it names one, it must name one the
--   platform can price.
--
-- The list below is `AIModel` in lib/ai/cost-tracking.ts, which is also exactly
-- the key set of getModelPricing(). Adding a model to the platform means adding
-- it in both places; that is the point — a name that exists in one and not the
-- other is a row nobody can price.

ALTER TABLE public.ai_tool_usage
  ADD CONSTRAINT ai_tool_usage_model_is_priceable
  CHECK (
    model_used IS NULL
    OR model_used IN (
      'claude-sonnet',
      'claude-opus',
      'claude-haiku',
      'gpt-4o',
      'gpt-4-turbo',
      'gpt-4o-mini',
      'gemini-pro',
      'gemini-flash',
      'perplexity-sonar',
      'perplexity-sonar-pro'
    )
  )
  NOT VALID;

-- ── AND THEN VALIDATED, BECAUSE THE HISTORY WAS MEASURED, NOT ASSUMED ────────
--
-- NOT VALID above exists for the database that DOES carry unpriceable labels:
-- there, the ADD still succeeds and still refuses new ones, and only this
-- VALIDATE fails — loud, recoverable, and correct. On this database, measured
-- 2026-08-20 (live, not inferred):
--
--     select coalesce(model_used,'(null)'), count(*), sum(coalesce(tokens_used,0))
--       from public.ai_tool_usage group by 1;
--       -> gpt-4o          22 rows, 13110 tokens
--       -> claude-sonnet    1 row,    245 tokens
--
--     rows naming a model outside the priceable vocabulary   -> 0
--     rows claiming tokens with no model at all (m508's rule) -> 0
--     rows claiming tokens that priced to 0 cents             -> 0
--
-- Both labels present are in the vocabulary and every token-bearing row carries
-- a non-zero cost, so there is no billing history to reconcile and no owner
-- decision to wait on. The rule is enforced over the whole table rather than
-- only over rows written from now on.
ALTER TABLE public.ai_tool_usage
  VALIDATE CONSTRAINT ai_tool_usage_model_is_priceable;

COMMENT ON CONSTRAINT ai_tool_usage_model_is_priceable ON public.ai_tool_usage IS
  'A ledger row that names a model must name one getModelPricing() can price. calculateCost '
  'returns 0 for an unknown label, so an out-of-vocabulary model_used produces a row that '
  'claims tokens and costs nothing — it passes m508 and is silently unbilled on the tenant''s '
  'meter. Companion to ai_tool_usage_tokens_name_their_model (m508): that one requires a name, '
  'this one requires the name to mean something.';

-- ── WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────────
--
-- It does not require cost_cents to equal the price of the tokens. Pricing
-- changes over time and the historical rate is snapshotted per row in
-- context_json.pricing_snapshot, not recomputable from today's table — so a
-- CHECK asserting the arithmetic would start failing the day a rate moves.
-- What a CHECK can say is that the label is one the pricing table knows, and
-- that is what this says.
--
-- PROOF: scripts/ai-tools-hub-tenanted-spend-simulator.ts
-- (test:ai-tools-hub-tenanted-spend) holds the application half — that
-- model_used is the model the lane reports SERVED the call rather than the one
-- it pins, that counts which cannot be attributed to a model book zero instead
-- of being priced against a guess, and that modelIdentityFor returns NULL for a
-- gateway id two priceable identities share (gemini-pro and gemini-flash both
-- map to google/gemini-2.0-flash-exp and price 16x apart) rather than picking
-- one. Negative controls reintroduce each defect and require the proof to go red.
