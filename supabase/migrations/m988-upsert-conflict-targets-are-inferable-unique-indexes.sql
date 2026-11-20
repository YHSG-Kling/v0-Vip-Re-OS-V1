-- ── APPLIED LIVE 2026-11-18 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 154, integrator ── read back: four non-partial unique indexes present; plan-only probe EXPLAIN INSERT … ON CONFLICT (channel, provider_ref) on outcome_reconciliations now reports 'Conflict Arbiter Indexes: uq_outcome_reconciliations_channel_ref_inferable'
--
-- m988 — four upsert writers can finally write: their conflict target becomes an INFERABLE unique index.
--
-- MEASURED LIVE 2026-11-18 (project hrvaqgvukzxfskkcrwbt). A census of every supabase-js upsert (208 call sites, 141 distinct
-- table + conflict-target pairs) was compared with pg_index. For these four the ONLY unique index on the target columns is
-- PARTIAL. PostgREST sends ON CONFLICT (cols) with no predicate; Postgres cannot infer a partial index from a bare column list
-- and refuses the whole statement — proven with a plan-only probe (EXPLAIN INSERT … ON CONFLICT (brokerage_id) on
-- brand_voice_profile → 42P10 "there is no unique or exclusion constraint matching the ON CONFLICT specification").
--
--   table                    target                                              the partial index it could not use
--   ai_daily_briefings       (agent_id, briefing_date)                           idx_ai_daily_briefings_agent_date            WHERE agent_id IS NOT NULL
--   outcome_reconciliations  (channel, provider_ref)                             outcome_reconciliations_ref_key              WHERE provider_ref IS NOT NULL
--   showings                 (showingtime_id)                                    idx_showings_showingtime_id                  WHERE showingtime_id IS NOT NULL
--   transaction_documents    (transaction_id, provider_source, external_document_id)  uq_transaction_documents_provider_external_id  WHERE provider_source IS NOT NULL AND external_document_id IS NOT NULL
--
-- Each new index is on the SAME columns with NO predicate. It admits exactly the rows the partial one admits: every predicate
-- above is "these key columns are not null", and NULLs are distinct in a unique index, so a row outside the old predicate can
-- never collide. Nothing that was allowed is refused; what changes is that the conflict target is now inferable.
--
-- The other two findings of the same census are fixed in CODE, not here: brand_voice_profile (brokerage_id) — its partial
-- predicate (agent_id IS NULL AND team_id IS NULL) is a real row filter, so the admin screen now saves through the existing
-- read-then-write server action; closing_cost_accuracy_observations (transaction_id, document_id) — a legacy fallback for a
-- two-column key the live table does not have, removed. competitor_ads was m987.
--
-- NOT in this migration (owner SQL, optional cleanup only): dropping the four now-redundant partial indexes.

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_daily_briefings_agent_date_inferable
  ON public.ai_daily_briefings (agent_id, briefing_date);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outcome_reconciliations_channel_ref_inferable
  ON public.outcome_reconciliations (channel, provider_ref);

CREATE UNIQUE INDEX IF NOT EXISTS uq_showings_showingtime_id_inferable
  ON public.showings (showingtime_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_documents_txn_provider_external_inferable
  ON public.transaction_documents (transaction_id, provider_source, external_document_id);
