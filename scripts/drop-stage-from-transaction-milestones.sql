-- Drop the `stage` column added in the previous migration.
-- Audit confirmed: no application code reads or writes transaction_milestones.stage.
-- Milestone state is tracked via the existing `status` column (pending/in_progress/completed/overdue).
-- Milestone grouping by transaction stage is derived from `milestone_type` and `milestone_name`.

-- Drop the index first, then the column
DROP INDEX IF EXISTS idx_transaction_milestones_stage;
ALTER TABLE transaction_milestones DROP COLUMN IF EXISTS stage;
