-- m244: agent_earnings is the table the earnings P&L dashboard reads (period_type
-- mtd/ytd), but it had NO unique constraint on (agent_id, period_type, period_label).
-- Every upsert targeting that onConflict (the earnings-rollup cron + the legacy
-- application/transactions calculateCommissions writer) FAILED at runtime — so the
-- table stayed empty and the dashboard showed $0 on closed deals. Add the constraint
-- so period rows upsert correctly. Table is empty in all environments, so no dedup.
alter table agent_earnings
  add constraint agent_earnings_agent_period_uniq unique (agent_id, period_type, period_label);
