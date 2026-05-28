-- ============================================================================
-- Migration 1050 — Marketing kernel: touchpoints + back-attribution + triggers
-- ============================================================================
--
-- Three new pieces close the marketing kernel's biggest gaps:
--
-- 1. marketing_campaign_touchpoints — UNIFIED per-(campaign, contact, channel)
--    send record. email_campaign_sends already covers email; this generalizes
--    across all channels (email / sms / direct_mail / social / qr_scan / blog
--    / podcast / newsletter). Drives multi-channel attribution.
--
-- 2. marketing_attribution_credits — when a transaction closes (or moves to
--    under_contract), back-attribute GCI to the campaigns whose touchpoints
--    touched the contact in the lookback window. Models:
--      first_touch  → 100% to earliest campaign
--      last_touch   → 100% to latest campaign
--      linear       → equal split across all touching campaigns
--      time_decay   → exponential decay weight from contract date backward
--    The cron writes one row per (campaign × transaction) pair with the
--    credit dollars assigned per model. Read these for per-campaign ROI.
--
-- 3. marketing_campaign_triggers — links lifecycle event types to campaigns.
--    When a matching event fires (e.g., buyer_stage=BUYER_TOUR_ELIGIBLE),
--    the trigger cron auto-creates a touchpoint enrolling the contact into
--    that campaign on the channel specified.
-- ============================================================================

BEGIN;

-- 1. Touchpoints — per-channel send record ──────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_campaign_touchpoints (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  campaign_id         uuid        NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  contact_id          uuid        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  channel             text        NOT NULL CHECK (channel IN (
                                    'email','sms','direct_mail','social','qr_scan',
                                    'blog','podcast','newsletter','phone','portal'
                                  )),

  -- Optional child-asset reference (e.g. newsletter_campaigns.id, blog_posts.id)
  external_table      text,
  external_id         uuid,

  -- Lifecycle of this individual touchpoint
  status              text        NOT NULL DEFAULT 'sent'
                      CHECK (status IN ('queued','sent','delivered','opened','clicked','converted','bounced','failed')),

  sent_at             timestamptz NOT NULL DEFAULT now(),
  opened_at           timestamptz,
  clicked_at          timestamptz,
  converted_at        timestamptz,

  -- How was this enrolment created (manual / trigger / launch)
  source              text        NOT NULL DEFAULT 'launch'
                      CHECK (source IN ('launch','trigger','manual','retarget')),

  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mct_campaign     ON marketing_campaign_touchpoints(campaign_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mct_contact      ON marketing_campaign_touchpoints(contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mct_brokerage    ON marketing_campaign_touchpoints(brokerage_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mct_channel      ON marketing_campaign_touchpoints(brokerage_id, channel, status);

ALTER TABLE marketing_campaign_touchpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mct_service_all ON marketing_campaign_touchpoints;
CREATE POLICY mct_service_all ON marketing_campaign_touchpoints FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mct_tenant_select ON marketing_campaign_touchpoints;
CREATE POLICY mct_tenant_select ON marketing_campaign_touchpoints FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- 2. Attribution credits ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_attribution_credits (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  campaign_id         uuid        NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  transaction_id      uuid        NOT NULL REFERENCES transactions(id)        ON DELETE CASCADE,
  contact_id          uuid        REFERENCES contacts(id) ON DELETE SET NULL,

  -- Attribution model that produced this credit
  attribution_model   text        NOT NULL CHECK (attribution_model IN ('first_touch','last_touch','linear','time_decay')),
  -- Weight 0..1 from the model
  attribution_weight  numeric     NOT NULL CHECK (attribution_weight BETWEEN 0 AND 1),
  -- $ credit (transaction_gci * weight)
  credit_dollars      numeric     NOT NULL DEFAULT 0,

  -- Earliest + latest touchpoint that fed this credit
  first_touchpoint_at timestamptz,
  last_touchpoint_at  timestamptz,
  touchpoint_count    int         NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  computed_by_run_id  uuid,

  -- Idempotency: one credit per (campaign, transaction, model)
  UNIQUE (campaign_id, transaction_id, attribution_model)
);

CREATE INDEX IF NOT EXISTS idx_mac_brokerage ON marketing_attribution_credits(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mac_campaign  ON marketing_attribution_credits(campaign_id, attribution_model);
CREATE INDEX IF NOT EXISTS idx_mac_txn       ON marketing_attribution_credits(transaction_id);

ALTER TABLE marketing_attribution_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mac_service_all ON marketing_attribution_credits;
CREATE POLICY mac_service_all ON marketing_attribution_credits FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mac_tenant_select ON marketing_attribution_credits;
CREATE POLICY mac_tenant_select ON marketing_attribution_credits FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- 3. Campaign triggers ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_campaign_triggers (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  campaign_id         uuid        NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,

  -- Trigger source:
  -- event_type='lifecycle_event' → fires when matching lifecycle_event lands
  --                                (event_filter: { event_type: 'offer.accepted' })
  -- event_type='buyer_stage'     → fires when contacts.buyer_stage = stage_value
  -- event_type='milestone'       → fires when transaction_milestone reaches state
  trigger_type        text        NOT NULL CHECK (trigger_type IN (
                                    'lifecycle_event','buyer_stage','milestone','sphere_anniversary'
                                  )),
  trigger_value       text        NOT NULL,             -- e.g. 'offer.accepted' / 'BUYER_TOUR_ELIGIBLE'
  channel             text        NOT NULL DEFAULT 'email',

  -- Optional audience filter (intersected with the campaign's own audience criteria)
  audience_filter     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  is_active           boolean     NOT NULL DEFAULT true,
  cooldown_days       int         NOT NULL DEFAULT 30,   -- don't re-enroll same contact within N days

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, trigger_type, trigger_value)
);

CREATE INDEX IF NOT EXISTS idx_mctr_brokerage    ON marketing_campaign_triggers(brokerage_id, is_active);
CREATE INDEX IF NOT EXISTS idx_mctr_trigger_kind ON marketing_campaign_triggers(trigger_type, trigger_value, is_active)
  WHERE is_active = true;

ALTER TABLE marketing_campaign_triggers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mctr_service_all ON marketing_campaign_triggers;
CREATE POLICY mctr_service_all ON marketing_campaign_triggers FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mctr_tenant_select ON marketing_campaign_triggers;
CREATE POLICY mctr_tenant_select ON marketing_campaign_triggers FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());
DROP POLICY IF EXISTS mctr_admin_write ON marketing_campaign_triggers;
CREATE POLICY mctr_admin_write ON marketing_campaign_triggers FOR ALL
  USING (brokerage_id = current_user_brokerage_id()
         AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'))
  WITH CHECK (brokerage_id = current_user_brokerage_id()
              AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'));

-- 4. AI marketing content approval signal ───────────────────────────────────
-- The existing approval_status column on newsletter_campaigns / direct_mail
-- already supports 'pending' / 'approved' etc. We add an is_ai_generated
-- boolean to newsletter / blog / podcast / direct_mail so the unified
-- admin queue knows which need brand-voice review vs. which were
-- human-authored. Idempotent ADD COLUMN IF NOT EXISTS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='newsletter_campaigns') THEN
    BEGIN
      ALTER TABLE newsletter_campaigns ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='direct_mail_campaigns') THEN
    BEGIN
      ALTER TABLE direct_mail_campaigns ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false;
      ALTER TABLE direct_mail_campaigns ADD COLUMN IF NOT EXISTS approval_status  text;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='podcast_episodes') THEN
    BEGIN
      ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false;
      ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS approval_status  text;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='blog_posts') THEN
    BEGIN
      ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false;
      ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS approval_status  text;
    EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
END$$;

-- 5. Rolled-up attribution view on marketing_campaigns (read-side convenience)
ALTER TABLE marketing_campaigns
  ADD COLUMN IF NOT EXISTS attributed_gci_total numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attribution_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mc_attribution_synced
  ON marketing_campaigns(brokerage_id, attribution_synced_at DESC NULLS LAST);

COMMIT;
