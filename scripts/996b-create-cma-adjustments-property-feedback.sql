-- ai-cma.ts inserts price adjustments per comp; ai-property-matching.ts logs buyer feedback
CREATE TABLE IF NOT EXISTS public.cma_price_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cma_report_id uuid REFERENCES public.cma_reports(id) ON DELETE CASCADE,
  comparable_property_id uuid,
  comparable_address text,
  adjustment_type text,
  adjustment_amount numeric(14,2),
  rationale text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cma_price_adjustments_report ON public.cma_price_adjustments(cma_report_id);

CREATE TABLE IF NOT EXISTS public.property_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  property_id uuid,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  feedback_type text,
  interest_level integer CHECK (interest_level BETWEEN 1 AND 5),
  liked_features text[],
  disliked_features text[],
  notes text,
  source text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_feedback_contact ON public.property_feedback(contact_id);
CREATE INDEX IF NOT EXISTS idx_property_feedback_listing ON public.property_feedback(listing_id);

ALTER TABLE public.cma_price_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.property_feedback ENABLE ROW LEVEL SECURITY;
