-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-11 by the integrator (measured first:
-- remotion_composition_renders.retry_count absent). Schema snapshot regenerated after.
-- m622 — wave 57 realism/autonomy audit: retry_count for the autonomous
-- failed-render requeue loop.
--
-- app/api/cron/composition-render-queue/route.ts previously drained ONLY
-- 'queued' rows; a 'failed' render sat until a human clicked
-- restart_failed_render in the Asset Manager dashboard
-- (app/dashboard/admin/asset-manager-actions/client.tsx). Owner ruling: "this
-- OS runs autonomous loops... rather than waiting for a button." The cron now
-- also re-queues a bounded number of 'failed' rows on its own
-- (lib/remotion/render-decision.ts shouldAutoRequeueFailedRender,
-- MAX_AUTO_REQUEUE_ATTEMPTS=2) — this column is what bounds it: without a
-- persisted attempt count a permanently-broken composition would be
-- re-queued forever.
--
-- ai_video_projects already has this exact column (m-prior, unnamed here
-- since it predates this migration numbering) for the identical "bounded
-- autonomous retry" shape in app/api/cron/poll-did-videos — same idea, same
-- column name, applied to the sibling table this wave's audit found lacking
-- it (§6 — one vocabulary for "how many times has this been retried").

alter table public.remotion_composition_renders
  add column if not exists retry_count integer not null default 0;

comment on column public.remotion_composition_renders.retry_count is
  'm622 (wave 57): how many times the autonomous composition-render-queue cron has re-queued this row after a failure. Bounded by MAX_AUTO_REQUEUE_ATTEMPTS (lib/remotion/render-decision.ts) — once spent the row is left failed for a human/the weekly Asset Manager digest. Mirrors ai_video_projects.retry_count''s identical shape.';
