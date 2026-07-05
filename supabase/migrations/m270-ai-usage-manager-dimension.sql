-- m270-ai-usage-manager-dimension.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PER-MANAGER COST + LATENCY. ai_tool_usage already carries cost_cents,
-- execution_time_ms, and success — but nothing joined it to the 13 AI MANAGERS
-- (agent_kind), so the platform could not answer "what does each manager cost /
-- how fast is it / how often does it fail?" — the #1 operability question for an
-- autonomous AI OS. This adds the manager dimension so a per-manager cost/latency/
-- SLO rollup (lib/platform/manager-ops.ts) can attribute spend + p95 + error-rate
-- to the responsible manager. Additive + nullable; unattributed rows roll up under
-- an 'unassigned' bucket (honest — instrumentation grows over time).

alter table public.ai_tool_usage add column if not exists manager text;

create index if not exists idx_ai_tool_usage_manager
  on public.ai_tool_usage (manager, created_at)
  where manager is not null;
