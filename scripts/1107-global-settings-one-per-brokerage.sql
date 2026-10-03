-- Enforce one global_settings row per brokerage.
-- The kernel now self-seeds a settings row on first access (getGlobalSettings /
-- updateGlobalSettings). A unique constraint on brokerage_id makes that seed
-- race-safe (concurrent first-access requests can't create duplicate rows) and
-- guarantees the "one row per brokerage" assumption the read path relies on.

-- Collapse any pre-existing duplicates down to the oldest row per brokerage
-- before adding the constraint, so the migration is safe on dirty data.
DELETE FROM global_settings gs
USING global_settings keep
WHERE gs.brokerage_id = keep.brokerage_id
  AND gs.created_at > keep.created_at;

-- Handle exact created_at ties (fall back to id ordering).
DELETE FROM global_settings gs
USING global_settings keep
WHERE gs.brokerage_id = keep.brokerage_id
  AND gs.created_at = keep.created_at
  AND gs.id > keep.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_global_settings_brokerage
  ON global_settings(brokerage_id);
