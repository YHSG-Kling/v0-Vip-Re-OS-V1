-- Migration: Add is_client_visible to transaction_milestones
-- This column is queried by lib/portal/resolve-education-context.ts to anchor
-- the kernel education gate to the correct active milestone for the buyer/seller
-- portal view. Without it the filter silently returns null and all contacts
-- receive the pre-journey lesson plan regardless of transaction stage.

ALTER TABLE transaction_milestones
  ADD COLUMN IF NOT EXISTS is_client_visible boolean NOT NULL DEFAULT true;

-- Default TRUE: all existing milestones are visible to the client by default.
-- Agents can set is_client_visible = false for internal milestones (e.g.
-- commission_disbursement, internal_review) that should not surface in the portal.
COMMENT ON COLUMN transaction_milestones.is_client_visible IS
  'When true this milestone is surfaced in the client portal and used to anchor education plan delivery. Set false for internal/agent-only milestones.';

-- Index for the portal resolve query pattern
CREATE INDEX IF NOT EXISTS idx_tm_portal_anchor
  ON transaction_milestones (transaction_id, status, is_client_visible, milestone_date);
