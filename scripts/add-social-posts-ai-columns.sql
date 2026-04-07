-- Add beneficial columns to social_posts that the AI composer and spec require.
-- ai_generated: tracks whether content was written by AI (compliance & analytics)
-- post_brief: stores the original user prompt or brief (audit trail)

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS ai_generated  boolean          DEFAULT false,
  ADD COLUMN IF NOT EXISTS post_brief    text             DEFAULT NULL;

-- Index for filtering AI-generated posts in analytics
CREATE INDEX IF NOT EXISTS social_posts_ai_generated_idx
  ON public.social_posts (brokerage_id, ai_generated)
  WHERE ai_generated = true;
