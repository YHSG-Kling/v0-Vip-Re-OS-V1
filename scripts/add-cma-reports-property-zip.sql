-- Add property_zip column to cma_reports
-- This column was referenced in the generateAICMA action but did not exist in the schema.
-- All other columns (lot_size, year_built, features, condition, comparable_count,
-- recommended_price, price_range_low, price_range_high, listing_id, disclaimer_included,
-- market_conditions, quality_score) already exist in the table.

ALTER TABLE cma_reports
  ADD COLUMN IF NOT EXISTS property_zip text;
