-- ===========================================================================
-- 1005-predictive-listing-scores.sql
-- Predictive Listing Score (PLS) — daily-rolled-up score per contact predicting
-- probability of listing within next 6 months. Denormalized for fast dashboard
-- reads. Full per-signal audit lives in lead_score_history (already used by
-- applySignalDelta in lib/lead-intelligence/signal-extensions.ts).
--
-- predictive_listing_actions tracks auto-send + manual touches with explicit
-- review/approval/cancellation timestamps for compliance audit.
--
-- APPLIED VIA: supabase apply_migration "predictive_listing_scores_v3"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.predictive_listing_scores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id           uuid,
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  pls_score          numeric NOT NULL DEFAULT 0,
  confidence         numeric DEFAULT 0,
  signals_fired      int DEFAULT 0,
  contributing_motivation_total numeric DEFAULT 0,
  top_signals        jsonb,
  avm_value          numeric,
  avm_source         text,
  avm_confidence     numeric,
  avm_fetched_at     timestamptz,
  scored_at          timestamptz DEFAULT now(),
  scored_date        date GENERATED ALWAYS AS ((scored_at AT TIME ZONE 'UTC')::date) STORED,
  suppressed_until   timestamptz,
  suppression_reason text,
  suppressed_by_user_id uuid,
  last_action_at     timestamptz,
  last_action_type   text,
  UNIQUE (contact_id, brokerage_id)
);

CREATE INDEX IF NOT EXISTS idx_pls_agent_score ON public.predictive_listing_scores(agent_id, pls_score DESC);
CREATE INDEX IF NOT EXISTS idx_pls_brokerage_score ON public.predictive_listing_scores(brokerage_id, pls_score DESC);
CREATE INDEX IF NOT EXISTS idx_pls_scored_date ON public.predictive_listing_scores(scored_date DESC);
CREATE INDEX IF NOT EXISTS idx_pls_suppressed_until ON public.predictive_listing_scores(suppressed_until) WHERE suppressed_until IS NOT NULL;

ALTER TABLE public.predictive_listing_scores ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_pls_scored_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_pls_scoring_queue
  ON public.contacts(last_pls_scored_at NULLS FIRST, agent_id);

CREATE TABLE IF NOT EXISTS public.predictive_listing_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id           uuid,
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  action_type        text NOT NULL CHECK (action_type IN ('auto_touch','manual_touch','manual_consult','manual_nurture','manual_dismiss')),
  triggering_pls_score numeric,
  triggering_signals jsonb,
  channel            text CHECK (channel IS NULL OR channel IN ('email','sms','direct_mail')),
  message_subject    text,
  message_body       text,
  status             text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','queued','sent','cancelled','blocked','failed')),
  scheduled_send_at  timestamptz,
  reviewed_by_user_id uuid,
  reviewed_at        timestamptz,
  cancelled_by_user_id uuid,
  cancelled_at       timestamptz,
  cancel_reason      text,
  compliance_check_passed boolean,
  compliance_violations jsonb,
  sent_at            timestamptz,
  send_provider_message_id text,
  send_error         text,
  created_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pls_actions_due ON public.predictive_listing_actions(scheduled_send_at) WHERE status = 'pending_review';
CREATE INDEX IF NOT EXISTS idx_pls_actions_brokerage ON public.predictive_listing_actions(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pls_actions_contact ON public.predictive_listing_actions(contact_id, created_at DESC);

ALTER TABLE public.predictive_listing_actions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS predictive_auto_send_opt_out boolean DEFAULT false;
