-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148E ──
--
-- m916 — buyer_criteria_utterances: THE BUYER'S OWN WORDS, KEPT WHOLE, BESIDE WHAT WE UNDERSTOOD
--
-- Owner ruling 9 (2026-11-01): "Buyers' words are recorded; call transcripts save to the criteria store — literal
-- wording, structured interpretation, confidence, consent; corrections keep history."
--
-- The criteria store already keeps a QUOTE per field (property_preferences.criteria_provenance, m895) and every change
-- with its reason (buyer_criteria_changes, m896). What no row kept was the WHOLE utterance — the buyer's literal lines
-- from a call transcript (buyer side only), an email, a text or a portal turn — next to what the parser made of it, how
-- confident it was, and the consent basis on which it was captured. One row per utterance; idempotent on its source (a
-- re-analysed call or a re-delivered webhook writes nothing new — UNIQUE (contact_id, source_kind, source_ref)). Each
-- change row an utterance produced carries `evidence.utterance_id`. A correction is NOT an edit of this row: it is a new
-- buyer_criteria_changes row (trigger 'corrected'), so history keeps both what was heard and what the buyer later fixed.
--
-- CONSENT IS NEVER FABRICATED: consent_basis is what the door that heard the words STATES, or a fact of the channel
-- (the buyer typed in their own portal → 'self_service_portal'; the buyer wrote to us → 'inbound_message'). A call with
-- no stated recording disclosure is NULL ("not stated"), never "consented".
--
-- Writer: lib/buyer-search/buyer-criteria.ts recordBuyerUtterance, called ONLY from lib/buyer-search/criteria-turn.ts
-- recordStatedCriteriaTurn (the one ledgered criteria writer — portal turns, inbound email/SMS, the telephony sweep in
-- lib/voice/call-analysis.ts, and the intent interface of lane 148D). Reader: loadBuyerUtterances (the buyer portal's
-- "What you've told us", app/actions/buyer-search/conversational-search.ts loadBuyerCriteriaStateAction; the agent side
-- through the tenant read policy). Service-role writes only; tenant members read their own brokerage's rows.
--
-- Until applied, the writer and reader degrade BY NAME (42P01 / PGRST205) and say so — the criteria change itself is
-- still recorded.
--
-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts (3 FKs below)
-- and scripts/check-vocabularies.ts (channel, source_kind, confidence, consent_basis); TABLE_MANAGER
-- 'buyer_criteria_utterances' -> shopping_agent (lane 148I, listed in the lane-148E notes).

CREATE TABLE IF NOT EXISTS public.buyer_criteria_utterances (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- contacts.id (the PK) — never contacts.contact_id (CLAUDE.md §3)
  contact_id            uuid        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel               text        NOT NULL
    CONSTRAINT buyer_criteria_utterances_channel_check
    CHECK (channel IN ('portal', 'mobile', 'email', 'sms', 'voice', 'ai_chat', 'agent', 'system')),
  source_kind           text        NOT NULL
    CONSTRAINT buyer_criteria_utterances_source_kind_check
    CHECK (source_kind IN ('portal_turn', 'call_transcript', 'inbound_email', 'inbound_sms', 'intent_interface', 'agent_entry', 'system_import')),
  -- the call id / provider message id / turn idempotency key — the replay anchor
  source_ref            text        NOT NULL CHECK (length(btrim(source_ref)) > 0),
  -- the buyer's literal words (buyer lines only on a labelled transcript)
  literal_text          text        NOT NULL CHECK (length(btrim(literal_text)) BETWEEN 1 AND 4000),
  -- what the parser made of it: criteria, lifestyle asks, deal-breakers, priority, gaps, passes
  interpretation        jsonb       NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT buyer_criteria_utterances_interpretation_shape CHECK (jsonb_typeof(interpretation) = 'object'),
  confidence            text        NOT NULL
    CONSTRAINT buyer_criteria_utterances_confidence_check CHECK (confidence IN ('high', 'low')),
  consent_basis         text        NULL
    CONSTRAINT buyer_criteria_utterances_consent_basis_check
    CHECK (consent_basis IS NULL OR consent_basis IN ('self_service_portal', 'inbound_message', 'call_recording_disclosure', 'agent_attested')),
  consent_ref           text        NULL,
  applied_change_count  integer     NOT NULL DEFAULT 0 CHECK (applied_change_count >= 0),
  -- users.id class (the portal user / staff user who acted) — never agents.id (CLAUDE.md §3)
  created_by_user_id    uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_criteria_utterances_source_unique UNIQUE (contact_id, source_kind, source_ref)
);

COMMENT ON TABLE public.buyer_criteria_utterances IS
  'Wave 148E (owner ruling 9): the buyer''s own words (call transcript buyer lines, email, SMS, portal turn, intent interface) kept whole beside the structured interpretation, its confidence and the consent basis (never fabricated). Writer: lib/buyer-search/buyer-criteria.ts recordBuyerUtterance via criteria-turn.ts recordStatedCriteriaTurn; changes link back through buyer_criteria_changes.evidence->>utterance_id.';

CREATE INDEX IF NOT EXISTS buyer_criteria_utterances_contact_idx
  ON public.buyer_criteria_utterances (brokerage_id, contact_id, created_at DESC);

ALTER TABLE public.buyer_criteria_utterances ENABLE ROW LEVEL SECURITY;

CREATE POLICY buyer_criteria_utterances_tenant_read ON public.buyer_criteria_utterances
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.buyer_criteria_utterances FROM authenticated, anon;
GRANT SELECT ON public.buyer_criteria_utterances TO authenticated;

-- VERIFY (read-only, after applying):
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.buyer_criteria_utterances'::regclass ORDER BY 1;
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.buyer_criteria_utterances'::regclass;
--   SELECT count(*) FROM public.buyer_criteria_utterances;   -- 0 on first apply (no backfill: utterances were never kept whole)
