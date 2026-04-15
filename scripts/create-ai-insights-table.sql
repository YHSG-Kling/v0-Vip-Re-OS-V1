-- Create ai_insights table used by detectClientChurn and other AI prediction functions
CREATE TABLE IF NOT EXISTS public.ai_insights (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  entity_type       text NOT NULL DEFAULT 'lead',
  entity_id         uuid,
  insight_type      text NOT NULL,
  insight_title     text NOT NULL,
  insight_description text,
  actionable_steps  jsonb DEFAULT '[]'::jsonb,
  priority          text DEFAULT 'medium',
  estimated_impact  jsonb DEFAULT '{}'::jsonb,
  status            text DEFAULT 'active',
  expires_at        timestamp with time zone,
  acted_on_at       timestamp with time zone,
  dismissed_at      timestamp with time zone,
  created_at        timestamp with time zone DEFAULT now(),
  updated_at        timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

-- Brokerage isolation policy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_insights' AND policyname = 'ai_insights_brokerage_isolation'
  ) THEN
    CREATE POLICY ai_insights_brokerage_isolation ON public.ai_insights
      FOR ALL USING (
        brokerage_id IN (
          SELECT brokerage_id FROM public.user_role_assignments
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Service role full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_insights' AND policyname = 'ai_insights_service_role'
  ) THEN
    CREATE POLICY ai_insights_service_role ON public.ai_insights
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_ai_insights_entity ON public.ai_insights(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_brokerage ON public.ai_insights(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_insights_contact ON public.ai_insights(contact_id);
