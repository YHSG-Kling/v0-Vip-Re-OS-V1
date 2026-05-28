-- ===========================================================================
-- 1003-keyword-intelligence-and-competitor-monitoring.sql
-- Data feeds for marketing rules 4 (keywords from SEO/social) and rule 6
-- (competitor monitoring). Populated by background scrapers (Google Trends,
-- Facebook Ad Library, etc.) and consumed by content creation surfaces.
--
-- APPLIED VIA: supabase apply_migration "keyword_intelligence_and_competitor_monitoring"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.keyword_intelligence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  zip_code        text,
  city            text,
  state           text,
  keyword         text NOT NULL,
  search_volume_monthly int,
  competition_score numeric,
  trend_direction text CHECK (trend_direction IN ('rising','steady','declining')),
  trend_change_pct numeric,
  source          text NOT NULL,
  related_keywords text[],
  intent_category text,
  captured_at     timestamptz DEFAULT now(),
  expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_keyword_intel_brokerage_keyword ON public.keyword_intelligence(brokerage_id, keyword);
CREATE INDEX IF NOT EXISTS idx_keyword_intel_zip_keyword ON public.keyword_intelligence(zip_code, keyword) WHERE zip_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_keyword_intel_trend ON public.keyword_intelligence(trend_direction, trend_change_pct DESC) WHERE trend_direction = 'rising';

ALTER TABLE public.keyword_intelligence ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.competitor_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  competitor_name text NOT NULL,
  competitor_type text DEFAULT 'agent' CHECK (competitor_type IN ('agent','brokerage','team','franchise')),
  market_zip_codes text[],
  social_profiles jsonb,
  website_url     text,
  is_active       boolean DEFAULT true,
  notes           text,
  added_by_user_id uuid,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_profiles_brokerage ON public.competitor_profiles(brokerage_id, is_active);

ALTER TABLE public.competitor_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.competitor_content (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id     uuid REFERENCES public.competitor_profiles(id) ON DELETE CASCADE,
  brokerage_id      uuid REFERENCES public.brokerages(id),
  platform          text NOT NULL,
  content_type      text NOT NULL,
  content_url       text,
  caption           text,
  media_url         text,
  posted_at         timestamptz,
  observed_at       timestamptz DEFAULT now(),
  likes_count       int,
  comments_count    int,
  shares_count      int,
  views_count       int,
  engagement_rate   numeric,
  is_high_performing boolean DEFAULT false,
  detected_topics   text[],
  detected_keywords text[],
  emotional_tone    text,
  hook_type         text,
  cta_present       boolean DEFAULT false,
  raw_engagement_data jsonb
);

CREATE INDEX IF NOT EXISTS idx_competitor_content_brokerage_observed ON public.competitor_content(brokerage_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_content_high_performing ON public.competitor_content(brokerage_id, observed_at DESC) WHERE is_high_performing = true;
CREATE INDEX IF NOT EXISTS idx_competitor_content_competitor ON public.competitor_content(competitor_id, posted_at DESC);

ALTER TABLE public.competitor_content ENABLE ROW LEVEL SECURITY;
