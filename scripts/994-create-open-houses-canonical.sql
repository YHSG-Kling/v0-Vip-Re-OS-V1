-- Create canonical open_houses table per code references in open-house-automation.ts
-- Coexists with legacy open_house_events (different schema, kept for backwards compat).

CREATE TABLE IF NOT EXISTS public.open_houses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  property_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,

  title varchar(255),
  description text,
  property_address text,

  event_date date,
  start_time time,
  end_time time,
  timezone varchar(50) DEFAULT 'America/New_York',
  scheduled_at timestamptz,

  ai_recommended_time boolean DEFAULT false,
  optimal_timing_score numeric(3,2),
  attendance_prediction integer,
  weather_forecast jsonb,

  max_attendees integer DEFAULT 50,
  require_rsvp boolean DEFAULT false,
  allow_walkins boolean DEFAULT true,

  qr_code_url text,
  qr_code_data text,
  check_in_url text,

  status varchar(50) DEFAULT 'draft',
  is_published boolean DEFAULT false,
  published_at timestamptz,

  total_invitations_sent integer DEFAULT 0,
  total_rsvps integer DEFAULT 0,
  total_check_ins integer DEFAULT 0,
  total_leads_generated integer DEFAULT 0,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  cancelled_at timestamptz,
  cancellation_reason text
);

CREATE INDEX IF NOT EXISTS idx_open_houses_agent ON public.open_houses(agent_id);
CREATE INDEX IF NOT EXISTS idx_open_houses_listing ON public.open_houses(listing_id);
CREATE INDEX IF NOT EXISTS idx_open_houses_event_date ON public.open_houses(event_date);
CREATE INDEX IF NOT EXISTS idx_open_houses_status ON public.open_houses(status);

ALTER TABLE public.open_houses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages open_houses' AND tablename = 'open_houses'
  ) THEN
    CREATE POLICY "Service role manages open_houses"
      ON public.open_houses FOR ALL USING (true);
  END IF;
END$$;
