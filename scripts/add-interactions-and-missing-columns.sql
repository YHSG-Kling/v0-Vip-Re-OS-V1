-- ============================================================
-- Migration: Add interactions table + missing columns
-- Restores all functionality stripped by the previous session.
-- ============================================================

-- 1. interactions table (distinct from activities — stores all
--    client-facing interaction logs with type, notes, outcome)
CREATE TABLE IF NOT EXISTS public.interactions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id          uuid        REFERENCES public.users(id),
  brokerage_id      uuid        REFERENCES public.brokerages(id),
  interaction_type  text        NOT NULL,
  interaction_date  timestamptz NOT NULL DEFAULT now(),
  notes             text,
  outcome           text,
  channel           text,
  duration_minutes  integer,
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- RLS: brokerage isolation
ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'interactions'
      AND policyname = 'interactions_brokerage_isolation'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY interactions_brokerage_isolation ON public.interactions
        FOR ALL
        USING (
          brokerage_id IN (
            SELECT brokerage_id FROM public.user_role_assignments
            WHERE user_id = auth.uid()
          )
        )
    $policy$;
  END IF;
END;
$$;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_interactions_contact_id  ON public.interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_agent_id    ON public.interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_interactions_brokerage   ON public.interactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_interactions_date        ON public.interactions(interaction_date DESC);

-- 2. property_preferences — add missing columns
ALTER TABLE public.property_preferences
  ADD COLUMN IF NOT EXISTS preferred_price_min  numeric,
  ADD COLUMN IF NOT EXISTS preferred_price_max  numeric;

-- 3. buyer_behavior_predictions — add missing columns
ALTER TABLE public.buyer_behavior_predictions
  ADD COLUMN IF NOT EXISTS confidence_score          numeric,
  ADD COLUMN IF NOT EXISTS predicted_price_min        numeric,
  ADD COLUMN IF NOT EXISTS predicted_price_max        numeric,
  ADD COLUMN IF NOT EXISTS predicted_property_type    text,
  ADD COLUMN IF NOT EXISTS predicted_timeline_days    integer,
  ADD COLUMN IF NOT EXISTS ai_reasoning               text;

-- 4. user_profiles — add brokerage_id
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id);

CREATE INDEX IF NOT EXISTS idx_user_profiles_brokerage ON public.user_profiles(brokerage_id);
