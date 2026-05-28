-- ===========================================================================
-- 1080-add-contact-id-to-ai-video-projects.sql
--
-- Personal videos (thank_you, buyer_guide, memory_video, custom) are addressed
-- to a specific contact. handleVideoGenerated needs this link to auto-draft
-- the outbound email + SMS to the recipient when the D-ID render completes.
--
-- APPLIED VIA: supabase apply_migration "add_contact_id_to_ai_video_projects"
-- ===========================================================================

ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_video_projects_contact_id
  ON public.ai_video_projects(contact_id)
  WHERE contact_id IS NOT NULL;
