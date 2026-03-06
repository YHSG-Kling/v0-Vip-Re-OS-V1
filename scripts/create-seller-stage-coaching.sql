-- Create seller_stage_coaching table
-- Caches AI-generated and brokerage-curated coaching content per stage + persona.
-- brokerage_id NULL = system-wide default (AI-generated)
-- persona NULL      = applies to all personas for that stage

CREATE TABLE IF NOT EXISTS public.seller_stage_coaching (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id               uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  listing_stage              text NOT NULL,
  persona                    text CHECK (persona IN ('motivated','skeptical','emotional','investor','indecisive','analytical')),
  coaching_headline          text NOT NULL,
  coaching_body              text NOT NULL,
  suggested_talking_points   text[]  NOT NULL DEFAULT '{}',
  common_objections          jsonb   NOT NULL DEFAULT '[]',
  next_action_prompt         text    NOT NULL,
  estimated_stage_duration   text,
  success_signals            text[]  NOT NULL DEFAULT '{}',
  risk_signals               text[]  NOT NULL DEFAULT '{}',
  ai_generated               boolean NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Index for the priority-ordered cache lookup
CREATE INDEX IF NOT EXISTS idx_seller_stage_coaching_lookup
  ON public.seller_stage_coaching (listing_stage, brokerage_id NULLS LAST, persona NULLS LAST);

-- RLS
ALTER TABLE public.seller_stage_coaching ENABLE ROW LEVEL SECURITY;

-- Agents/brokers in same brokerage can read (also allows NULL brokerage_id system defaults)
CREATE POLICY "seller_stage_coaching_read" ON public.seller_stage_coaching
  FOR SELECT USING (
    brokerage_id IS NULL
    OR brokerage_id IN (
      SELECT brokerage_id FROM public.users WHERE id = auth.uid()
    )
  );

-- Only service role can write (AI generation + admin seeding use service client)
CREATE POLICY "seller_stage_coaching_service_write" ON public.seller_stage_coaching
  FOR ALL USING (false); -- blocked for JWT users; service_role bypasses RLS
