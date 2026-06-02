-- m120 — drop the deprecated video_projects table.
-- m118 (Wave 6) marked it deprecated; this wave migrated every caller to the
-- canonical ai_video_projects and confirmed zero rows + zero inbound foreign
-- keys on the live DB. Safe to drop.

drop table if exists public.video_projects;
