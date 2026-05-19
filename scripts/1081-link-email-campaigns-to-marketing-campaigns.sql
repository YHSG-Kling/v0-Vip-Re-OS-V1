-- ===========================================================================
-- 1081-link-email-campaigns-to-marketing-campaigns.sql
--
-- email_campaigns mirrors newsletter_campaigns by also linking up to a
-- marketing_campaigns row. This lets a single marketing campaign coordinate
-- email + newsletter + social + video assets under one umbrella, and lets
-- handleVideoGenerated embed a completed video into every asset that shares
-- the same marketing_campaign_id.
--
-- APPLIED VIA: supabase apply_migration "link_email_campaigns_to_marketing_campaigns"
-- ===========================================================================

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_campaigns_marketing_campaign_id
  ON public.email_campaigns(marketing_campaign_id)
  WHERE marketing_campaign_id IS NOT NULL;
