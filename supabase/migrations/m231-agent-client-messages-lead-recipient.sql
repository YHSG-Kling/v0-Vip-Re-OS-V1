-- m231 — let the governed client-message loop address a LEAD recipient (not just a contact).
-- The loop was contact-centric (recipient_contact_id), so a pre-conversion lead could never
-- receive a governed, human-approved email/direct-mail touch — blocking the stale-leads ladder
-- and any AI-ISA governed lead outreach. Leads use the approved pre-consent channels only
-- (email + direct mail); approveClientMessage routes a lead recipient to the leads table.
ALTER TABLE public.agent_client_messages
  ADD COLUMN IF NOT EXISTS recipient_lead_id uuid;

CREATE INDEX IF NOT EXISTS idx_agent_client_messages_recipient_lead
  ON public.agent_client_messages(recipient_lead_id) WHERE recipient_lead_id IS NOT NULL;
