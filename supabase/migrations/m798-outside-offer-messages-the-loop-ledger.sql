-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143A; statement by statement where the MCP held a batch ──
--
-- m798 — OUTSIDE OFFER MESSAGES: THE LEDGER OF THE OUTSIDE-OFFER EMAIL LOOP (wave 143, lane 143A).
--
-- Owner (wave 143): "An offer is created in the platform and emailed to the OUTSIDE listing agent; the outside seller accepts,
-- counters or declines … A counter-back is created in the platform and ONLY the counter is sent … The platform WATCHES for the
-- email responses, uploads them into the platform and notifies the offer recipients."
--
-- AUDIT FIRST (CLAUDE.md §1): the buyer-side WATCH exists (offers.metadata.outside_listing_agent_email +
-- lib/inbound-mail/offer-intake.ts tryRouteOutboundOfferReply). It had no record of the MESSAGES: a webhook redelivery re-filed
-- the PDFs and re-belled the agent (no idempotency), nothing remembered what an email said or what the AI recommended, and the
-- outbound half did not exist as a record at all. `activities` / `lifecycle_events` are generic event logs with no unique key per
-- message; a real unique key (the idempotency rule) needs a table. This is that table — one row per email, in or out.
--
-- Keyed to the chain's ROOT offer (offer_id) with the head row the message concerns (head_offer_id). The unique index
-- (brokerage_id, offer_id, direction, message_key) is the IDEMPOTENCY rule: an inbound message is claimed once; a redelivery is a
-- 23505 the code reads as "duplicate", never a second filing.
--
-- Vocabularies are DERIVED in code from lib/offers/outside-offer-loop.ts (OUTSIDE_MESSAGE_*), and the proof asserts these CHECKs
-- equal them. Tenant isolation: brokerage_id NOT NULL, RLS tenant-read, service-role writes.
--
-- Applicable in two small parts (wave 98 rule). Idempotent.

-- ── PART 1 — table ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.outside_offer_messages (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  offer_id               uuid        NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  head_offer_id          uuid        NULL REFERENCES public.offers(id) ON DELETE SET NULL,
  direction              text        NOT NULL
    CONSTRAINT outside_offer_messages_direction_check CHECK (direction IN ('outbound', 'inbound')),
  kind                   text        NOT NULL
    CONSTRAINT outside_offer_messages_kind_check CHECK (kind IN ('offer_packet', 'counter_back', 'seller_reply')),
  message_key            text        NOT NULL,
  counterparty_email     text        NOT NULL,
  -- outbound: how the recipient was verified before anything left
  recipient_verification text        NULL
    CONSTRAINT outside_offer_messages_recipient_verification_check CHECK (recipient_verification IS NULL OR recipient_verification IN ('mls_published', 'agent_confirmed')),
  -- inbound: the receiving provider's authentication verdict for the From domain
  sender_auth            text        NULL
    CONSTRAINT outside_offer_messages_sender_auth_check CHECK (sender_auth IS NULL OR sender_auth IN ('pass', 'fail', 'unknown')),
  subject                text        NULL,
  sent_at                timestamptz NULL,
  received_at            timestamptz NULL,
  document_ids           uuid[]      NOT NULL DEFAULT '{}',
  status                 text        NOT NULL
    CONSTRAINT outside_offer_messages_status_check CHECK (status IN ('sent', 'send_failed', 'awaiting_agent', 'confirmed', 'dismissed', 'quarantined')),
  -- the AI/deterministic READING of an inbound reply — a recommendation, never a decision
  classification         text        NULL
    CONSTRAINT outside_offer_messages_classification_check CHECK (classification IS NULL OR classification IN ('acceptance', 'counter', 'decline', 'ambiguous', 'acknowledgement', 'other')),
  confidence             numeric     NULL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
  recommended_action     text        NULL
    CONSTRAINT outside_offer_messages_recommended_action_check CHECK (recommended_action IS NULL OR recommended_action IN ('record_acceptance', 'record_counter', 'record_decline', 'request_signed_document', 'request_clarification', 'review_manually', 'file_only')),
  reading                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- outbound approval (the human who approved the send)
  approved_by            uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at            timestamptz NULL,
  -- the human confirmation of an inbound reply
  resolved_by            uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at            timestamptz NULL,
  resolution             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outside_offer_messages IS
  'm798 (wave 143A): one row per email in the outside-offer loop (our buyer''s offer on another brokerage''s listing). Unique (brokerage, offer, direction, message_key) = idempotency. The reading/classification is a RECOMMENDATION; status moves to confirmed only when a person confirms it (app/actions/buyer-offer/outside-offer-loop.ts).';

-- ── PART 2 — indexes + RLS ─────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS outside_offer_messages_idempotency_uidx
  ON public.outside_offer_messages (brokerage_id, offer_id, direction, message_key);
CREATE INDEX IF NOT EXISTS outside_offer_messages_offer_idx ON public.outside_offer_messages (brokerage_id, offer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS outside_offer_messages_awaiting_idx ON public.outside_offer_messages (brokerage_id, created_at DESC) WHERE status = 'awaiting_agent';
-- the thread match looks an inbound reply's In-Reply-To up against OUR outbound message ids
CREATE INDEX IF NOT EXISTS outside_offer_messages_outbound_key_idx ON public.outside_offer_messages (brokerage_id, message_key) WHERE direction = 'outbound';

ALTER TABLE public.outside_offer_messages ENABLE ROW LEVEL SECURITY;

-- Tenant staff read their brokerage's loop (the offer's agent sees the thread on /dashboard/offers). Writes: service role only.
CREATE POLICY outside_offer_messages_tenant_read ON public.outside_offer_messages
  FOR SELECT TO authenticated
  USING (brokerage_id = public.current_user_brokerage_id());

REVOKE INSERT, UPDATE, DELETE ON public.outside_offer_messages FROM authenticated, anon;
GRANT SELECT ON public.outside_offer_messages TO authenticated;

-- After applying: regenerate scripts/schema-snapshot.ts, scripts/live-tables.ts, scripts/schema-fk-map.ts and
-- scripts/check-vocabularies.ts from the live JSON (CLAUDE.md §3) — six new CHECK vocabularies.
