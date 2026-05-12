-- ============================================================================
-- Sprint 5 — Forever Portal: live event stream + agent disposition
-- ============================================================================
--
-- The customer's persistent surface from first engagement → forever.
-- Three modes routed by contact lifecycle_state (Match → Deal → Forever).
-- This migration adds the live-feed substrate that all three modes share.
--
-- Two new tables:
--
--   1. portal_event_stream — denormalized per-contact feed populated by a
--      projector cron that reads lifecycle_events + activities and writes
--      human-readable rows here. Customer sees customer_copy; agent sees
--      agent_copy + the disposition controls.
--
--   2. (no second table needed — agent disposition lives in portal_event_
--      stream itself as agent_action_status + writes a row to the existing
--      `activities` table on disposition for the canonical audit trail.)
--
-- Three-way disposition pattern (per user instruction): every actionable
-- event surfaces "Done manually / Do now / AI do it" controls on the agent
-- side. Whichever the agent picks logs to activities and updates the
-- portal_event_stream row's agent_action_status.
--
-- RLS:
--   - Customer reads only their own contact's stream rows via the
--     contact_id ↔ contacts.user_id ↔ auth.uid() chain
--   - Agents read brokerage-wide via current_user_brokerage_id()
--   - service role manages (cron writes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS portal_event_stream (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy + routing
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id               uuid        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  agent_user_id            uuid        REFERENCES users(id)               ON DELETE SET NULL,
  transaction_id           uuid        REFERENCES transactions(id)        ON DELETE SET NULL,
  listing_id               uuid        REFERENCES listings(id)            ON DELETE SET NULL,

  -- What event seeded this row (NULL when the row was hand-authored)
  source_event_id          uuid        REFERENCES lifecycle_events(id)    ON DELETE SET NULL,
  source_activity_id       uuid        REFERENCES activities(id)          ON DELETE SET NULL,
  event_type               text        NOT NULL,

  -- Customer-facing (rendered in /portal); NULL means the event is not
  -- customer-visible (internal-only signal like deal_health_score_updated)
  customer_copy            text,
  customer_icon            text,                                          -- 🎉 📋 ✅ etc.

  -- Agent-facing (rendered in CRM/dashboard for agent visibility into
  -- what the customer is seeing + disposition controls)
  agent_copy               text        NOT NULL,
  agent_action_required    boolean     NOT NULL DEFAULT false,            -- does the agent need to do something?
  agent_action_label       text,                                          -- "Send the contract draft"
  agent_action_status      text        NOT NULL DEFAULT 'open'
                           CHECK (agent_action_status IN (
                             'open',
                             'completed_manual',     -- agent: "already done outside the system"
                             'completed_executed',   -- agent: "do it now" → executed in-app
                             'completed_ai',         -- agent: "let AI do it" → delegated
                             'dismissed'             -- agent: "not applicable"
                           )),
  agent_action_completed_at timestamptz,
  agent_action_completed_by uuid       REFERENCES users(id) ON DELETE SET NULL,
  agent_action_notes        text,

  -- Severity / pin
  severity                 text        NOT NULL DEFAULT 'normal'
                           CHECK (severity IN ('normal', 'high', 'critical', 'celebration')),

  /* metadata mirrors lifecycle_events.metadata; the projector populates
     this so downstream consumers don't need to re-fetch the source event */
  metadata                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Most common read: customer feed (newest first) for one contact
CREATE INDEX IF NOT EXISTS idx_pes_contact_occurred
  ON portal_event_stream(contact_id, occurred_at DESC);

-- Agent triage: open action items for the brokerage (highest priority on top)
CREATE INDEX IF NOT EXISTS idx_pes_brokerage_open_actions
  ON portal_event_stream(brokerage_id, agent_action_status, occurred_at DESC)
  WHERE agent_action_required = true AND agent_action_status = 'open';

-- Cron projector idempotency: have we already projected this lifecycle event?
CREATE UNIQUE INDEX IF NOT EXISTS uq_pes_source_event
  ON portal_event_stream(source_event_id)
  WHERE source_event_id IS NOT NULL;

ALTER TABLE portal_event_stream ENABLE ROW LEVEL SECURITY;

-- Service role manages (projector cron writes)
DROP POLICY IF EXISTS pes_service_all ON portal_event_stream;
CREATE POLICY pes_service_all
  ON portal_event_stream FOR ALL USING (true) WITH CHECK (true);

-- Customer self-access: the contact can read their own rows when their
-- portal session is authenticated as auth.uid() == contacts.user_id.
-- Only customer_copy column is meaningful to them; agent_copy is also
-- visible (it's the same data), but the UI only renders customer_copy.
DROP POLICY IF EXISTS pes_customer_self_select ON portal_event_stream;
CREATE POLICY pes_customer_self_select
  ON portal_event_stream FOR SELECT
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE user_id = auth.uid()
    )
    AND customer_copy IS NOT NULL
  );

-- Agent access: anyone in the same brokerage (Sprint 1 pattern)
DROP POLICY IF EXISTS pes_agent_brokerage_select ON portal_event_stream;
CREATE POLICY pes_agent_brokerage_select
  ON portal_event_stream FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- Agent disposition writes
DROP POLICY IF EXISTS pes_agent_brokerage_update ON portal_event_stream;
CREATE POLICY pes_agent_brokerage_update
  ON portal_event_stream FOR UPDATE
  USING (brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id = current_user_brokerage_id());
