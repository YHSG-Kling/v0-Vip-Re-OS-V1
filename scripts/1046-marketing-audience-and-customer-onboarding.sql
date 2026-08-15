-- ============================================================================
-- Migration 1046 — Sprint 9 + 10: Marketing audience targeting + measurement
--                                  + Customer onboarding journey
-- ============================================================================
--
-- Sprint 9 (Marketing planning + execution):
--   marketing_campaigns gains audience targeting (mirroring what Sprint 7 added
--   to learning_modules), measurement rollup columns, and channel-asset FK
--   columns so newsletter / podcast / video / direct mail / social / qr rows
--   all link back to their parent campaign.
--
-- Sprint 10 (Onboarding):
--   New customer_onboarding table — a per-contact welcome journey. Mirrors the
--   shape of agent_onboarding (status, current_step, completion_percentage,
--   start_date, completed_at). Customers don't go through agent_onboarding
--   today (that's for agent/tc/isa/team_lead only).
--
-- Composes with:
--   Sprint 4 brokerage_intelligence_insights (campaign performance lift signals)
--   Sprint 5 portal_event_stream (customer onboarding events flow to portal)
--   Sprint 6 agent_action_queue (campaigns scheduled to launch become items)
--   Sprint 7 learning_modules (audience_* fields mirror the same vocabulary)
-- ============================================================================

BEGIN;

-- 1. marketing_campaigns — audience targeting + measurement + journey state ─

ALTER TABLE marketing_campaigns
  -- Audience routing (same vocabulary Sprint 7 used on learning_modules)
  ADD COLUMN IF NOT EXISTS audience_personas         text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audience_generations      text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audience_age_segs         text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audience_lead_source_tags text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS audience_buyer_stages     text[]   NOT NULL DEFAULT '{}'::text[],
  -- Explicit contact list overrides the audience criteria (broker can pin a
  -- list directly). If NULL, audience criteria drive the resolved list.
  ADD COLUMN IF NOT EXISTS audience_contact_ids      uuid[],

  -- Measurement rollup — populated by campaign-measurer.ts
  ADD COLUMN IF NOT EXISTS audience_size_resolved    int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impressions               int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS engagements               int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversions               int      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_metrics_synced_at    timestamptz,

  -- Compliance gating state — set when publishMarketingCampaign runs
  ADD COLUMN IF NOT EXISTS compliance_status         text     NOT NULL DEFAULT 'pending'
       CHECK (compliance_status IN ('pending','passed','blocked','needs_review')),
  ADD COLUMN IF NOT EXISTS compliance_blocked_reason text;

CREATE INDEX IF NOT EXISTS idx_mc_brokerage_status_scheduled
  ON marketing_campaigns (brokerage_id, status, scheduled_start_at)
  WHERE scheduled_start_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mc_audience_personas ON marketing_campaigns USING gin(audience_personas);
CREATE INDEX IF NOT EXISTS idx_mc_audience_generations ON marketing_campaigns USING gin(audience_generations);
CREATE INDEX IF NOT EXISTS idx_mc_audience_age_segs ON marketing_campaigns USING gin(audience_age_segs);

-- 2. Channel-asset link columns — newsletter / podcast / direct_mail / social
-- already-exist FK: blog_posts.marketing_campaign_id. Adding the rest.

ALTER TABLE newsletter_campaigns
  ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_nl_marketing_campaign ON newsletter_campaigns(marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;

ALTER TABLE direct_mail_campaigns
  ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_dm_marketing_campaign ON direct_mail_campaigns(marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;

-- podcast_episodes already has marketing_campaign_id (per the live schema audit)
-- social_posts and qr_codes — link via FK when present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='social_posts') THEN
    BEGIN
      ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
    CREATE INDEX IF NOT EXISTS idx_sp_marketing_campaign ON social_posts(marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='qr_codes') THEN
    BEGIN
      ALTER TABLE qr_codes ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
    CREATE INDEX IF NOT EXISTS idx_qr_marketing_campaign ON qr_codes(marketing_campaign_id) WHERE marketing_campaign_id IS NOT NULL;
  END IF;
END$$;

-- 3. customer_onboarding — per-contact welcome / arrival journey ─────────────

CREATE TABLE IF NOT EXISTS customer_onboarding (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id               uuid        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,

  -- Persona / portal-view at journey start (so the welcome arc is tuned)
  contact_persona          text,                       -- buyer/seller/lifetime persona
  portal_view              text,                       -- match | deal | forever

  start_date               date        NOT NULL DEFAULT CURRENT_DATE,
  status                   text        NOT NULL DEFAULT 'in_progress'
                           CHECK (status IN ('in_progress','completed','abandoned')),

  -- Step state — the step_key vocabulary is open-ended so brokerages can
  -- author custom welcome flows. Default vocabulary documented in
  -- lib/kernel/customer-onboarding.ts:CUSTOMER_WELCOME_STEPS.
  current_step             text        NOT NULL DEFAULT 'welcome',
  completed_steps          text[]      NOT NULL DEFAULT '{}'::text[],
  completion_percentage    int         NOT NULL DEFAULT 0
                           CHECK (completion_percentage BETWEEN 0 AND 100),

  -- Surface state
  welcome_dismissed_at     timestamptz,
  last_nudge_sent_at       timestamptz,
  completed_at             timestamptz,

  metadata                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- One in_progress journey per contact
  UNIQUE (contact_id)
);

CREATE INDEX IF NOT EXISTS idx_co_brokerage_status
  ON customer_onboarding (brokerage_id, status, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_co_stalled
  ON customer_onboarding (brokerage_id, status, last_nudge_sent_at)
  WHERE status = 'in_progress';

ALTER TABLE customer_onboarding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS co_service_all ON customer_onboarding;
CREATE POLICY co_service_all ON customer_onboarding FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS co_self_select ON customer_onboarding;
CREATE POLICY co_self_select ON customer_onboarding FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS co_self_update ON customer_onboarding;
CREATE POLICY co_self_update ON customer_onboarding FOR UPDATE
  USING (contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS co_brokerage_select ON customer_onboarding;
CREATE POLICY co_brokerage_select ON customer_onboarding FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

COMMIT;
