-- Add widget-required columns idempotently
-- ai_identity_profiles: avatar_url, welcome_message
ALTER TABLE public.ai_identity_profiles
  ADD COLUMN IF NOT EXISTS avatar_url    text,
  ADD COLUMN IF NOT EXISTS welcome_message text;

-- brokerages: slug (unique), primary_color
ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS slug          text,
  ADD COLUMN IF NOT EXISTS primary_color text DEFAULT '#1d4ed8';

-- Create unique index on brokerages.slug (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'brokerages' AND indexname = 'brokerages_slug_unique'
  ) THEN
    CREATE UNIQUE INDEX brokerages_slug_unique ON public.brokerages (slug) WHERE slug IS NOT NULL;
  END IF;
END $$;
