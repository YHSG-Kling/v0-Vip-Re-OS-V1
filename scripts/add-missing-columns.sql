-- Migration: Add missing columns that backend functionality depends on
-- Rule: if the schema doesn't have a column the functionality uses, add it to the schema.

-- ============================================================================
-- client_gifts: add delivery_address, scheduled_delivery, cost (actual spend)
-- The createGiftOrder action takes deliveryAddress and deliveryDate.
-- estimated_cost already exists; cost here is the confirmed/actual amount spent.
-- ============================================================================
ALTER TABLE public.client_gifts
  ADD COLUMN IF NOT EXISTS delivery_address    text,
  ADD COLUMN IF NOT EXISTS scheduled_delivery  date,
  ADD COLUMN IF NOT EXISTS delivery_notes      text;

-- ============================================================================
-- ai_assistant_notes: add entity_type + entity_id for scoped notes
-- aiCreateRecoveryPlan and future actions need to associate notes to a
-- specific entity (agent_review, offer, listing, etc.).
-- ============================================================================
ALTER TABLE public.ai_assistant_notes
  ADD COLUMN IF NOT EXISTS entity_type  text,
  ADD COLUMN IF NOT EXISTS entity_id    uuid;

-- ============================================================================
-- scheduled_touchpoints: add brokerage_id column for RLS isolation
-- The stp_agent policy relies on agent_id; brokerage_id adds admin visibility.
-- ============================================================================
ALTER TABLE public.scheduled_touchpoints
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE CASCADE;

-- ============================================================================
-- gift_vendors: ensure table exists for ai-client-gifting getVendors action
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.gift_vendors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  name          text NOT NULL,
  category      text,
  contact_name  text,
  email         text,
  phone         text,
  website       text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamp with time zone DEFAULT now(),
  updated_at    timestamp with time zone DEFAULT now()
);

ALTER TABLE public.gift_vendors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'gift_vendors' AND policyname = 'gift_vendors_brokerage_isolation'
  ) THEN
    CREATE POLICY gift_vendors_brokerage_isolation ON public.gift_vendors
      FOR ALL USING (
        brokerage_id IN (
          SELECT brokerage_id FROM public.users WHERE id = auth.uid()
          UNION
          SELECT brokerage_id FROM public.agents WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ============================================================================
-- client_engagement_scores: ensure reviewer_name col exists on agent_reviews
-- for ai-review-automation reviewer_name SELECT
-- (already exists: agent_reviews has no reviewer_name — add it)
-- ============================================================================
ALTER TABLE public.agent_reviews
  ADD COLUMN IF NOT EXISTS reviewer_name text;
