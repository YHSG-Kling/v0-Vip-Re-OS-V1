-- WRITTEN, NOT APPLIED (wave 147, lane 147B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m892 — movement_signals: THE C9 MOVEMENT SIGNAL RECORD (wave 147, lane 147B — owner rulings 3 + 4, 2026-10-31: "Life changes
-- include divorce, probate, relocation, posts about looking for an agent — it is also a real estate event. There has to be a way to
-- gain this info accurately."). One row per observed trace that a person / property may be starting to move:
--   subject (contact | lead | raw lead | property | territory) → source → evidence → observed_at → confidence
--   (verified | reported | inferred | unknown) → event_relevance → next_action (chosen by the manager / arbiter) → outcome.
--
-- WHY A NEW TABLE (orphan doctrine §1.2 — survivors audited 2026-10-31; to_regclass('public.movement_signals') is null live):
--   · signal_reactivations is the ONE life-change responder's record of a signal it ANSWERED (two writers, contact / lead only, no
--     property / territory subject, no epistemic class, no source licence, no outcome); writing raw traces there would make the
--     arbiter's loadLifeChangeSignals read an unanswered, uncombined trace as an answered signal.
--   · motivated_seller_signals is the seller-side property store of the permit / quickList sweeps (a lead_id XOR contact_id CHECK,
--     m517): no relocation / seeking-agent / life-event relevance, no epistemic class, no outcome. It stays the sweeps' store; the
--     movement watcher READS it (lib/intent/movement-source-watcher.ts STORED_SELLER_SIGNALS_SOURCE).
--   · intelligence_signals_log / behavioral_signals are lead-intelligence / site-behaviour logs with neither the class nor the rights.
-- None can hold "how we know" as a constraint, so none can make "inferred never reads as verified" a database fact.
--
-- THE RULES THE ROW ITSELF ENFORCES (the TypeScript type and lib/intent/movement-signals.ts buildMovementSignal enforce them first;
-- these CHECKs make them true for every writer, present and future):
--   · a verified row names its authoritative reference; a reported row names who reported it and where; an INFERRED row names the
--     observations it rests on and may NOT carry a reference (an inference can never pass as a verification);
--   · divorce / probate are never inferred (no intimate inference from private behaviour);
--   · a protected proxy / an intimate event / a life stage is ALWAYS targeting_prohibited (ruling 2: stored for research, never an
--     audience, never steering, never eligibility);
--   · a raw lead, a property or a territory carries outreach 'none' (they consented to nothing); a territory carries context only.
--
-- Writer + readers: lib/intent/movement-signals.ts (recordMovementSignal → insert; evaluateMovementSubject → next_action / decision;
-- recordMovementOutcome → outcome; movementSignalsForArbiter + the combination → reads). Service-role writes only. Raw signals are a
-- LEAD-DESK read: SELECT is admitted for the tenant's members for whom public.is_lead_visible_role() is true (the DB mirror of
-- lib/auth/lead-visibility.ts LEAD_DESK_USER_TYPES — compliance_officer excluded per CLAUDE.md §5); agents read only the redacted
-- task text the manager writes for them.
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (4 FKs below) and
-- scripts/check-vocabularies.ts (subject_type, source_kind, confidence, identity_match, event_relevance, side, captured_by,
-- sensitivity, outreach, next_action, outcome), and add TABLE_MANAGER 'movement_signals' -> data_steward (lane 147I).

CREATE TABLE IF NOT EXISTS public.movement_signals (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- the subject: exactly one shape (a signal about a deleted person goes with the person)
  subject_type          text        NOT NULL
    CONSTRAINT movement_signals_subject_type_check CHECK (subject_type IN ('contact', 'lead', 'raw_lead', 'property', 'territory')),
  contact_id            uuid        NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  lead_id               uuid        NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  raw_lead_id           uuid        NULL REFERENCES public.raw_scraped_leads(id) ON DELETE CASCADE,
  property_address_key  text        NULL,
  property_address      text        NULL,
  territory_key         text        NULL,
  -- the source (lib/intent/movement-source-registry.ts MOVEMENT_SIGNAL_SOURCES key) and its kind
  source_key            text        NOT NULL,
  source_kind           text        NOT NULL
    CONSTRAINT movement_signals_source_kind_check
    CHECK (source_kind IN ('first_party_behaviour', 'property_public_record', 'public_post', 'provider_observation', 'community_market_event')),
  -- how we know
  confidence            text        NOT NULL
    CONSTRAINT movement_signals_confidence_check CHECK (confidence IN ('verified', 'reported', 'inferred', 'unknown')),
  identity_match        text        NOT NULL
    CONSTRAINT movement_signals_identity_match_check CHECK (identity_match IN ('record_key', 'verified_match', 'name_only', 'none')),
  -- what it bears on
  event_relevance       text        NOT NULL
    CONSTRAINT movement_signals_event_relevance_check
    CHECK (event_relevance IN ('divorce', 'probate_estate', 'relocation', 'seeking_agent', 'life_stage', 'property_event', 'market_event', 'community_change')),
  intents               text[]      NOT NULL DEFAULT '{}',
  side                  text        NOT NULL DEFAULT 'unknown'
    CONSTRAINT movement_signals_side_check CHECK (side IN ('buyer', 'seller', 'both', 'unknown')),
  -- the evidence: { confidence, summary, reference{kind,id,url,retrievedAt,quote} | reportedBy | basis[] + method | reason, fields[] }
  evidence              jsonb       NOT NULL,
  observed_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  captured_by           text        NOT NULL
    CONSTRAINT movement_signals_captured_by_check CHECK (captured_by IN ('automation', 'staff', 'person')),
  sensitivity           text        NOT NULL
    CONSTRAINT movement_signals_sensitivity_check
    CHECK (sensitivity IN ('intimate_service_topic', 'protected_proxy', 'behaviour', 'property_fact', 'market_context')),
  protected_proxy       boolean     NOT NULL DEFAULT false,
  targeting_prohibited  boolean     NOT NULL DEFAULT false,
  -- the source's licence / storage / cost posture AT THE RECORD: { collection, storage, terms, costClass, status }
  data_rights           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outreach              text        NOT NULL
    CONSTRAINT movement_signals_outreach_check CHECK (outreach IN ('none', 'email_mail_only', 'consent_gated', 'address_correction_only')),
  idempotency_key       text        NOT NULL,
  -- chosen by the manager / arbiter (never by the source)
  next_action           text        NULL
    CONSTRAINT movement_signals_next_action_check CHECK (next_action IS NULL OR next_action IN ('research', 'offer_help', 'wait', 'human')),
  decided_by            text        NULL,
  decided_at            timestamptz NULL,
  decision              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- what actually happened (closes the loop: lib/intent/movement-signals.ts movementSourceWeights)
  outcome               text        NULL
    CONSTRAINT movement_signals_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('listed', 'purchased', 'moved', 'appointment', 'engaged', 'declined', 'no_change', 'false_positive', 'opted_out')),
  outcome_at            timestamptz NULL,
  outcome_evidence      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT movement_signals_idempotency_unique UNIQUE (brokerage_id, idempotency_key),
  CONSTRAINT movement_signals_subject_shape CHECK (
       (subject_type = 'contact'   AND contact_id IS NOT NULL AND lead_id IS NULL AND raw_lead_id IS NULL)
    OR (subject_type = 'lead'      AND lead_id IS NOT NULL AND contact_id IS NULL AND raw_lead_id IS NULL)
    OR (subject_type = 'raw_lead'  AND raw_lead_id IS NOT NULL AND contact_id IS NULL AND lead_id IS NULL)
    OR (subject_type = 'property'  AND property_address_key IS NOT NULL AND contact_id IS NULL AND lead_id IS NULL AND raw_lead_id IS NULL)
    OR (subject_type = 'territory' AND territory_key IS NOT NULL AND contact_id IS NULL AND lead_id IS NULL AND raw_lead_id IS NULL)
  ),
  -- THE EPISTEMIC RULE (inferred never reads as verified)
  CONSTRAINT movement_signals_verified_shape CHECK (confidence <> 'verified' OR (evidence ? 'reference')),
  CONSTRAINT movement_signals_reported_shape CHECK (confidence <> 'reported' OR (evidence ? 'reference' AND evidence ? 'reportedBy')),
  CONSTRAINT movement_signals_inferred_shape CHECK (confidence <> 'inferred' OR (evidence ? 'basis' AND NOT (evidence ? 'reference'))),
  -- NO INTIMATE INFERENCE
  CONSTRAINT movement_signals_no_intimate_inference CHECK (NOT (event_relevance IN ('divorce', 'probate_estate') AND confidence IN ('inferred', 'unknown'))),
  -- PROTECTED / INTIMATE / LIFE STAGE → never targeting
  CONSTRAINT movement_signals_targeting_prohibited CHECK (NOT (protected_proxy OR event_relevance IN ('divorce', 'probate_estate', 'life_stage')) OR targeting_prohibited),
  -- consented to nothing → no outreach; a territory is context only
  CONSTRAINT movement_signals_outreach_by_subject CHECK (subject_type NOT IN ('raw_lead', 'property', 'territory') OR outreach = 'none'),
  CONSTRAINT movement_signals_territory_context CHECK (subject_type <> 'territory' OR event_relevance IN ('market_event', 'community_change')),
  CONSTRAINT movement_signals_decided_shape CHECK (next_action IS NULL OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT movement_signals_outcome_shape CHECK (outcome IS NULL OR outcome_at IS NOT NULL)
);

COMMENT ON TABLE public.movement_signals IS
  'Wave 147 (147B, owner rulings 3 + 4, contract C9): one observed movement trace per row — subject, source, evidence, observed_at, confidence (verified/reported/inferred/unknown, enforced by CHECK), event relevance, the manager''s next action, the outcome. Writer lib/intent/movement-signals.ts; lead-desk read only.';

CREATE INDEX IF NOT EXISTS movement_signals_contact_idx
  ON public.movement_signals (brokerage_id, contact_id, observed_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movement_signals_lead_idx
  ON public.movement_signals (brokerage_id, lead_id, observed_at DESC) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movement_signals_territory_idx
  ON public.movement_signals (brokerage_id, territory_key, observed_at DESC) WHERE territory_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS movement_signals_open_idx
  ON public.movement_signals (brokerage_id, observed_at) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS movement_signals_learning_idx
  ON public.movement_signals (brokerage_id, source_key) WHERE outcome IS NOT NULL;

ALTER TABLE public.movement_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY movement_signals_lead_desk_read ON public.movement_signals
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id() AND public.is_lead_visible_role());

REVOKE INSERT, UPDATE, DELETE ON public.movement_signals FROM authenticated, anon;
GRANT SELECT ON public.movement_signals TO authenticated;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.movement_signals'::regclass ORDER BY 1;   -- 22 named constraints + pkey + 4 fkeys
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.movement_signals'::regclass;                 -- movement_signals_lead_desk_read
--   -- the epistemic rule, refused by the database (must ERROR 23514):
--   -- INSERT INTO public.movement_signals (brokerage_id, subject_type, territory_key, source_key, source_kind, confidence, identity_match,
--   --   event_relevance, evidence, observed_at, captured_by, sensitivity, outreach, idempotency_key)
--   -- VALUES ('<a brokerage id>', 'territory', 'zip:00000', 'cm_rate_move', 'community_market_event', 'inferred', 'none', 'market_event',
--   --   '{"reference":{"id":"x"}}', now(), 'automation', 'market_context', 'none', 'verify-only');
--   SELECT count(*) FROM public.movement_signals;   -- 0 on first apply (no backfill: the watcher's baseline poll seeds item state only)
