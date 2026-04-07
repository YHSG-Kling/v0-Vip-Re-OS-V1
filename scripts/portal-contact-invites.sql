-- portal_contact_invites: tracks secure OTP invite links sent to contacts
-- for access to their client portal at /portal/[contactId]
CREATE TABLE IF NOT EXISTS public.portal_contact_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id    uuid REFERENCES public.brokerages(id),
  email           text NOT NULL,
  invite_token    text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','accepted','expired','revoked')),
  invited_by      uuid REFERENCES public.users(id),
  invited_at      timestamptz NOT NULL DEFAULT now(),
  accepted_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  portal_view     text CHECK (portal_view IN ('buyer','seller','lifetime')),
  CONSTRAINT portal_contact_invites_contact_unique UNIQUE (contact_id)
);

CREATE INDEX IF NOT EXISTS pci_token_idx   ON public.portal_contact_invites(invite_token);
CREATE INDEX IF NOT EXISTS pci_contact_idx ON public.portal_contact_invites(contact_id);

-- Enable RLS
ALTER TABLE public.portal_contact_invites ENABLE ROW LEVEL SECURITY;

-- Agents/brokers can manage invites for their contacts
CREATE POLICY pci_agent_manage ON public.portal_contact_invites
  FOR ALL USING (
    brokerage_id IN (
      SELECT brokerage_id FROM public.agents WHERE user_id = auth.uid()
    )
  );
