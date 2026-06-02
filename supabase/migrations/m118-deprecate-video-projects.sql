-- m118 — deprecate the orphaned video_projects table.
-- The canonical kernel video table is ai_video_projects. The orphan was used
-- only by chapter-video-generator.ts and the listing-appointment-copilot read
-- path — both refactored in this wave to write/read ai_video_projects so the
-- poll-did-videos cron picks up chapter renders alongside the rest of the
-- platform's video pipeline.
--
-- The table is empty (0 rows at time of deprecation), so this is a marker.
-- A follow-up wave drops the table once nothing has touched it for a release.

comment on table public.video_projects is
  'DEPRECATED (m118, 2026-06). Use ai_video_projects. Field mapping: agent_user_id→agent_id, script→script_content, script_metadata→video_metadata, project_type→video_type, output_url→video_url, voice_id→heygen_voice_id (legacy column), avatar_id→heygen_avatar_id, provider→video_provider. The poll-did-videos cron consumes ai_video_projects only — chapter videos that landed here before this migration were orphaned from the brand-overlay + intro/outro compositing pipeline.';
