-- m374 — ai_video_projects.status becomes ONE vocabulary, enforced.
--
-- The column had no CHECK and 22 distinct values written or read across the
-- codebase. Five of those were READ by filters nothing ever wrote, so the UI
-- panels behind them were structurally empty — VideosDashboard "Recent Videos"
-- filtered status = 'video_ready', a token no writer has ever produced, for
-- every brokerage, forever. Five more all meant "finished", so a reader that
-- hard-coded one made the other four invisible; `distributed` was the worst,
-- because succeeding at distribution removed the video from its own gallery.
--
-- The vocabulary now lives in lib/video/video-status.ts and is enforced here.
-- Without the CHECK this converges once and drifts again the first time a
-- writer invents a spelling it never told a reader about.
--
-- BACKFILL: ai_video_projects held ZERO rows when this ran (verified against
-- the live database before writing this file), so the UPDATE below is a no-op
-- today. It is written anyway — it is what makes the constraint safe to add on
-- any environment that DOES hold rows, and it is the same map as
-- RETIRED_VIDEO_STATUS in lib/video/video-status.ts.

begin;

-- 1. Normalise any historic value to its canonical replacement.
update public.ai_video_projects set status = case status
  when 'pending'           then 'draft'
  when 'setup'             then 'draft'
  when 'planning'          then 'draft'
  when 'script_generating' then 'scripting'
  when 'remotion_pending'  then 'queued'
  when 'rendering'         then 'generating'
  when 'submitting'        then 'generating'
  when 'awaiting_provider' then 'generating'
  when 'audio_ready'       then 'generating'
  when 'ready'             then 'completed'
  when 'video_ready'       then 'completed'
  when 'uploaded'          then 'completed'
  when 'distributed'       then 'published'
  when 'error'             then 'failed'
  when 'cancelled'         then 'failed'
  else status
end
where status in (
  'pending','setup','planning','script_generating','remotion_pending',
  'rendering','submitting','awaiting_provider','audio_ready',
  'ready','video_ready','uploaded','distributed','error','cancelled'
);

-- 2. Anything still outside the vocabulary would fail the constraint below.
--    Fail LOUDLY here instead, naming the value — a migration that aborts with
--    "check constraint violated" sends the next reader hunting.
do $$
declare rogue text;
begin
  select string_agg(distinct status, ', ') into rogue
  from public.ai_video_projects
  where status is not null and status not in (
    'draft','scripting','script_ready','queued','generating',
    'awaiting_presenter_setup','completed','published','failed'
  );
  if rogue is not null then
    raise exception 'm374: ai_video_projects.status holds values outside the canonical vocabulary: %. Add them to the map above or to the vocabulary, do not widen the CHECK silently.', rogue;
  end if;
end $$;

-- 3. Enforce. Mirrors CANONICAL_VIDEO_STATUSES in lib/video/video-status.ts —
--    scripts/check-vocabularies.ts asserts the two stay in step.
alter table public.ai_video_projects
  drop constraint if exists ai_video_projects_status_check;

alter table public.ai_video_projects
  add constraint ai_video_projects_status_check
  check (status in (
    'draft','scripting','script_ready','queued','generating',
    'awaiting_presenter_setup','completed','published','failed'
  ));

comment on constraint ai_video_projects_status_check on public.ai_video_projects is
  'One video status vocabulary (m374). Source of truth: lib/video/video-status.ts CANONICAL_VIDEO_STATUSES. Before this the column was unconstrained and held 22 spellings; five were read by filters nothing wrote, and five meant "finished" so readers hard-coding one hid the rest.';

commit;
