-- m230 — let the governed client-message loop PROPOSE a direct-mail touch.
-- The reactivation cadences (and the new stale-leads ladder) need direct mail as a
-- first-class, human-approved channel — not just the fire-and-forget orchestrate*Send path.
-- On approval, approveClientMessage resolves the deliverable mailing address and dispatches the
-- preset (carried as subject 'preset:<id>') through the existing Lob orchestrator.
ALTER TABLE public.agent_client_messages
  DROP CONSTRAINT IF EXISTS agent_client_messages_channel_check;

ALTER TABLE public.agent_client_messages
  ADD CONSTRAINT agent_client_messages_channel_check
  CHECK (channel = ANY (ARRAY['portal'::text, 'portal_push'::text, 'email'::text, 'sms'::text, 'voice_drop'::text, 'direct_mail'::text]));
