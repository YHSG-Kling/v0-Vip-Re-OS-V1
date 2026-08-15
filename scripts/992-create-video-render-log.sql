-- video_render_log: tracks each render attempt for cost / SLA / debug.
-- Inserted by /api/did/generate-video and the HeyGen flow on submit.
-- Updated by poll crons with render_duration_seconds when complete.

CREATE TABLE IF NOT EXISTS public.video_render_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.ai_video_projects(id) ON DELETE CASCADE,
  provider text NOT NULL,  -- 'did' | 'heygen'
  provider_job_id text,
  render_duration_seconds integer,
  cost_usd numeric(10,4),
  status text DEFAULT 'submitted',
  error_message text,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_render_log_project ON public.video_render_log(project_id);
CREATE INDEX IF NOT EXISTS idx_video_render_log_provider ON public.video_render_log(provider);

ALTER TABLE public.video_render_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages video_render_log' AND tablename = 'video_render_log'
  ) THEN
    CREATE POLICY "Service role manages video_render_log"
      ON public.video_render_log FOR ALL USING (true);
  END IF;
END$$;
