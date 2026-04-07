-- home_value_page_configs
-- Stores per-agent customization for their public home value page.
-- Agents control the headline, subheadline, qualification questions shown,
-- working hours (any day + any hour), and branding overrides.

CREATE TABLE IF NOT EXISTS public.home_value_page_configs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id        uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,

  -- Page branding
  headline            text NOT NULL DEFAULT 'What''s Your Home Worth?',
  subheadline         text NOT NULL DEFAULT 'Get a free AI-powered estimate in minutes — no obligation.',
  cta_button_text     text NOT NULL DEFAULT 'Get My Free Estimate',
  primary_color       text NOT NULL DEFAULT '#6366f1',
  agent_bio_override  text,

  -- Qualification questions — true = show on the form
  show_q_sell_timeline    boolean NOT NULL DEFAULT true,
  show_q_motivation       boolean NOT NULL DEFAULT true,
  show_q_mortgage_status  boolean NOT NULL DEFAULT true,
  show_q_price_expectation boolean NOT NULL DEFAULT true,
  show_q_has_agent        boolean NOT NULL DEFAULT true,
  show_q_buy_after_sell   boolean NOT NULL DEFAULT true,
  show_q_additional_notes boolean NOT NULL DEFAULT true,

  -- Custom question labels (null = use default)
  label_sell_timeline     text,
  label_motivation        text,
  label_mortgage_status   text,
  label_price_expectation text,
  label_has_agent         text,
  label_buy_after_sell    text,

  -- Appointment scheduling hours
  -- Format: array of { day: 0-6 (Sun=0), start_hour: 0-23, end_hour: 0-23 }
  -- e.g. [{ "day": 1, "start_hour": 9, "end_hour": 20 }, ...]
  working_hours       jsonb NOT NULL DEFAULT '[
    {"day":1,"start_hour":9,"end_hour":17},
    {"day":2,"start_hour":9,"end_hour":17},
    {"day":3,"start_hour":9,"end_hour":17},
    {"day":4,"start_hour":9,"end_hour":17},
    {"day":5,"start_hour":9,"end_hour":17}
  ]'::jsonb,

  -- Whether the scheduling widget is shown on the result page
  show_scheduler      boolean NOT NULL DEFAULT true,

  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (agent_id)
);

ALTER TABLE public.home_value_page_configs ENABLE ROW LEVEL SECURITY;

-- Agents manage their own config; brokers/admins can see all
CREATE POLICY hv_config_agent ON public.home_value_page_configs
  FOR ALL USING (
    agent_id IN (
      SELECT id FROM public.agents WHERE user_id = auth.uid()
    )
  );
