-- m623 — ai_tool_usage_model_is_priceable ADDS gpt-5-mini.
--
-- ── APPLIED LIVE 2026-09-12 by the integrator (Supabase MCP apply_migration); scripts/check-vocabularies.ts regenerated from the live constraints the same day. ──
--
-- WHAT THIS IS ABOUT
--
-- Wave 59 (docs/ai-agent-surfaces-2026-09.md) adds `gpt-5-mini` as a NEW
-- AIModel billing identity (lib/ai/cost-tracking.ts) — the primary model for
-- the anonymous website-widget chat surface (AI_TASK_ROUTING.widget_visitor_chat)
-- and the fallback for four other chat-surface routing keys. m509's CHECK
-- constraint `ai_tool_usage_model_is_priceable` enumerates the platform's
-- priceable vocabulary as a closed list, and 'gpt-5-mini' is not in it.
--
-- Left unfixed, the FIRST widget_visitor_chat turn that reaches
-- logAIUsage (lib/ai/cost-tracking.ts) with model_used='gpt-5-mini' is
-- REFUSED by this CHECK — a Postgres constraint violation, caught by
-- logAIUsage's try/catch and logged to console.error, never surfaced to the
-- caller. CLAUDE.md §3: "supabase-js RESOLVES refusals... a swallowed refusal
-- degrades silently." The public-facing, highest-volume, cheapest-per-token
-- chat surface this wave was built to route onto the new model would book
-- ZERO ledger rows for it — unbilled, uncapped spend on exactly the lane the
-- wave's own doc names first.
--
-- m509's own comment states the rule plainly: "The list below is `AIModel` in
-- lib/ai/cost-tracking.ts... Adding a model to the platform means adding it in
-- both places; that is the point — a name that exists in one and not the
-- other is a row nobody can price." This migration is the other half of that
-- addition — code-side, lib/ai/cost-tracking.ts's AIModel union and
-- getModelPricing() already carry 'gpt-5-mini' (see docs/ai-agent-surfaces-2026-09.md
-- §2 for the verified price, $0.25/$2.00 per 1M tokens, source
-- https://vercel.com/ai-gateway/models/gpt-5-mini).
--
-- A constraint cannot be ALTERed in place — drop and re-add under the SAME
-- name (m509's name, so scripts/ai-tools-hub-tenanted-spend-simulator.ts and
-- any other reference to `ai_tool_usage_model_is_priceable` keeps working
-- unchanged) with the widened list.

ALTER TABLE public.ai_tool_usage
  DROP CONSTRAINT IF EXISTS ai_tool_usage_model_is_priceable;

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
      'gpt-5-mini',
      'gemini-pro',
      'gemini-flash',
      'perplexity-sonar',
      'perplexity-sonar-pro'
    )
  )
  NOT VALID;

-- ── VALIDATE ─────────────────────────────────────────────────────────────────
-- m509 already validated the ten-name vocabulary over the whole table; adding
-- an eleventh name to the allow-list cannot make any EXISTING row newly
-- invalid (the check only got wider), so VALIDATE here is expected to pass
-- immediately regardless of what the live table contains. Still run
-- explicitly (never left NOT VALID) so a future row is checked against the
-- validated state, not merely the unvalidated one.
ALTER TABLE public.ai_tool_usage
  VALIDATE CONSTRAINT ai_tool_usage_model_is_priceable;

COMMENT ON CONSTRAINT ai_tool_usage_model_is_priceable ON public.ai_tool_usage IS
  'A ledger row that names a model must name one getModelPricing() can price. calculateCost '
  'returns 0 for an unknown label, so an out-of-vocabulary model_used produces a row that '
  'claims tokens and costs nothing — it passes m508 and is silently unbilled on the tenant''s '
  'meter. Companion to ai_tool_usage_tokens_name_their_model (m508): that one requires a name, '
  'this one requires the name to mean something. Widened m623 to add gpt-5-mini '
  '(docs/ai-agent-surfaces-2026-09.md, wave 59).';

-- ── AFTER THIS APPLIES ───────────────────────────────────────────────────────
-- CLAUDE.md §3: "After any applied migration that adds a CHECK, regenerate the
-- vocabulary cache so check-vocabulary-guard can hold code and database in
-- agreement." scripts/check-vocabularies.ts's ai_tool_usage.model_used row
-- must be regenerated (piped from live JSON, per that generator's own header)
-- to include 'gpt-5-mini' once this migration is APPLIED — not before, and
-- not hand-edited here, since a lane's own SQL file is not the database
-- (§3) and the cache generator's contract is live JSON in, never a manual
-- typed list.
