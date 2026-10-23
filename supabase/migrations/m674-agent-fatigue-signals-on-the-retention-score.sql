-- ── APPLIED LIVE 2026-09-29 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m674 — AGENT FATIGUE SIGNALS RIDE THE RETENTION SCORE ROW (wave 89, lane 89C).
--
-- Owner, verbatim (2026-09-29): "brokerages need agent fatigue signals so they can give the
-- support that they are lacking before they decide to leave." · "you should add any fields
-- necessary if their is a beneficial reason to add."
--
-- The agent retention radar (lib/recruiting/retention-radar.ts) already writes one
-- agent_retention_scores row per agent per day: composite_score, tier, trend, driving_signals
-- (text[]) and signal_breakdown (jsonb, key → 0..1). Wave 89 extends the SAME row — no second
-- table, no second scorer — with the fatigue signals the owner asked for. Two columns are added,
-- each with a reader already in the tree:
--
--   raw_signals jsonb — the RetentionSignals the score was computed from (days since activity,
--     active pipeline, reply lag, unanswered client messages, missed/rescheduled appointments,
--     session counts, overdue tasks, fatigued-book share, book transfers). The beneficial reason:
--     signal_breakdown stores 0..1 sub-scores, which is lossy — "pipeline shrinking" needs the
--     pipeline COUNT from ~30 days ago, and the radar reads it back from this column
--     (gatherFatigueSignals → activePipelinePrior). Without it the pipeline-drop signal cannot
--     exist, and the board could never say how far a number moved.
--
--   support_suggested text[] — the broker's "support suggested" lines
--     (lib/recruiting/retention-intervention.ts supportSuggestedLines), one per driving signal.
--     Read by the retention board on the Command Center, the broker-facing weekly coaching digest
--     and the support nudge. Stored so every surface shows the SAME words the radar decided on
--     that day (§6 — one vocabulary), never re-derived differently per reader.
--
-- Live before (read 2026-09-29, project hrvaqgvukzxfskkcrwbt): agent_retention_scores has
-- id, brokerage_id, agent_id, score_date, composite_score, previous_score, tier, score_trend,
-- driving_signals, signal_breakdown, created_at — 0 rows. Both columns are additive and
-- nullable/defaulted, so the existing readers (retention-board, retention-outcomes, the broker
-- brief, the weekly exec plan) are unaffected.
--
-- UNTIL APPLIED the radar's upsert names two absent columns and PostgREST refuses the WHOLE row
-- (PGRST204) — sentinelWrite ledgers the refusal; no score row lands. Apply before deploying 89C.

alter table public.agent_retention_scores
  add column if not exists raw_signals jsonb,
  add column if not exists support_suggested text[] not null default '{}'::text[];

comment on column public.agent_retention_scores.raw_signals is
  'wave 89 (lane 89C): the RetentionSignals the composite was computed from — the next run reads activePipeline back as its pipeline-drop baseline';
comment on column public.agent_retention_scores.support_suggested is
  'wave 89 (lane 89C): broker-facing "support suggested" lines per driving signal (retention-intervention supportSuggestedLines); never agent-facing';
