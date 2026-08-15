-- Schema cleanup pass — drop deprecated duplicate columns now that all
-- callers have been migrated to the canonical column for each pair.
--
-- Pairs (deprecated → canonical):
--   listings.current_stage              → listings.lifecycle_stage
--   listings.entered_at                 → listings.stage_entered_at
--   transaction_milestones.milestone_date → transaction_milestones.target_date
--   offers.winning_offer                → offers.is_winning_offer
--   offers.earnest_money_amount         → offers.earnest_money
--
-- For each pair we first backfill the canonical column with any data only
-- present on the deprecated column, then drop the deprecated column.

-- ── 1. listings ─────────────────────────────────────────────────────────────
UPDATE listings
   SET lifecycle_stage = current_stage
 WHERE lifecycle_stage IS NULL
   AND current_stage IS NOT NULL;

UPDATE listings
   SET stage_entered_at = entered_at
 WHERE stage_entered_at IS NULL
   AND entered_at IS NOT NULL;

ALTER TABLE listings DROP COLUMN IF EXISTS current_stage;
ALTER TABLE listings DROP COLUMN IF EXISTS entered_at;

-- ── 2. transaction_milestones ───────────────────────────────────────────────
UPDATE transaction_milestones
   SET target_date = milestone_date::date
 WHERE target_date IS NULL
   AND milestone_date IS NOT NULL;

ALTER TABLE transaction_milestones DROP COLUMN IF EXISTS milestone_date;

-- ── 3. offers — winning flag ────────────────────────────────────────────────
UPDATE offers
   SET is_winning_offer = winning_offer
 WHERE is_winning_offer IS NULL
   AND winning_offer IS NOT NULL;

ALTER TABLE offers DROP COLUMN IF EXISTS winning_offer;

-- ── 4. offers — earnest money ───────────────────────────────────────────────
UPDATE offers
   SET earnest_money = earnest_money_amount
 WHERE earnest_money IS NULL
   AND earnest_money_amount IS NOT NULL;

ALTER TABLE offers DROP COLUMN IF EXISTS earnest_money_amount;
