-- Add delay-tracking columns to transparency_updates if they don't already exist.
-- These are required by the logTransactionDelay action.

ALTER TABLE transparency_updates
  ADD COLUMN IF NOT EXISTS update_type       text,
  ADD COLUMN IF NOT EXISTS message           text,
  ADD COLUMN IF NOT EXISTS is_visible_to_client boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_id          uuid REFERENCES users(id) ON DELETE SET NULL;
