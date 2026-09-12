-- m569-the-status-default-was-a-spelling-the-check-refuses.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ai_video_projects.status DEFAULT 'planning' — a spelling the m374 CHECK
-- refuses.
--
-- m374 collapsed 22 status spellings into nine and added
-- ai_video_projects_status_check to refuse everything else. 'planning' retired
-- into 'draft' (lib/video/video-status.ts RETIRED_VIDEO_STATUS). But the COLUMN
-- DEFAULT was never touched: verified live 2026-08-27 on hrvaqgvukzxfskkcrwbt,
--
--   pg_attrdef:     status DEFAULT 'planning'::text
--   pg_constraint:  CHECK (status = ANY (ARRAY['draft','scripting',
--                   'script_ready','queued','generating',
--                   'awaiting_presenter_setup','completed','published','failed']))
--
-- so ANY insert that omits `status` is refused whole with 23514 — the default
-- is a landmine that converts "I didn't specify a status" into "no row at all".
-- It already detonated once: app/actions/listing-video.ts:generateListingVideo
-- hand-rolled its project insert without `status`, so the Launch Actions
-- "Generate Video" button failed on every press (that writer is now merged
-- onto commissionVideo — see the tombstones in that file). A stripped-source
-- sweep (2026-08-27) found no OTHER live insert that omits `status`; the three
-- spread-built inserts (lib/video/avatar-explainer.ts, lib/video/memory-video.ts,
-- app/api/internal/remotion/render-just-listed/route.ts) each set it — but the
-- default stays wrong for every FUTURE writer and every ad-hoc client.
--
-- The default becomes 'draft' — the canonical value 'planning' retired into.
-- No backfill: the CHECK has refused non-canonical values since m374, and the
-- table held zero rows when checked (a default the CHECK refuses cannot have
-- produced rows — every insert relying on it failed).

alter table public.ai_video_projects
  alter column status set default 'draft';

comment on column public.ai_video_projects.status is
  'Canonical video status (lib/video/video-status.ts; CHECK-enforced since m374). Default was ''planning'' — a retired spelling the CHECK refuses, so status-omitting inserts failed 23514. Fixed to ''draft'' in m569.';
