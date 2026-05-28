-- ============================================================================
-- Migration 1026 — Workflow OS Sprint A
-- Universal channel registry schema foundation.
--
-- Extends campaign_sequence_steps with columns for all 20+ channels:
--   ai_image, video (D-ID), voice_drop (Vapi), newsletter, social_post,
--   assign_task (any staff type), draft_document, schedule_showing,
--   schedule_tour, ad_campaign, listing_landing_page, avm_cma,
--   plus QR-attachment modifier usable on any channel.
--
-- Adds step_outputs jsonb to sequence_enrollments for variable graph.
-- Adds workflow_step_runs table for per-step audit + revenue attribution.
-- Expands channel CHECK constraint to cover all new channel keys.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Drop + recreate channel CHECK on campaign_sequence_steps
--    (safer than ALTER TABLE DROP CONSTRAINT since name is unpredictable)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT constraint_name INTO con_name
  FROM information_schema.table_constraints
  WHERE table_name = 'campaign_sequence_steps'
    AND constraint_type = 'CHECK'
    AND constraint_name LIKE '%channel%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE campaign_sequence_steps DROP CONSTRAINT %I', con_name);
  END IF;
END$$;

ALTER TABLE campaign_sequence_steps
  ADD CONSTRAINT campaign_sequence_steps_channel_check CHECK (channel IN (
    -- ── existing ────────────────────────────────────────────────────
    'email',
    'sms',
    'voice_drop',
    'wait',
    'condition',
    'ai_call',
    'direct_mail',
    'video',
    'in_app',
    'assign_task',
    'add_to_segment',
    'remove_from_campaign',
    -- ── Sprint A new ─────────────────────────────────────────────────
    'ai_image',           -- generate image via gpt-image-1 / Vercel Gateway Flex
    'social_post',        -- push to Instagram / TikTok / YouTube Shorts / LinkedIn / etc.
    'newsletter',         -- compose + send newsletter campaign
    'ad_campaign',        -- launch Facebook / Google / YouTube ad
    'listing_landing_page', -- generate or update a listing micro-site
    'avm_cma',            -- generate AVM or CMA document (Perplexity or HouseCanary)
    'draft_document',     -- draft offer, listing agreement, invoice (state-specific forms)
    'schedule_showing',   -- schedule a property showing
    'schedule_tour'       -- schedule a multi-stop buyer tour
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Extend campaign_sequence_steps with new channel-specific columns
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Variable graph ───────────────────────────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS output_variable_name  text,        -- name in {{step_N.*}} graph
  ADD COLUMN IF NOT EXISTS step_outputs_schema   jsonb;       -- declares what this step produces

-- ── QR attachment modifier (any channel) ─────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS qr_attached           boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qr_target_url_pattern text,        -- may contain {{variables}}
  ADD COLUMN IF NOT EXISTS qr_label              text;

-- ── AI Image (channel = 'ai_image') ─────────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS image_prompt          text,
  ADD COLUMN IF NOT EXISTS image_style           text,        -- 'vivid' | 'natural' | null
  ADD COLUMN IF NOT EXISTS image_aspect_ratio    text         -- '1:1' | '16:9' | '4:3' | '9:16'
    DEFAULT '1:1';

-- ── Video (channel = 'video') ────────────────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS video_script          text,
  ADD COLUMN IF NOT EXISTS video_voice_only      boolean  NOT NULL DEFAULT false,  -- no avatar
  ADD COLUMN IF NOT EXISTS video_avatar_enabled  boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS video_background_url  text,        -- optional background image/video
  ADD COLUMN IF NOT EXISTS video_broll_urls      text[],      -- array of B-roll clip URLs
  ADD COLUMN IF NOT EXISTS video_intro_url       text,        -- separate intro clip
  ADD COLUMN IF NOT EXISTS video_outro_url       text,        -- separate outro clip
  ADD COLUMN IF NOT EXISTS video_logo_url        text;        -- logo/watermark overlay

-- ── Voice Drop (channel = 'voice_drop') via Vapi ─────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS voice_drop_script     text,
  ADD COLUMN IF NOT EXISTS voice_drop_voice_id   text;        -- ElevenLabs voice_id or Vapi voice

-- ── Newsletter (channel = 'newsletter') ─────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS newsletter_template_id  uuid,
  ADD COLUMN IF NOT EXISTS newsletter_section_ids  text[];     -- ordered section keys to include

-- ── Social Post (channel = 'social_post') ────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS social_platform       text,        -- 'instagram' | 'tiktok' | 'youtube_shorts' | 'facebook' | 'linkedin' | 'twitter' | 'nextdoor'
  ADD COLUMN IF NOT EXISTS social_caption_prompt text,
  ADD COLUMN IF NOT EXISTS social_image_source   text;        -- 'step_output' | 'media_library' | 'ai_generate' | 'listing_photo'

-- ── Assign Task (channel = 'assign_task') ────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS task_assignee_type    text,        -- 'agent' | 'staff' | 'tc' | 'lender' | 'vendor' | 'compliance_officer' | 'any_brokerage_member'
  ADD COLUMN IF NOT EXISTS task_assignee_id      uuid,        -- specific person; null = role-based
  ADD COLUMN IF NOT EXISTS task_title            text,
  ADD COLUMN IF NOT EXISTS task_due_offset_days  integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS task_notes_prompt     text;        -- AI-drafted task notes prompt

-- ── Draft Document (channel = 'draft_document') ──────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS document_template_id  uuid,
  ADD COLUMN IF NOT EXISTS document_type         text,        -- 'offer' | 'listing_agreement' | 'invoice' | 'market_report' | 'avm_cma' | 'custom'
  ADD COLUMN IF NOT EXISTS document_state        text;        -- US state code for state-specific forms

-- ── Schedule Showing (channel = 'schedule_showing') ──────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS showing_property_id       uuid,
  ADD COLUMN IF NOT EXISTS showing_duration_minutes  integer  NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS showing_notes             text;

-- ── Schedule Tour (channel = 'schedule_tour') ────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS tour_property_ids     uuid[],      -- ordered list of stops
  ADD COLUMN IF NOT EXISTS tour_date_offset_days integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tour_start_address    text;        -- starting point

-- ── Ad Campaign (channel = 'ad_campaign') ────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS ad_platform           text,        -- 'facebook' | 'google' | 'youtube'
  ADD COLUMN IF NOT EXISTS ad_objective          text,        -- 'awareness' | 'leads' | 'traffic'
  ADD COLUMN IF NOT EXISTS ad_budget_cents       integer,
  ADD COLUMN IF NOT EXISTS ad_audience_prompt    text;        -- describes target audience in NL

-- ── Listing Landing Page (channel = 'listing_landing_page') ──────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS listing_page_template_id  uuid,
  ADD COLUMN IF NOT EXISTS listing_page_slug         text;    -- may contain {{variables}}

-- ── AVM / CMA (channel = 'avm_cma') ──────────────────────────────────────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS avm_data_source        text        -- 'perplexity' | 'housecannary' | 'batchdata'
    DEFAULT 'perplexity',
  ADD COLUMN IF NOT EXISTS avm_include_investor_adj boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS avm_report_type        text        -- 'avm' | 'cma' | 'market_report'
    DEFAULT 'avm';

-- ── Direct Mail piece type (extends existing channel = 'direct_mail') ────────
ALTER TABLE campaign_sequence_steps
  ADD COLUMN IF NOT EXISTS direct_mail_piece_type text        -- 'postcard' | 'letter' | 'handwritten_letter' | 'thank_you_note'
    DEFAULT 'postcard';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add step_outputs jsonb to sequence_enrollments
--    Stores the variable graph: { "step_1": { "image_url": "...", ... }, ... }
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS step_outputs jsonb NOT NULL DEFAULT '{}';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. workflow_step_runs — granular per-step execution audit + revenue attribution
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id         uuid        NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
  step_id               uuid        NOT NULL REFERENCES campaign_sequence_steps(id) ON DELETE CASCADE,
  channel               text        NOT NULL,
  status                text        NOT NULL
    CHECK (status IN ('running','sent','skipped','blocked','failed','completed')),
  output_variable_name  text,
  step_output           jsonb,                  -- what this step produced (written to enrollment.step_outputs)
  provider_key          text,
  provider_message_id   text,
  blocked_reason        text,
  -- Revenue attribution
  converted_at          timestamptz,
  conversion_value_cents integer,
  attribution_source    text,                   -- 'first_touch' | 'last_touch' | 'linear'
  -- Timing
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  duration_ms           integer,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_enrollment
  ON workflow_step_runs(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_status
  ON workflow_step_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_channel
  ON workflow_step_runs(channel, created_at);

ALTER TABLE workflow_step_runs ENABLE ROW LEVEL SECURITY;

-- Service role gets full access; no per-user RLS needed (internal cron only)
CREATE POLICY IF NOT EXISTS "service_role_workflow_step_runs"
  ON workflow_step_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Extend campaign_sequences.trigger_event — add informational comment
--    (column is plain text; no CHECK constraint so new triggers never break)
-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical trigger_event vocabulary (for reference — not a DB enum):
--   Contact lifecycle: contact.created, contact.stage_changed, contact.opted_in,
--                      contact.qualified, contact.promoted_to_lifetime
--   Lead: lead.created, lead.scored_above_threshold, lead.touched, lead.max_touches
--   Listing: listing.created, listing.stage_changed, listing.price_reduced,
--             listing.days_on_market_threshold, listing.offer_received,
--             listing.under_contract, listing.closed
--   Buyer: buyer.financially_verified, buyer.tour_scheduled, buyer.offer_submitted,
--          buyer.offer_accepted, buyer.closed
--   Transaction: transaction.inspection_complete, transaction.appraisal_complete,
--                transaction.clear_to_close, transaction.closed
--   Time: time.anniversary, time.birthday, time.n_days_since_last_touch
--   Behavioral: behavior.email_opened, behavior.link_clicked, behavior.portal_visited,
--               behavior.property_saved, behavior.qr_scanned
--   Manual: manual.enrolled_by_agent
COMMENT ON COLUMN campaign_sequences.trigger_event IS
  'Kernel event string that auto-enrolls contacts. See migration 1026 for full vocabulary.';

COMMIT;
