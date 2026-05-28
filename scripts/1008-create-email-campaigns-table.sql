-- ===========================================================================
-- 1008-create-email-campaigns-table.sql
-- email_campaigns — separate from newsletter_campaigns. Newsletters are
-- recurring publications with sections + subscriber audience; email campaigns
-- are one-off blasts, drip sequences, transactional sends, and segmented sends.
-- Both products use the same email send infrastructure underneath but stay
-- distinct as products/tables.
--
-- APPLIED VIA: supabase apply_migration "create_email_campaigns_table"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id                 uuid,
  created_by               uuid,
  campaign_name            text NOT NULL,
  subject_line             text NOT NULL,
  content                  text,
  preview_text             text,
  campaign_format          text NOT NULL DEFAULT 'one_off'
    CHECK (campaign_format IN ('one_off','drip','segmented','transactional','event_triggered')),
  audience_segment_id      uuid,
  audience_filter          jsonb,
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','sent','paused','cancelled','failed')),
  approval_status          text DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected')),
  brand_compliance_passed  boolean,
  send_date                timestamptz,
  sent_at                  timestamptz,
  recipient_count          int DEFAULT 0,
  delivered_count          int DEFAULT 0,
  open_rate                numeric DEFAULT 0,
  click_rate               numeric DEFAULT 0,
  unsubscribe_rate         numeric DEFAULT 0,
  bounce_rate              numeric DEFAULT 0,
  parent_campaign_id       uuid REFERENCES public.email_campaigns(id) ON DELETE SET NULL,
  template_id              uuid,
  kernel_event_id          uuid,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_brokerage_status ON public.email_campaigns(brokerage_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_agent ON public.email_campaigns(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_campaigns_format ON public.email_campaigns(brokerage_id, campaign_format, status);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_send_date ON public.email_campaigns(send_date) WHERE status = 'scheduled';

ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
