-- 1028-milestone-override-columns.sql
--
-- Adds override_at / override_by / override_reason / updated_at columns to
-- transaction_milestones so the kernel helper overrideMilestone()
-- (lib/transactions/milestone-service.ts) can record a force-completion
-- past blockers with full audit trail.
--
-- The action is exposed at the agent-facing wrapper
-- overrideMilestoneAction() in app/actions/transaction-milestones.ts which
-- runs requireOverrideActor() — only broker / broker_admin / admin /
-- superadmin / compliance_officer / compliance_manager user_types may
-- invoke it, and the reason must be ≥ 10 characters.
--
-- UI surface: transaction-detail-client.tsx milestone row shows an
-- amber "Override" button to those user_types on non-completed milestones.
--
-- Applied to live via Supabase MCP migration "add_milestone_override_columns".
-- Committed here for source-of-truth parity.

ALTER TABLE transaction_milestones
  ADD COLUMN IF NOT EXISTS override_at     timestamptz,
  ADD COLUMN IF NOT EXISTS override_by     uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz DEFAULT now();

COMMENT ON COLUMN transaction_milestones.override_at IS
  'When a milestone was force-completed past blockers. Set by overrideMilestone() in lib/transactions/milestone-service.ts; requires broker/admin/superadmin/compliance_officer via requireOverrideActor.';
COMMENT ON COLUMN transaction_milestones.override_by IS
  'auth user_id of the elevated user who overrode the milestone.';
COMMENT ON COLUMN transaction_milestones.override_reason IS
  'Required audit-trail text (>= 10 chars) explaining why the milestone was overridden.';
