-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145C; a DROP TRIGGER / DROP POLICY IF EXISTS of an object that did not yet exist was skipped where the MCP would have held the batch ──
--
-- m859 — TRANSACTION / ADMIN FEES THAT THE SELLER'S AND THE BUYER'S AGREEMENTS ESTABLISH (wave 145, lane 145C).
--
-- Owner ruling 5 (2026-10-27), verbatim: "There is a transaction fee or an admin fee which will be dictated from the seller
-- and buyer agreements now which the agents fill out." Brief: who owes each fee, which agreement establishes it, payable at
-- closing or not, who receives it, whether it is already in the commission/settlement calculation, whether brokerage policy
-- permits it, whether an executed amendment changes it. Agent/team-agreement fees and buyer/seller-agreement fees are NOT
-- interchangeable; never double-count; agent-completed fields need human review and execution.
--
-- AUDIT FIRST (CLAUDE.md §1) — measured live 2026-10-27 (project hrvaqgvukzxfskkcrwbt) and in code at b364eb4b:
--   · listing_agreements.seller_transaction_fee (m286) — ONE flat amount, its writer the listing intake
--     (app/actions/seller-listing/execution-engine.ts markAgreementSigned) and six net-sheet readers. It states an amount and
--     nothing else: not who receives it, not whether it is payable at closing, not whether it is already inside the commission,
--     not whether policy permits it, not what amended it. 0 listing_agreements rows live.
--   · buyer_broker_agreements — commission_percentage / commission_flat_amount / commission_payer only: NO fee of any kind.
--     0 rows live.
--   · brokerage_fee_types / agent_commission_profiles.*_fee_* / commission_distributions 'fee' rows — the AGENT-agreement fees
--     (charged to the agent's share by stage 10). A different obligation with a different payer: never this table's job.
--   · No other client-fee store exists (grep: client_fee, admin_fee, buyer_transaction_fee — 0 hits in lib/ app/ migrations).
--   VERDICT: MISSING (the structured record) on a PARTIAL survivor (the listing intake's flat amount). The new table is the
--   ONE structured record of a client-agreement fee; listing_agreements.seller_transaction_fee stays the listing intake's
--   entry field and is READ by the one resolver (lib/commission/client-agreement-fees.ts) as an UNVERIFIED seller transaction
--   fee until a row here verifies it — the resolver never counts both (no double count), and nothing copies the column.
--
-- THE RULES THE SCHEMA HOLDS (the rest live in lib/commission/client-agreement-fees.ts):
--   · exactly ONE establishing agreement — a listing agreement (the SELLER pays) or a buyer-broker agreement (the BUYER pays);
--     the payer follows the agreement, so a seller's agreement can never bind the buyer and vice versa;
--   · the receiver is stated (brokerage | agent) — never assumed;
--   · payable_at_closing and included_in_commission are stated (NOT NULL, no default) — the two facts that decide where the fee
--     sits on the settlement and whether it may be charged at all beside the commission;
--   · status entered (an agent filled it — not yet authoritative) → verified (a finance/compliance human reviewed the executed
--     agreement; brokerage policy must permit the fee) → superseded (an executed amendment replaced it; the row is kept) | void;
--   · one live (entered|verified) fee per agreement per fee kind; an amendment SUPERSEDES the prior row (supersedes_fee_id),
--     names the executed amendment document and its effective date — the original is never edited.
--
-- RLS: finance readers of the tenant, or the agreement's own agent (m812's pattern: can_read_tenant_financials() OR
-- has_brokerage_access(brokerage_id) AND can_read_agent_books(agent_id)). Contacts, lenders and vendors match neither arm
-- (CLAUDE.md §5). No write policy: writes run on the service role after the session gate (lib/commission/client-agreement-fees.ts).
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (new table), scripts/live-tables.ts (+client_agreement_fees),
-- scripts/schema-fk-map.ts (+9 FKs), scripts/agent-fk-columns.ts (client_agreement_fees.agent_id → agents) and
-- scripts/check-vocabularies.ts (+5 IN-list CHECKs: fee_kind, payer, receiver, value_type, status). Flip line 1.

CREATE TABLE IF NOT EXISTS public.client_agreement_fees (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- the establishing agreement — exactly one
  listing_agreement_id        uuid        NULL REFERENCES public.listing_agreements(id),
  buyer_broker_agreement_id   uuid        NULL REFERENCES public.buyer_broker_agreements(id),
  -- the agreement's agent (agents.id — agents and users are disjoint, CLAUDE.md §3); the RLS book reader keys on it
  agent_id                    uuid        NULL REFERENCES public.agents(id) ON DELETE SET NULL,
  fee_kind                    text        NOT NULL CONSTRAINT client_agreement_fees_fee_kind_check CHECK (fee_kind IN ('transaction_fee', 'admin_fee')),
  payer                       text        NOT NULL CONSTRAINT client_agreement_fees_payer_check CHECK (payer IN ('seller', 'buyer')),
  receiver                    text        NOT NULL CONSTRAINT client_agreement_fees_receiver_check CHECK (receiver IN ('brokerage', 'agent')),
  value                       numeric     NOT NULL CONSTRAINT client_agreement_fees_value_positive CHECK (value > 0),
  value_type                  text        NOT NULL CONSTRAINT client_agreement_fees_value_type_check CHECK (value_type IN ('flat', 'percent_of_price')),
  payable_at_closing          boolean     NOT NULL,
  included_in_commission      boolean     NOT NULL,
  -- the brokerage's policy review: NULL = not reviewed yet; a verified fee must be permitted
  brokerage_policy_permits    boolean     NULL,
  brokerage_policy_ref        text        NULL,
  status                      text        NOT NULL DEFAULT 'entered'
    CONSTRAINT client_agreement_fees_status_check CHECK (status IN ('entered', 'verified', 'superseded', 'void')),
  effective_date              date        NOT NULL,
  entered_by                  uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  entered_at                  timestamptz NOT NULL DEFAULT now(),
  verified_by                 uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at                 timestamptz NULL,
  -- an executed amendment's revision: the fee it replaces and the executed amendment document
  supersedes_fee_id           uuid        NULL REFERENCES public.client_agreement_fees(id),
  amendment_document_id       uuid        NULL REFERENCES public.documents(id),
  notes                       text        NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_agreement_fees_one_agreement CHECK ((listing_agreement_id IS NULL) <> (buyer_broker_agreement_id IS NULL)),
  CONSTRAINT client_agreement_fees_payer_follows_agreement CHECK (
    (listing_agreement_id IS NOT NULL AND payer = 'seller') OR (buyer_broker_agreement_id IS NOT NULL AND payer = 'buyer')),
  CONSTRAINT client_agreement_fees_percent_bounded CHECK (value_type <> 'percent_of_price' OR value <= 100),
  CONSTRAINT client_agreement_fees_verified_shape CHECK (
    status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND brokerage_policy_permits IS TRUE)),
  CONSTRAINT client_agreement_fees_amendment_has_document CHECK (supersedes_fee_id IS NULL OR amendment_document_id IS NOT NULL),
  CONSTRAINT client_agreement_fees_not_self CHECK (supersedes_fee_id IS NULL OR supersedes_fee_id <> id)
);

COMMENT ON TABLE public.client_agreement_fees IS
  'm859 (wave 145, lane 145C — owner ruling 5): transaction / admin fees ESTABLISHED BY the seller''s listing agreement or the buyer''s buyer-broker agreement — payer (follows the agreement), receiver, payable at closing, already inside the commission or not, brokerage policy permission, agent-entered → human-verified, amendments supersede (never edit). Never an agent-agreement fee (those are agent_commission_profiles / brokerage_fee_types, charged by commission stage 10). ONE resolver: lib/commission/client-agreement-fees.ts.';

-- one live fee per agreement per kind (an amendment supersedes; history stays)
CREATE UNIQUE INDEX IF NOT EXISTS client_agreement_fees_one_live_per_kind
  ON public.client_agreement_fees (COALESCE(listing_agreement_id, buyer_broker_agreement_id), fee_kind)
  WHERE status IN ('entered', 'verified');
CREATE INDEX IF NOT EXISTS client_agreement_fees_listing_idx ON public.client_agreement_fees (brokerage_id, listing_agreement_id) WHERE listing_agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_agreement_fees_buyer_idx ON public.client_agreement_fees (brokerage_id, buyer_broker_agreement_id) WHERE buyer_broker_agreement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_agreement_fees_supersedes_idx ON public.client_agreement_fees (supersedes_fee_id) WHERE supersedes_fee_id IS NOT NULL;

-- the establishing agreement belongs to the same brokerage; a superseding row amends a fee of the SAME agreement and kind
CREATE OR REPLACE FUNCTION public.client_agreement_fees_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_brokerage uuid;
  v_prev public.client_agreement_fees%ROWTYPE;
BEGIN
  IF NEW.listing_agreement_id IS NOT NULL THEN
    SELECT brokerage_id INTO v_brokerage FROM public.listing_agreements WHERE id = NEW.listing_agreement_id;
  ELSE
    SELECT brokerage_id INTO v_brokerage FROM public.buyer_broker_agreements WHERE id = NEW.buyer_broker_agreement_id;
  END IF;
  IF v_brokerage IS DISTINCT FROM NEW.brokerage_id THEN
    RAISE EXCEPTION 'client_agreement_fees %: the establishing agreement is not in brokerage %', NEW.id, NEW.brokerage_id USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_fee_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.client_agreement_fees WHERE id = NEW.supersedes_fee_id;
    IF NOT FOUND OR v_prev.brokerage_id IS DISTINCT FROM NEW.brokerage_id OR v_prev.fee_kind IS DISTINCT FROM NEW.fee_kind
       OR v_prev.listing_agreement_id IS DISTINCT FROM NEW.listing_agreement_id
       OR v_prev.buyer_broker_agreement_id IS DISTINCT FROM NEW.buyer_broker_agreement_id THEN
      RAISE EXCEPTION 'client_agreement_fees %: an amendment supersedes a fee of the same agreement and kind only', NEW.id USING ERRCODE = '23514';
    END IF;
  END IF;
  -- the money terms of a VERIFIED fee are what a human reviewed: they never change in place (an amendment is a new row)
  IF TG_OP = 'UPDATE' AND OLD.status = 'verified' AND (
       NEW.value IS DISTINCT FROM OLD.value OR NEW.value_type IS DISTINCT FROM OLD.value_type OR NEW.payer IS DISTINCT FROM OLD.payer
    OR NEW.receiver IS DISTINCT FROM OLD.receiver OR NEW.payable_at_closing IS DISTINCT FROM OLD.payable_at_closing
    OR NEW.included_in_commission IS DISTINCT FROM OLD.included_in_commission OR NEW.effective_date IS DISTINCT FROM OLD.effective_date) THEN
    RAISE EXCEPTION 'client_agreement_fees %: a verified fee is changed only by an executed amendment (a new row that supersedes it)', NEW.id USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_agreement_fees_integrity ON public.client_agreement_fees;
CREATE TRIGGER client_agreement_fees_integrity
  BEFORE INSERT OR UPDATE ON public.client_agreement_fees
  FOR EACH ROW EXECUTE FUNCTION public.client_agreement_fees_integrity();

ALTER TABLE public.client_agreement_fees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_agreement_fees_tenant_select ON public.client_agreement_fees;
CREATE POLICY client_agreement_fees_tenant_select ON public.client_agreement_fees
  FOR SELECT TO authenticated
  USING (public.can_read_tenant_financials() OR (public.has_brokerage_access(brokerage_id) AND agent_id IS NOT NULL AND public.can_read_agent_books(agent_id)));

REVOKE INSERT, UPDATE, DELETE ON public.client_agreement_fees FROM authenticated, anon;
GRANT SELECT ON public.client_agreement_fees TO authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'client_agreement_fees') THEN
    RAISE EXCEPTION 'm859 postcondition: client_agreement_fees missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'client_agreement_fees' AND relrowsecurity) THEN
    RAISE EXCEPTION 'm859 postcondition: RLS is not enabled on client_agreement_fees';
  END IF;
END $$;
