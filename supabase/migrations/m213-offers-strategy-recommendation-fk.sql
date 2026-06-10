-- m213: offers.strategy_recommendation_id (Shopping Agent boundary burn).
-- createBuyerOffer stamps the strategy recommendation that produced the offer and
-- the CRM offers page reads it back; the column never existed so the offer →
-- strategy lineage (and outcome learning) was silently dropped.
ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS strategy_recommendation_id uuid
  REFERENCES public.strategy_recommendations(id) ON DELETE SET NULL;
