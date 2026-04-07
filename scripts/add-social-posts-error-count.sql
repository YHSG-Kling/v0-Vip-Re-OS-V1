-- Migration: add error_count to social_posts for retry circuit-breaker tracking
-- Run once; idempotent via IF NOT EXISTS / DO blocks.

DO $$
BEGIN
  -- Add error_count column (default 0) to track how many times a post has been retried
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'social_posts'
      AND column_name  = 'error_count'
  ) THEN
    ALTER TABLE public.social_posts
      ADD COLUMN error_count integer NOT NULL DEFAULT 0;

    COMMENT ON COLUMN public.social_posts.error_count IS
      'Number of failed publish attempts. Used for circuit-breaker / retry limiting.';
  END IF;

  -- Ensure social_publish_log has a campaign_id column (used by some insert paths)
  -- Add only if missing — the table already has social_post_id, brokerage_id, etc.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'social_publish_log'
      AND column_name  = 'campaign_id'
  ) THEN
    ALTER TABLE public.social_publish_log
      ADD COLUMN campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL;
  END IF;
END;
$$;
