-- ===========================================================================
-- 1004-neighbor-notification-campaigns.sql
-- Neighbor Notification Network — when a listing goes live, the agent (with
-- seller permission) sends a personalized direct mail to ~50 nearby high-
-- probability neighbors who are likely to know a buyer.
--
-- APPLIED VIA: supabase apply_migration "neighbor_notification_campaigns"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.neighbor_notification_campaigns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_user_id               uuid REFERENCES public.users(id),
  listing_id                  uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  seller_permission_granted   boolean DEFAULT false,
  seller_permission_granted_at timestamptz,
  seller_permission_granted_by uuid,
  direct_mail_campaign_id     uuid REFERENCES public.direct_mail_campaigns(id) ON DELETE SET NULL,
  max_neighbors               int DEFAULT 50,
  search_radius_meters        int DEFAULT 800,
  min_tenure_years            int DEFAULT 5,
  knows_buyer_score_threshold numeric DEFAULT 0.6,
  status                      text DEFAULT 'draft'
    CHECK (status IN ('draft','awaiting_seller_permission','approved','sending','sent','cancelled')),
  recipients_identified       int DEFAULT 0,
  recipients_sent             int DEFAULT 0,
  responses_received          int DEFAULT 0,
  created_at                  timestamptz DEFAULT now(),
  updated_at                  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_neighbor_notif_listing ON public.neighbor_notification_campaigns(listing_id);
CREATE INDEX IF NOT EXISTS idx_neighbor_notif_status ON public.neighbor_notification_campaigns(brokerage_id, status);

ALTER TABLE public.neighbor_notification_campaigns ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.neighbor_notification_recipients (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              uuid NOT NULL REFERENCES public.neighbor_notification_campaigns(id) ON DELETE CASCADE,
  brokerage_id             uuid REFERENCES public.brokerages(id),
  property_address         text NOT NULL,
  property_city            text,
  property_state           text,
  property_zip             text,
  owner_name               text,
  owner_tenure_years       numeric,
  owner_estimated_age      int,
  knows_buyer_score        numeric,
  proximity_meters         int,
  life_stage_match         text,
  scoring_signals          jsonb,
  direct_mail_recipient_id uuid REFERENCES public.direct_mail_recipients(id) ON DELETE SET NULL,
  status                   text DEFAULT 'identified'
    CHECK (status IN ('identified','queued','sent','delivered','responded','undeliverable','suppressed')),
  responded_at             timestamptz,
  response_type            text,
  created_at               timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_neighbor_notif_recipients_campaign ON public.neighbor_notification_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_neighbor_notif_recipients_status ON public.neighbor_notification_recipients(brokerage_id, status);

ALTER TABLE public.neighbor_notification_recipients ENABLE ROW LEVEL SECURITY;
