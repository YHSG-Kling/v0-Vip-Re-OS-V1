-- =============================================================================
-- MIGRATION 114: Fix contacts.agent_id FK — users.id → agents.id
-- =============================================================================
-- The contacts table was created with contacts.agent_id → users.id which is
-- incorrect. The canonical design (confirmed in lib/kernel/crm.ts, the create
-- route, and the contacts RLS policies) is contacts.agent_id → agents.id.
--
-- This migration:
--   1. Backfills any contacts.agent_id = users.id rows by finding the
--      matching agents.id via agents.user_id, scoped to the same brokerage.
--   2. Drops the old FK constraint.
--   3. Creates the correct FK: contacts.agent_id → agents.id.
--   4. Updates the contacts RLS policy to use the agents table join.
-- =============================================================================

BEGIN;

-- ─── STEP 1: Drop the old incorrect FK first (blocks the backfill UPDATE) ────
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_agent_id_fkey;

-- ─── STEP 2: Backfill — replace users.id values with the correct agents.id ──
-- Only updates rows where agent_id currently points at a users.id
-- (i.e. it exists in auth.users but NOT in agents — meaning the seed was wrong).
UPDATE contacts c
SET agent_id = a.id
FROM agents a
WHERE a.user_id = c.agent_id         -- current agent_id is actually a users.id
  AND (
    c.brokerage_id IS NULL            -- unscoped demo rows
    OR a.brokerage_id = c.brokerage_id -- same brokerage — safety guard
  );

-- ─── STEP 3: Add the correct FK to agents.id ─────────────────────────────────
-- Use DEFERRABLE so that any future bulk inserts can insert agents + contacts
-- in the same transaction without ordering constraints.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_agent_id_fkey
    FOREIGN KEY (agent_id)
    REFERENCES agents(id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

-- ─── STEP 4: Verify the backfill ─────────────────────────────────────────────
SELECT
  'contacts with agent_id matching agents.id' AS check,
  COUNT(*) AS matched
FROM contacts c
JOIN agents a ON a.id = c.agent_id
WHERE c.agent_id IS NOT NULL

UNION ALL

SELECT
  'contacts with orphaned agent_id (still pointing at users, no agents row)' AS check,
  COUNT(*) AS unresolved
FROM contacts c
WHERE c.agent_id IS NOT NULL
  AND c.agent_id NOT IN (SELECT id FROM agents);

COMMIT;
