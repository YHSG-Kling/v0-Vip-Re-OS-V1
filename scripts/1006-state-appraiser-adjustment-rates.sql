-- ===========================================================================
-- 1006-state-appraiser-adjustment-rates.sql
-- Per-state, per-feature adjustment rates for the AI-CMA sales-comparison
-- approach. Default 'US' row used as fallback; high-value coastal states
-- (FL, CA, NY, MA, WA, AZ, CO, HI) override with state-specific values.
-- Brokerages can layer their own overrides via global_settings.
--
-- APPLIED VIA: supabase apply_migration "state_appraiser_adjustment_rates"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.state_appraiser_adjustment_rates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                    varchar(2) NOT NULL,
  adjustment_type          text NOT NULL,
  rate_basis               text NOT NULL CHECK (rate_basis IN ('pct_of_comp_price','per_unit_dollars')),
  typical_rate_low         numeric NOT NULL,
  typical_rate_mid         numeric NOT NULL,
  typical_rate_high        numeric NOT NULL,
  unit                     text NOT NULL,
  notes                    text,
  applicable_property_types text[] DEFAULT ARRAY['single_family','condo','townhouse'],
  source                   text,
  effective_year           int DEFAULT 2024,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now(),
  UNIQUE (state, adjustment_type, rate_basis)
);

CREATE INDEX IF NOT EXISTS idx_state_adjustment_rates_state ON public.state_appraiser_adjustment_rates(state);
CREATE INDEX IF NOT EXISTS idx_state_adjustment_rates_type ON public.state_appraiser_adjustment_rates(state, adjustment_type);

ALTER TABLE public.state_appraiser_adjustment_rates ENABLE ROW LEVEL SECURITY;

-- See migration in DB for full seed data (US default + FL, CA, TX, NY, MA, WA, AZ, CO, HI overrides)
