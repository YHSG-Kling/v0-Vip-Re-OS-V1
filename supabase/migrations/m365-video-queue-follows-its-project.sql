-- m365-video-queue-follows-its-project.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY QUEUED VIDEO SPUN FOREVER.
--
-- video_generation_queue has a status column and THREE writers that set it —
-- 'queued' on insert, then 'generating' or 'generating_audio' when a render is
-- kicked. NOTHING in the entire codebase ever wrote 'completed' or 'failed'.
-- Not one row could reach a terminal state, so the Content Studio queue showed
-- work in flight that had in fact finished (or died) minutes later, forever.
--
-- The bridge to fix it ALREADY EXISTED and was never used:
--
--     video_generation_queue.project_id
--       FOREIGN KEY (project_id) REFERENCES ai_video_projects(id) ON DELETE CASCADE
--
-- ai_video_projects is the rail that genuinely completes. poll-did-videos drives
-- a D-ID job to 'completed' or 'failed' (it even treats a provider 404 as
-- terminal), the Remotion render routes write terminal statuses, and
-- lib/video/video-pipeline-reaper.ts sweeps anything that stalls and marks it
-- 'failed'. So a queue row that points at a project has a guaranteed terminal
-- outcome available to it — the two ledgers were simply never connected.
--
-- WHY A TRIGGER RATHER THAN CODE. There are already ~15 distinct places that
-- write a terminal ai_video_projects.status (poll-did-videos, the two Remotion
-- render routes, director-reel-render, listing-promo-hybrid-composite,
-- create-video-project, avatar-explainer, video-director, the reaper, …).
-- Mirroring from each one is a rule that a future writer silently breaks by not
-- knowing about it — which is exactly how this defect was born. At the database
-- the mirror is unmissable: any writer, any client, any future code path.
--
-- VOCABULARY. The queue's status is read by the Content Studio badge map in
-- app/components/content-studio/LinkToVideoGenerator.tsx, which renders
-- draft | generating_audio | creating_video | adding_subtitles | completed |
-- failed. The project's terminal set is declared in
-- lib/video/video-pipeline-reaper-policy.ts TERMINAL_STATES. Map:
--
--     completed | ready | published | distributed  -> 'completed'
--     failed    | cancelled                        -> 'failed'
--     generating | rendering | remotion_pending    -> 'creating_video'
--
-- 'creating_video' is mirrored too so the queue stops sitting at
-- 'generating_audio' while the project is demonstrably past that stage.
--
-- Neither table has a status CHECK; both vocabularies are enforced in code.
-- Adding a member to either list means revisiting this mapping.

-- ─── the mirror ──────────────────────────────────────────────────────────────

create or replace function public.video_queue_follow_project_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  mapped text;
  is_terminal boolean;
begin
  -- Only act when the status actually moved. An UPDATE that rewrites other
  -- columns must not re-stamp processed_at.
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status in ('completed', 'ready', 'published', 'distributed') then
    mapped := 'completed'; is_terminal := true;
  elsif new.status in ('failed', 'cancelled') then
    mapped := 'failed';    is_terminal := true;
  elsif new.status in ('generating', 'rendering', 'remotion_pending') then
    mapped := 'creating_video'; is_terminal := false;
  else
    return new;  -- draft / pending / awaiting_presenter_setup: nothing to mirror
  end if;

  update public.video_generation_queue q
     set status       = mapped,
         processed_at = case when is_terminal then now() else q.processed_at end
   where q.project_id = new.id
     -- A terminal queue row is final. Without this a project that is later
     -- re-rendered would drag a delivered video back into an in-flight state.
     and coalesce(q.status, '') not in ('completed', 'failed');

  return new;
end;
$$;

comment on function public.video_queue_follow_project_status() is
  'Mirrors ai_video_projects.status onto video_generation_queue rows via project_id. Nothing else ever wrote a terminal queue status, so every queued video spun forever. See m365.';

drop trigger if exists trg_video_queue_follow_project_status on public.ai_video_projects;

create trigger trg_video_queue_follow_project_status
  after update of status on public.ai_video_projects
  for each row
  execute function public.video_queue_follow_project_status();

-- ─── the index the mirror rides ──────────────────────────────────────────────
-- The UPDATE above filters on project_id on every terminal project transition.

create index if not exists idx_video_generation_queue_project_id
  on public.video_generation_queue (project_id)
  where project_id is not null;

-- ─── backfill ────────────────────────────────────────────────────────────────
-- Rows already stranded: a queue row whose project has ALREADY finished or
-- failed. Without this they stay stuck at their old status forever, because the
-- trigger only fires on future transitions.

update public.video_generation_queue q
   set status       = case
                        when p.status in ('completed', 'ready', 'published', 'distributed') then 'completed'
                        else 'failed'
                      end,
       processed_at = coalesce(q.processed_at, now())
  from public.ai_video_projects p
 where q.project_id = p.id
   and p.status in ('completed', 'ready', 'published', 'distributed', 'failed', 'cancelled')
   and coalesce(q.status, '') not in ('completed', 'failed');
