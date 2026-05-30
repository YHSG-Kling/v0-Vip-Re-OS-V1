-- m098 — Recruiting sourcing stage (platform-owned).
--
-- Raw recruiting prospects (agents/teams looking to switch brokerages), scraped
-- from social/forum + job-board/review sources. Mirrors raw_scraped_leads:
-- brokerage_id stays NULL until the record passes the recruit promotion gate,
-- at which point the owning brokerage is resolved from the active-subscriber
-- territory (market_id) and a row is promoted into the brokerage-owned
-- `recruits` table. RLS restricts raw access to platform_admin + ai_isa_system
-- (brokerages never see raw recruiting prospects) — identical to raw_scraped_leads.
CREATE TABLE IF NOT EXISTS public.raw_recruit_prospects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  market_id            uuid REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  source               text NOT NULL,
  source_record_id     text,
  raw_data             jsonb NOT NULL,
  normalized_preview   jsonb,
  processing_status    text DEFAULT 'pending',
  recruit_id           uuid REFERENCES public.recruits(id) ON DELETE SET NULL,
  scraper_execution_id uuid,
  created_at           timestamptz DEFAULT now(),
  processed_at         timestamptz,
  UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_recruit_prospects_status ON public.raw_recruit_prospects (processing_status);
CREATE INDEX IF NOT EXISTS idx_raw_recruit_prospects_market ON public.raw_recruit_prospects (market_id);

ALTER TABLE public.raw_recruit_prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY raw_recruit_prospects_select ON public.raw_recruit_prospects
  FOR SELECT USING (
    is_platform_admin() OR (is_ai_isa_system() AND (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))
  );
CREATE POLICY raw_recruit_prospects_insert ON public.raw_recruit_prospects
  FOR INSERT WITH CHECK (
    is_platform_admin() OR (is_ai_isa_system() AND (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))
  );
CREATE POLICY raw_recruit_prospects_update ON public.raw_recruit_prospects
  FOR UPDATE USING (
    is_platform_admin() OR (is_ai_isa_system() AND (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))
  ) WITH CHECK (
    is_platform_admin() OR (is_ai_isa_system() AND (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()))
  );
CREATE POLICY raw_recruit_prospects_delete ON public.raw_recruit_prospects
  FOR DELETE USING (is_platform_admin());
