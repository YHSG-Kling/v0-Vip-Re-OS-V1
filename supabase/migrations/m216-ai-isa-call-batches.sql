-- m216: AI ISA voice DIAL-BATCH gate.
-- The AI ISA can re-engage CONSENTED contacts by phone, but autonomous dialing is not
-- governed by the egress unless it goes through the One Command Center. This table is the
-- governed proposal surface: the ISA proposes a batch of eligible (TCPA-consented,
-- ISA-reengage-allowed, not-DNC, not-opted-out) contacts to call; a human approves the
-- batch; only THEN do the calls fire — and eligibility is RE-CHECKED at approval time,
-- because consent can change between propose and approve.
CREATE TABLE IF NOT EXISTS public.ai_isa_call_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  proposed_by_agent_id  uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status = ANY (ARRAY['proposed','approved','rejected','completed','cancelled'])),
  script                text,
  -- The contacts the ISA proposes to call: [{ contact_id, name, phone, propensity_score }]
  target_contacts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_count        int NOT NULL DEFAULT 0,
  -- After approval + consent re-check: how many actually dialed (consent may have changed).
  dialed_count          int,
  proposed_at           timestamptz NOT NULL DEFAULT now(),
  approved_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  completed_at          timestamptz,
  call_results          jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_isa_call_batches_pending
  ON public.ai_isa_call_batches (brokerage_id, status) WHERE status = 'proposed';
