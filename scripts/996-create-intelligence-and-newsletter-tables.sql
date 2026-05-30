-- Plan Gap 1.2 / 1.3: Lead Intelligence + Social Intelligence on the contact view.
-- lead-intelligence.ts queries these tables — without them the "Intelligence" tab
-- in CRM and the lead-intelligence dashboard render zero state.

CREATE TABLE IF NOT EXISTS public.unified_lead_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  lead_id uuid,
  brokerage_id uuid REFERENCES public.brokerages(id),
  intent_type text,
  intent_confidence numeric(3,2),
  timeline_urgency text,
  motivation_signals jsonb,
  enrichment_sources text[],
  last_analyzed_at timestamptz DEFAULT now(),
  ai_summary text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unified_lead_profile_contact ON public.unified_lead_profile(contact_id);
CREATE INDEX IF NOT EXISTS idx_unified_lead_profile_intent ON public.unified_lead_profile(intent_type);

CREATE TABLE IF NOT EXISTS public.social_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  platform text,
  signal_type text,
  signal_data jsonb,
  detected_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_intelligence_contact ON public.social_intelligence(contact_id);

CREATE TABLE IF NOT EXISTS public.behavioral_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  signal_value text,
  weight numeric(3,2),
  detected_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.external_behavior (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  source text,
  event_type text,
  event_data jsonb,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.intelligence_signals_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  source text,
  signal_type text,
  payload jsonb,
  ingested_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.intelligent_outreach_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  outreach_type text,
  channel text,
  content text,
  result text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lead_osint_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  source text,
  data jsonb,
  enriched_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lead_property_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  search_criteria jsonb,
  search_type text,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.idx_property_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  mls_number text,
  property_id uuid,
  interaction_type text,
  view_duration_seconds integer,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.motivated_seller_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  signal_strength text,
  signal_data jsonb,
  detected_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.google_search_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  query text,
  detected_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.google_search_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  intent_summary text,
  high_value_keywords text[],
  intent_score numeric(3,2),
  analyzed_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nextdoor_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  activity_type text,
  content text,
  detected_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.property_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  property_address text,
  data_source text,
  data jsonb,
  enriched_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.site_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  page_url text,
  duration_seconds integer,
  occurred_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.newsletters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid,
  brokerage_id uuid REFERENCES public.brokerages(id),
  title text,
  campaign_name text,
  subject_line text,
  content text,
  status text DEFAULT 'draft',
  audience_segment text,
  send_date timestamptz,
  open_rate numeric(5,2),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.listing_marketing_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid REFERENCES public.listings(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES public.brokerages(id),
  content_type text,
  content text,
  generated_at timestamptz DEFAULT now()
);

ALTER TABLE public.unified_lead_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behavioral_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_behavior ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligence_signals_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intelligent_outreach_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_osint_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_property_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idx_property_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.motivated_seller_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_search_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_search_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nextdoor_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_marketing_content ENABLE ROW LEVEL SECURITY;
