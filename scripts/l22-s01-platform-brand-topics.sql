-- l22-s01-platform-brand-topics.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM BRAND KIT + TOPIC POOL. The app's name is still being decided → it
-- lives in platform_settings.product_brand (name/tagline/colors/ctaUrl), resolved
-- by every self-marketing surface. platform_content_topics feeds reels/posts with
-- watched topics (competitor buzz / trends / manual), human-curated. Idempotent.

ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS product_brand jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS public.platform_content_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'manual' CHECK (source = ANY (ARRAY['manual','competitor','trend']::text[])),
  topic text NOT NULL,
  competitor text,
  url text,
  note text,
  status text NOT NULL DEFAULT 'new' CHECK (status = ANY (ARRAY['new','used','dismissed']::text[])),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
