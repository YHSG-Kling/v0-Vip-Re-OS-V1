-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m710 — DURABLE MISSION RUNTIME (wave 104, lane 104D; owner scope 107: "Durable Mission runtime —
-- canonical mission with the owner's field list + states PROPOSED PLANNING ACTIVE WAITING BLOCKED
-- APPROVAL_REQUIRED ESCALATED COMPLETED FAILED CANCELLED; existing managers coordinate through the
-- registry"). OWNER LAWS 1/2/4/5.
--
-- EVALUATED FIRST — the four survivors stay the system of record for what they already hold, and
-- each one was measured against "a long-lived objective the OS owns" before this table was written:
--   · agent_goals (app/actions/ai-agent-goals.ts) — ONE agent × ONE year × ONE numeric target
--     (agent_id NOT NULL, goal_type CHECK of 9 KPIs, current_value). No state beyond the number,
--     no owner manager, no budget / authority / deadline / blockers / dependencies / evidence.
--     Extending it would turn a KPI row into a lifecycle row and break the goals page's upsert
--     identity (agent_id, year, goal_type). It is WIRED instead: a goal becomes the objective of
--     a mission (agent_goals.mission_id below).
--   · workflow_runs (lib/workflow-orchestrator/engine.ts) — ONE chain instance: status
--     pending/running/paused/needs_approval/completed/failed/cancelled, a step cursor, step_outputs.
--     Minutes-to-hours, one chain key, no objective, no budget, no success criteria, no managers.
--     Several runs serve one mission — so it gains mission_id below and the stale-run reaper
--     (the one reaper) now also sweeps mission deadlines (no second reaper).
--   · manager_signals — a message between two managers (from/to/type/payload/status). It is the
--     COORDINATION channel a mission escalates through, not the mission.
--   · strategy_sessions (lib/kernel/strategy-session.ts) — a dated conversation that yields
--     recommendations; no durable state machine.
-- None carries the owner's field list; the capability is wanted; so the missing half is BUILT
-- (CLAUDE.md §1.2) as ONE additive table pair under ONE kernel service, lib/kernel/missions.ts.
--
-- · mission_events is APPEND-ONLY (a trigger refuses UPDATE / DELETE, the m689 pattern): every
--   transition, attached action, attached outcome, blocker and evidence lands as a row carrying
--   causation_id / correlation_id (lib/kernel/causation.ts) and the agent_action_ledger row the
--   transition wrote — "which event made this happen" is answerable from the row alone (LAW 5).
-- · One vocabulary (§6): state / mission_type / priority are CHECKed here and mirrored by the
--   constants in lib/kernel/missions.ts (MISSION_STATES, MISSION_TYPES, MISSION_PRIORITIES).
-- · agent_action_ledger_reason_code_check gains MISSION_LIFECYCLE — the WHY of a transition the
--   kernel records on the ledger (mirrored in ACTION_REASON_CODES, lib/kernel/action-ledger.ts;
--   the same two-part NOT VALID / VALIDATE form as m693).
-- · Writes go through the service client only (REVOKE for anon/authenticated); tenant reads via
--   the existing has_brokerage_access(brokerage_id) predicate.
--
-- Apply in TWO parts (wave 98 rule): PART A (tables + columns + CHECKs + RLS), then PART B
-- (indexes + triggers + the reason-code CHECK). AFTER APPLYING: regenerate the vocabulary cache
-- (four CHECKs), the schema snapshot (missions, mission_events, workflow_runs.mission_id,
-- agent_goals.mission_id), the FK map and live-tables.

-- ══════════════════════════════ PART A — tables, columns, CHECKs, RLS ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.missions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  objective              text        NOT NULL,
  mission_type           text        NOT NULL DEFAULT 'custom',
  owner_manager          text        NOT NULL,
  participating_managers text[]      NOT NULL DEFAULT '{}',
  subject_type           text        NULL,
  subject_id             uuid        NULL,
  state                  text        NOT NULL DEFAULT 'PROPOSED',
  priority               text        NOT NULL DEFAULT 'normal',
  success_criteria       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- budget: { usd, tokens, on_exhausted } — the usage/cost vocabulary (agent_action_ledger.cost_usd
  -- + ai_tool_usage tokens); spent_* are the running sums attachAction keeps.
  budget                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  spent_usd              numeric(12,4) NOT NULL DEFAULT 0,
  spent_tokens           bigint      NOT NULL DEFAULT 0,
  -- the authority ladder rung (persona-tool-policy AuthorityLevel 0-6) this mission may act up to,
  -- resolved from managed_agents.config.authority_level for the owner manager at creation.
  authority_ceiling      smallint    NOT NULL DEFAULT 6,
  deadline               timestamptz NULL,
  dependencies           uuid[]      NOT NULL DEFAULT '{}',
  blockers               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  evidence               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  progress               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  actions                uuid[]      NOT NULL DEFAULT '{}',
  outcomes               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by             uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  parent_mission         uuid        NULL REFERENCES public.missions(id) ON DELETE SET NULL,
  state_changed_at       timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missions_state_check
    CHECK (state IN ('PROPOSED', 'PLANNING', 'ACTIVE', 'WAITING', 'BLOCKED', 'APPROVAL_REQUIRED', 'ESCALATED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  CONSTRAINT missions_mission_type_check
    CHECK (mission_type IN ('agent_goal', 'brokerage_objective', 'workflow', 'campaign', 'transaction', 'recruiting', 'compliance', 'custom')),
  CONSTRAINT missions_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT missions_authority_ceiling_check
    CHECK (authority_ceiling BETWEEN 0 AND 6),
  CONSTRAINT missions_subject_pair_check
    CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT missions_not_own_parent_check
    CHECK (parent_mission IS NULL OR parent_mission <> id)
);

CREATE TABLE IF NOT EXISTS public.mission_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id      uuid        NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  brokerage_id    uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  event_kind      text        NOT NULL,
  from_state      text        NULL,
  to_state        text        NULL,
  reason_code     text        NULL,
  reason          text        NULL,
  actor_type      text        NOT NULL DEFAULT 'system',
  actor_id        text        NULL,
  evidence        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ledger_entry_id uuid        NULL,
  causation_id    uuid        NULL,
  correlation_id  uuid        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mission_events_event_kind_check
    CHECK (event_kind IN ('created', 'transition', 'refused', 'action_attached', 'outcome_attached', 'blocker_added', 'blocker_cleared', 'evidence', 'progress')),
  CONSTRAINT mission_events_actor_type_check
    CHECK (actor_type IN ('manager', 'user', 'agent', 'system'))
);

ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS mission_id uuid NULL REFERENCES public.missions(id) ON DELETE SET NULL;
ALTER TABLE public.agent_goals  ADD COLUMN IF NOT EXISTS mission_id uuid NULL REFERENCES public.missions(id) ON DELETE SET NULL;

ALTER TABLE public.missions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_events ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.missions       FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.mission_events FROM anon, authenticated;

DROP POLICY IF EXISTS missions_select ON public.missions;
CREATE POLICY missions_select ON public.missions
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS mission_events_select ON public.mission_events;
CREATE POLICY mission_events_select ON public.mission_events
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.missions IS
  'Durable objective the OS owns (wave 104, m710): one row per mission, written ONLY by lib/kernel/missions.ts (state machine enforced in code; every transition is a mission_events row + an agent_action_ledger row with reason_code MISSION_LIFECYCLE). Owner/participating managers are MANAGERS keys (lib/kernel/manager-registry.ts).';
COMMENT ON TABLE public.mission_events IS
  'APPEND-ONLY evidence of a mission (wave 104, m710): transitions, refusals, attached actions/outcomes, blockers, evidence. UPDATE/DELETE refused by trigger.';

-- ══════════════════════════════ PART B — indexes, triggers, reason code ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_missions_tenant_state      ON public.missions (brokerage_id, state);
CREATE INDEX IF NOT EXISTS idx_missions_tenant_deadline   ON public.missions (brokerage_id, deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_missions_subject           ON public.missions (brokerage_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_missions_parent            ON public.missions (parent_mission) WHERE parent_mission IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mission_events_mission     ON public.mission_events (mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mission_events_correlation ON public.mission_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_mission      ON public.workflow_runs (mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_goals_mission        ON public.agent_goals (mission_id) WHERE mission_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.missions_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.state_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS missions_touch_updated_at ON public.missions;
CREATE TRIGGER missions_touch_updated_at
  BEFORE UPDATE ON public.missions
  FOR EACH ROW EXECUTE FUNCTION public.missions_touch_updated_at();

CREATE OR REPLACE FUNCTION public.mission_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'mission_events is append-only (m710): % refused on %', TG_OP, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS mission_events_append_only ON public.mission_events;
CREATE TRIGGER mission_events_append_only
  BEFORE UPDATE OR DELETE ON public.mission_events
  FOR EACH ROW EXECUTE FUNCTION public.mission_events_append_only();

ALTER TABLE public.agent_action_ledger DROP CONSTRAINT IF EXISTS agent_action_ledger_reason_code_check;
ALTER TABLE public.agent_action_ledger ADD CONSTRAINT agent_action_ledger_reason_code_check
  CHECK (reason_code IN (
    'SELLER_FOLLOWUP_INTENT_INCREASE', 'BUYER_PROPERTY_MATCH', 'TRANSACTION_DEADLINE',
    'TRANSACTION_MILESTONE', 'AGENT_SLA_BREACH', 'PROPERTY_VALUE_CHANGE', 'LEAD_FIRST_RESPONSE',
    'CAMPAIGN_STEP', 'LIFETIME_TOUCH', 'CONTACT_WELCOME', 'COMPLIANCE_NOTICE', 'HUMAN_REQUESTED',
    'SCHEDULED_CONTENT_PUBLISH', 'SUBSCRIPTION_LIFECYCLE',
    'NURTURE_TOUCH', 'CONVERSATION_RESPONSE', 'SERVICE_NOTICE', 'STAFF_ALERT',
    'WAIT_COOLDOWN', 'NO_ACTION_NEEDED', 'LEARNED_IMPROVEMENT', 'MISSION_LIFECYCLE', 'UNSPECIFIED')) NOT VALID;
ALTER TABLE public.agent_action_ledger VALIDATE CONSTRAINT agent_action_ledger_reason_code_check;
