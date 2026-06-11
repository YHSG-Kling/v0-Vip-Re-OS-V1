-- m217: MANAGER SIGNALS — the inter-manager bus. Until now the 11 Claude managers ran
-- closed loops that handed off point-to-point (referral closer → Sphere, deal close →
-- Sphere). This makes manager-to-manager communication FIRST-CLASS: a manager PUBLISHES
-- an outcome signal; the addressed manager CONSUMES it and acts (usually by proposing a
-- governed deliverable into the gate). Every conversation between managers is recorded,
-- auditable, and surfaced on the Command Center ("managers talking").
CREATE TABLE IF NOT EXISTS public.manager_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- Who is talking to whom (manager-registry keys; enforced in code by ManagerKey).
  from_manager    text NOT NULL,
  to_manager      text NOT NULL,
  -- What happened (machine key) + the broker-readable line.
  signal_type     text NOT NULL,
  message         text NOT NULL,
  -- What the signal is about.
  entity_type     text,
  entity_id       uuid,
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Consumption: the addressed manager marks the signal handled (with what it did).
  status          text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','consumed','expired'])),
  consumed_at     timestamptz,
  consumed_action text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manager_signals_inbox
  ON public.manager_signals (brokerage_id, to_manager, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_manager_signals_recent
  ON public.manager_signals (brokerage_id, created_at DESC);
