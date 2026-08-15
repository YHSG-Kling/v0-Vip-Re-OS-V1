-- ============================================================================
-- Migration 1045 — Sprint 8: AI Negotiation Co-Pilot
-- ============================================================================
--
-- The competitor gap: every CRM stores offers + counters, but none provide a
-- composed, persisted negotiation strategy that the agent AND the customer
-- see in mirror. This kernel does. One `negotiation_strategies` row per
-- analyzed offer carries:
--
--   - agent-facing strategy (markdown, with recommended counter price,
--     win probability, rationale signals from comps + DOM + brokerage
--     intelligence + agent prior outcomes)
--   - customer-facing plain-language explanation (same data, persona-tuned)
--   - outcome tracking (was the recommendation followed? did the deal close?)
--
-- Schema is additive: the `offers` table already has parent_offer_id +
-- current_round + offer_type='counter' so we do NOT create a parallel
-- negotiation_rounds table. We point at offers.id.
--
-- Composes with:
--   Sprint 4 brokerage_intelligence (peer-pattern signals)
--   Sprint 5 portal_event_stream (offer.countered events surface strategy)
--   Sprint 6 agent_action_queue (counter-due actions composed)
--   Sprint 7 learning_modules (no_negotiation_copilot_use gap_tag wired)
-- ============================================================================

BEGIN;

-- 1. negotiation_strategies ---------------------------------------------------
CREATE TABLE IF NOT EXISTS negotiation_strategies (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,

  -- The offer (or counter) this strategy was generated for. Strategy follows
  -- the offers chain via parent_offer_id; analyze() walks back through rounds.
  offer_id                 uuid        NOT NULL REFERENCES offers(id) ON DELETE CASCADE,

  -- The agent the strategy is FOR (could be listing-side or buyer-side
  -- depending on whose offer this is). Resolves via offers.agent_id.
  agent_user_id            uuid        REFERENCES users(id) ON DELETE SET NULL,

  -- The contact whose customer-mirror this is shown to. Buyer-side strategies
  -- show to the buyer; listing-side counters show to the seller.
  contact_id               uuid        REFERENCES contacts(id) ON DELETE SET NULL,

  -- The party this strategy was authored on behalf of.
  side                     text        NOT NULL CHECK (side IN ('buyer','seller')),

  -- ── Core recommendation ─────────────────────────────────────────────────
  recommended_action       text        NOT NULL CHECK (recommended_action IN (
                                          'accept','counter','reject','walk',
                                          'request_inspection_credit','wait'
                                       )),
  recommended_counter_price numeric,           -- if action='counter'
  win_probability          numeric     CHECK (win_probability BETWEEN 0 AND 1),
  confidence               numeric     CHECK (confidence BETWEEN 0 AND 1),

  -- ── Composed signals (jsonb so we can evolve without DDL) ────────────────
  -- Examples of keys:
  --   dom_at_listing:        87
  --   list_price:            450000
  --   current_offer_price:   435000
  --   prior_counter_chain:   [{round:1, price:445000}, {round:2, price:438000}]
  --   peer_pattern_signal:   "top quartile agents counter 2-3% above last counter"
  --   agent_recent_outcomes: { closed: 8, walked: 2, avg_concessions: 4500 }
  --   buyer_persona:         "first_time_buyer"
  --   buyer_max_budget:      460000
  --   inspection_findings:   [{ severity: 'major', cost_estimate: 8000 }]
  rationale_signals        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- ── Two-sided drafted language ──────────────────────────────────────────
  agent_strategy_md        text        NOT NULL,    -- markdown for the agent
  customer_explanation_md  text,                    -- plain-language for the contact
  drafted_counter_language text,                    -- pasteable counter response

  -- ── Outcome tracking (for learning) ─────────────────────────────────────
  status                   text        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','accepted_by_agent','dismissed','superseded','outcome_recorded')),
  agent_disposition        text        CHECK (agent_disposition IN (
                                          'did_now','did_already','let_ai_do_it','dismissed'
                                       )),
  agent_disposition_at     timestamptz,
  outcome                  text        CHECK (outcome IN (
                                          'accepted','countered','rejected','withdrawn','closed','lost'
                                       )),
  outcome_recorded_at      timestamptz,

  generated_by             text        NOT NULL DEFAULT 'kernel'
                           CHECK (generated_by IN ('kernel','manual','ai')),

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- One open strategy per offer per side
CREATE UNIQUE INDEX IF NOT EXISTS uq_neg_strategy_open_per_offer_side
  ON negotiation_strategies (offer_id, side)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_neg_strategy_brokerage_status
  ON negotiation_strategies (brokerage_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_neg_strategy_agent_open
  ON negotiation_strategies (agent_user_id, status, created_at DESC)
  WHERE agent_user_id IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_neg_strategy_contact_open
  ON negotiation_strategies (contact_id, status, created_at DESC)
  WHERE contact_id IS NOT NULL AND status = 'open';

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE negotiation_strategies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ns_service_all ON negotiation_strategies;
CREATE POLICY ns_service_all ON negotiation_strategies FOR ALL USING (true) WITH CHECK (true);

-- Agent sees their own strategies
DROP POLICY IF EXISTS ns_agent_self ON negotiation_strategies;
CREATE POLICY ns_agent_self ON negotiation_strategies FOR SELECT
  USING (agent_user_id = auth.uid());

-- Contact sees strategies generated for them (the customer-mirror view)
DROP POLICY IF EXISTS ns_contact_self ON negotiation_strategies;
CREATE POLICY ns_contact_self ON negotiation_strategies FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid()));

-- Broker/admin sees all in brokerage
DROP POLICY IF EXISTS ns_broker_all ON negotiation_strategies;
CREATE POLICY ns_broker_all ON negotiation_strategies FOR SELECT
  USING (brokerage_id = current_user_brokerage_id()
         AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'));

-- Self-write (agent updates their own dispositions)
DROP POLICY IF EXISTS ns_agent_update ON negotiation_strategies;
CREATE POLICY ns_agent_update ON negotiation_strategies FOR UPDATE
  USING (agent_user_id = auth.uid())
  WITH CHECK (agent_user_id = auth.uid());

COMMIT;
