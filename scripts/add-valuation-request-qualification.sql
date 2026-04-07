-- Add qualification_data column to valuation_requests
-- Stores seller qualification answers from the home value form (step 3)
ALTER TABLE valuation_requests
  ADD COLUMN IF NOT EXISTS qualification_data jsonb,
  ADD COLUMN IF NOT EXISTS property_type text;
