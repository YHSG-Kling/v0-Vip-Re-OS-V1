-- ── APPLIED LIVE 2026-10-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- STRUCTURED MANAGER-TO-MANAGER DELEGATION (wave 105, lane 105A; owner: "managers never chat
-- indefinitely — request → accept → work → return / reject / dissent / escalate; observable").
-- OWNER LAWS 1/2/4/5. Additive only.
--
-- SURVIVORS EVALUATED FIRST (each stays the system of record for what it holds; none replaced):
--   · lib/kernel/manager-dissent.ts — PEER REVIEW of a proposal (reviewProposal: pass / dissent /
--     veto with objections, REVIEW_MARK idempotency). It is THE survivor for "one manager disagrees
--     with another and says WHY" and is EXTENDED here (reviewDelegation) — the delegation's dissent
--     path records its verdict through it. It holds no request lifecycle.
--   · lib/managers/deliberation.ts — an ARGUED debate on a collaboration domain, persisted onto the
--     referral row's payload (manager_signals.payload.deliberation). A debate, not a work order.
--   · manager_signals + signal-registry / signal-routing / coordination-kind — the BUS: one message
--     from manager A to manager B with a type, a payload and an open/consumed status. A signal has
--     no objective, no required output, no authority, no budget, no deadline, no result, no
--     accept / return / reject vocabulary — it is the channel a delegation is ANNOUNCED on
--     (delegation_handoff_requested / delegation_escalated), not the delegation.
--   · lib/kernel/voice-delegation.ts — a HUMAN's spoken instruction executed on the rails
--     (follow-up + enrol); its DelegationResult is the voice admin's, not manager-to-manager.
--   · missions.participating_managers (m710) — WHO is on a mission; it says nothing about what one
--     manager asked another to do, by when, within what authority and budget, or what came back.
-- The capability is wanted and no survivor carries the request/return lifecycle, so the missing
-- half is BUILT (CLAUDE.md §1.2) as ONE additive table pair under ONE kernel service,
-- lib/kernel/manager-delegation.ts, inside the mission runtime (mission_id, nullable for a
-- pre-mission request).
--
-- · ONE capability vocabulary (§6): requested_capability is CHECKed against the app capability
--   catalogue — APP_CAPABILITY_REGISTRY keys (lib/agentic-os/app-capability-registry.ts), the
--   registry whose CAPABILITY_MANAGER map names the manager accountable for each capability
--   (lib/agentic-os/capability-ownership.ts). The service refuses a delegation whose assigned
--   manager does not own the capability. The owner's example PREPARE_SELLER_APPOINTMENT is the
--   catalogue key `listing_appointment_prep` (listing_concierge) — added in the same lane.
--   A new catalogue key widens this CHECK through the latest defining migration (superset rule).
-- · status CHECK — the owner's eight states; the transitions live in code (DELEGATION_TRANSITIONS).
-- · authority ≤ the mission's authority_ceiling (and the assigned manager's ladder rung) — enforced
--   in requestDelegation; the column CHECK pins the ladder's range (0-6, persona-tool-policy).
-- · manager_delegation_events is APPEND-ONLY (trigger refuses UPDATE / DELETE — the m689 / m710
--   pattern): every transition, refusal and review lands as a row carrying the agent_action_ledger
--   row it rode (reason_code MISSION_LIFECYCLE, detail.delegation_id) and the causation /
--   correlation of the scope (LAW 5).
-- · Writes go through the service client only (REVOKE for anon / authenticated); tenant reads via
--   the existing has_brokerage_access(brokerage_id) predicate.
--
-- Apply in TWO parts (wave 98 rule): PART A (tables + CHECKs + RLS), then PART B (indexes +
-- triggers). AFTER APPLYING: regenerate the vocabulary cache (three CHECKs), the schema snapshot,
-- the FK map and live-tables.

-- ══════════════════════════════ PART A — tables, CHECKs, RLS ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.manager_delegations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id           uuid        NULL REFERENCES public.missions(id) ON DELETE SET NULL,
  brokerage_id         uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  requesting_manager   text        NOT NULL,
  assigned_manager     text        NOT NULL,
  requested_capability text        NOT NULL,
  objective            text        NOT NULL,
  input_entities       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  required_output      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- the authority ladder rung (persona-tool-policy AuthorityLevel 0-6) the assigned manager may act
  -- up to on this delegation — never above the mission's authority_ceiling (enforced in code).
  authority            smallint    NOT NULL DEFAULT 0,
  -- budget: { usd, tokens } — the usage/cost vocabulary (agent_action_ledger.cost_usd + ai_tool_usage
  -- tokens); spent_* are the running sums the return records. Never above the mission's remaining.
  budget               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  spent_usd            numeric(12,4) NOT NULL DEFAULT 0,
  spent_tokens         bigint      NOT NULL DEFAULT 0,
  deadline             timestamptz NULL,
  status               text        NOT NULL DEFAULT 'REQUESTED',
  result               jsonb       NULL,
  evidence             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  state_changed_at     timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_delegations_status_check
    CHECK (status IN ('REQUESTED', 'ACCEPTED', 'WORKING', 'RETURNED', 'REJECTED', 'DISSENTED', 'ESCALATED', 'CANCELLED')),
  CONSTRAINT manager_delegations_requested_capability_check
    CHECK (requested_capability IN (
      'lead_search', 'contact_get', 'cma_generate', 'appointment_schedule', 'transaction_advance',
      'listing_publish', 'isa_qualify', 'lead_create', 'newsletter_send', 'blog_publish',
      'marketing_campaign_create', 'content_repurpose', 'social_post_publish', 'report_generate',
      'report_export', 'education_path_get', 'education_assign', 'portal_milestones_get',
      'review_request_send', 'inbox_reply_send', 'podcast_publish', 'direct_mail_send',
      'video_distribute', 'gift_send', 'handwritten_note_send', 'connectivity_scan',
      'payment_transfer', 'accounting_sync', 'listing_appointment_prep')),
  CONSTRAINT manager_delegations_authority_check
    CHECK (authority BETWEEN 0 AND 6),
  CONSTRAINT manager_delegations_not_self_check
    CHECK (requesting_manager <> assigned_manager)
);

CREATE TABLE IF NOT EXISTS public.manager_delegation_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delegation_id   uuid        NOT NULL REFERENCES public.manager_delegations(id) ON DELETE CASCADE,
  brokerage_id    uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  event_kind      text        NOT NULL,
  from_status     text        NULL,
  to_status       text        NULL,
  reason_code     text        NULL,
  reason          text        NULL,
  actor_type      text        NOT NULL DEFAULT 'system',
  actor_id        text        NULL,
  evidence        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ledger_entry_id uuid        NULL,
  causation_id    uuid        NULL,
  correlation_id  uuid        NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_delegation_events_event_kind_check
    CHECK (event_kind IN ('requested', 'transition', 'refused', 'review', 'evidence')),
  CONSTRAINT manager_delegation_events_actor_type_check
    CHECK (actor_type IN ('manager', 'user', 'agent', 'system'))
);

ALTER TABLE public.manager_delegations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manager_delegation_events ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.manager_delegations       FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.manager_delegation_events FROM anon, authenticated;

DROP POLICY IF EXISTS manager_delegations_select ON public.manager_delegations;
CREATE POLICY manager_delegations_select ON public.manager_delegations
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS manager_delegation_events_select ON public.manager_delegation_events;
CREATE POLICY manager_delegation_events_select ON public.manager_delegation_events
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.manager_delegations IS
  'One manager asks another for a CAPABILITY (wave 105, lane 105A): requesting_manager / assigned_manager are MANAGERS keys, requested_capability an APP_CAPABILITY_REGISTRY key the assigned manager owns (CAPABILITY_MANAGER). Written ONLY by lib/kernel/manager-delegation.ts (state machine in code; every transition is a manager_delegation_events row + an agent_action_ledger row, reason_code MISSION_LIFECYCLE, detail.delegation_id). mission_id is the mission it serves (null for a pre-mission request).';
COMMENT ON TABLE public.manager_delegation_events IS
  'APPEND-ONLY evidence of a delegation (wave 105, lane 105A): the request, every transition, every refused transition, the dissent review. UPDATE/DELETE refused by trigger.';

-- ══════════════════════════════ PART B — indexes, triggers ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_manager_delegations_tenant_status   ON public.manager_delegations (brokerage_id, status);
CREATE INDEX IF NOT EXISTS idx_manager_delegations_mission         ON public.manager_delegations (mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manager_delegations_assigned        ON public.manager_delegations (brokerage_id, assigned_manager, status);
CREATE INDEX IF NOT EXISTS idx_manager_delegations_tenant_deadline ON public.manager_delegations (brokerage_id, deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manager_delegations_run             ON public.manager_delegations ((input_entities->>'workflow_run_id')) WHERE input_entities ? 'workflow_run_id';
CREATE INDEX IF NOT EXISTS idx_manager_delegation_events_delegation ON public.manager_delegation_events (delegation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_manager_delegation_events_correlation ON public.manager_delegation_events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manager_delegations_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.state_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manager_delegations_touch_updated_at ON public.manager_delegations;
CREATE TRIGGER manager_delegations_touch_updated_at
  BEFORE UPDATE ON public.manager_delegations
  FOR EACH ROW EXECUTE FUNCTION public.manager_delegations_touch_updated_at();

CREATE OR REPLACE FUNCTION public.manager_delegation_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'manager_delegation_events is append-only: % refused on %', TG_OP, OLD.id
    USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS manager_delegation_events_append_only ON public.manager_delegation_events;
CREATE TRIGGER manager_delegation_events_append_only
  BEFORE UPDATE OR DELETE ON public.manager_delegation_events
  FOR EACH ROW EXECUTE FUNCTION public.manager_delegation_events_append_only();
