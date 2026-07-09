-- l39-s01 — HeyGen removed COMPLETELY (applied live 2026-07-09).
--
-- The last heygen-NAMED surface: five legacy columns on ai_video_projects
-- that carried D-ID ids under the old vendor's name, kept "synced for legacy
-- readers" that no longer existed. Canonical provider_* columns (three of
-- them new) backfilled from the legacy values, then the heygen columns
-- dropped. Every reader/writer swept to provider_* in the same commit
-- (video kernel, brand compliance, marketing bench, ISA outreach logger,
-- listing media, create-video-project, the video panel + dashboard). The
-- dead HeyGen cost-fallback module (zero callers, could nominate "heygen"
-- as a provider) deleted outright.

ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS provider_avatar_id text,
  ADD COLUMN IF NOT EXISTS provider_voice_id text,
  ADD COLUMN IF NOT EXISTS provider_template_id text;

UPDATE ai_video_projects SET
  provider_avatar_id  = COALESCE(provider_avatar_id, heygen_avatar_id),
  provider_voice_id   = COALESCE(provider_voice_id, heygen_voice_id),
  provider_template_id = COALESCE(provider_template_id, heygen_template_id),
  provider_job_id     = COALESCE(provider_job_id, heygen_video_id),
  provider_status     = COALESCE(provider_status, heygen_status)
WHERE heygen_avatar_id IS NOT NULL OR heygen_voice_id IS NOT NULL
   OR heygen_template_id IS NOT NULL OR heygen_video_id IS NOT NULL
   OR heygen_status IS NOT NULL;

ALTER TABLE ai_video_projects
  DROP COLUMN IF EXISTS heygen_avatar_id,
  DROP COLUMN IF EXISTS heygen_voice_id,
  DROP COLUMN IF EXISTS heygen_template_id,
  DROP COLUMN IF EXISTS heygen_video_id,
  DROP COLUMN IF EXISTS heygen_status;

-- Second pass (same day): the drift guard surfaced the stragglers —
--   isa_outreach_log.heygen_video_id  RENAMED → provider_job_id
--   training_videos.heygen_project_id RENAMED → provider_project_id
--   brokerage_settings.heygen_api_key DROPPED (a HeyGen API key slot!)
-- information_schema now reports ZERO heygen% columns anywhere.
ALTER TABLE isa_outreach_log RENAME COLUMN heygen_video_id TO provider_job_id;
ALTER TABLE training_videos RENAME COLUMN heygen_project_id TO provider_project_id;
ALTER TABLE brokerage_settings DROP COLUMN IF EXISTS heygen_api_key;
