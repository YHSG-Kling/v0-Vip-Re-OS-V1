-- The repurpose_pipelines.source_type CHECK only allowed
-- {video,script,podcast,blog,newsletter}, but the application's SourceType union
-- uses {video_project,blog_post,podcast_episode,social_post,script,newsletter}.
-- So pipeline creation failed for the app's own values. Extend the CHECK to the
-- full set the code uses and add 'video_url' (paste-a-URL omnipresence flow).
ALTER TABLE public.repurpose_pipelines DROP CONSTRAINT IF EXISTS repurpose_pipelines_source_type_check;
ALTER TABLE public.repurpose_pipelines ADD CONSTRAINT repurpose_pipelines_source_type_check
  CHECK (source_type = ANY (ARRAY[
    'video','script','podcast','blog','newsletter',
    'video_project','blog_post','podcast_episode','social_post','video_url'
  ]));
