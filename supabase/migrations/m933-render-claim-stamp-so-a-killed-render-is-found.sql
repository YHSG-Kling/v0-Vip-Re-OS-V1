-- WRITTEN, NOT APPLIED (wave 153, lane 153J) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL
--
-- A CLAIMED RENDER THAT NEVER FINISHED IS FOUND (wave 153, lane 153J; owner ruling 15 "remotion errors need to be resolved";
-- directive §153J "crash/retry/poison jobs … no rendered success if the output is absent").
--
-- THE DEFECT. app/api/internal/remotion/render-composition/route.ts claims a row `queued → rendering` and then has ONE function
-- lifetime (segment maxDuration 300 s) to write succeeded / failed / cancelled. A process the platform kills at that cap, on a
-- memory limit or on an instance recycle writes nothing — and nothing ever read a `rendering` row again: the bounded auto-requeue,
-- the failure census and the OS-health detector (media_render_failures) all read `failed`; lib/video/video-pipeline-reaper.ts reads
-- ai_video_projects. So the very timeouts the census files as "transient for ONE bounded retry" were never retried or escalated, and
-- readers that wait on an in-flight render (lib/kernel/lead-magnets.ts, lib/platform/product-content-autopilot.ts) waited forever.
--
-- CENSUS (live, read-only, 2026-11-14): remotion_composition_renders has created_at and completed_at and NO claim time, no
-- updated_at and no triggers; 0 rows (the platform has not rendered in production). created_at cannot stand in: a row may sit
-- queued for hours behind the one-row-per-tick drain and then render legitimately, so reaping on created_at would kill live work.
--
-- THE FIX. One nullable column, stamped by a TRIGGER on the transition into 'rendering' — never by the claim's own UPDATE, so a
-- lagging migration can never turn every claim into a PGRST204 refusal (which would block the whole queue). The code only READS it
-- (lib/remotion/registry.ts recoverStalledRenders, called by app/api/cron/composition-render-queue/route.ts): a claim older than
-- RENDER_STALL_AFTER_MS (three route lifetimes, lib/remotion/render-decision.ts) is failed `render_stalled` and the bounded requeue
-- retries it. Before this migration is applied that read is refused and the sweep reports it as a no-op — the drain is unaffected.
--
-- No backfill: 0 rows live. A `rendering` row without a stamp (claimed before this trigger) is judged on created_at with a 24 h
-- horizon (LEGACY_RENDER_STALL_AFTER_MS) rather than reaped early.
--
-- ROLLBACK: drop trigger trg_stamp_render_claimed_at on public.remotion_composition_renders;
--           drop function public.stamp_render_claimed_at();
--           the index and the column are owner SQL (DROP INDEX / DROP COLUMN) — docs/operations/OWNER-SQL.md § O. Wave 153.
--           Code tolerates the column's absence (the stall sweep reports a refused read and moves nothing).

alter table public.remotion_composition_renders
  add column if not exists claimed_at timestamptz;

comment on column public.remotion_composition_renders.claimed_at is
  'm933 (wave 153, lane 153J): when this render was last claimed queued → rendering. Stamped ONLY by trigger trg_stamp_render_claimed_at (the claim UPDATE names no new column). Read by lib/remotion/registry.ts recoverStalledRenders: a claim older than three route lifetimes is a killed render and is failed render_stalled for the bounded auto-requeue.';

create or replace function public.stamp_render_claimed_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.render_status = 'rendering' and old.render_status is distinct from 'rendering' then
    new.claimed_at := now();
  end if;
  return new;
end
$$;

comment on function public.stamp_render_claimed_at() is
  'm933 (wave 153, lane 153J): stamps remotion_composition_renders.claimed_at on every transition INTO rendering (a re-claim after an auto-requeue re-stamps).';

drop trigger if exists trg_stamp_render_claimed_at on public.remotion_composition_renders;
create trigger trg_stamp_render_claimed_at
  before update of render_status on public.remotion_composition_renders
  for each row execute function public.stamp_render_claimed_at();

-- The stall sweep reads only in-flight rows; a partial index keeps that read a few index pages however large the table grows.
create index if not exists idx_remotion_renders_rendering_claimed
  on public.remotion_composition_renders (claimed_at)
  where render_status = 'rendering';
