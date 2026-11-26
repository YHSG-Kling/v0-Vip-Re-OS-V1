-- m495 — A WELCOME MARKED 'sent' CARRIES NO PROVIDER REFERENCE, SO THE SEND CAN
--        NEVER BE PROVED.
--
-- OWNER RULING, verbatim: "the contact gets access to their portal so the welcome
-- package is getting an email from the assigned agent with portal access and in
-- the emila and in the portal a personal video from agent. the agent also gets
-- notified of the new contact and confirmation that the welcome paket was sent."
--
-- "confirmation that the welcome paket WAS SENT" is a claim about the world, and
-- `agent_client_messages` — the ONE ledger every governed client-facing message
-- rides (m189) and the ONLY thing the agent's first-touch surface
-- (app/actions/lead-handoff/pending-handoffs.ts) reads — cannot currently back it.
-- The table has status/sent_at/send_error and NOTHING that names the provider or
-- the provider's own message id. So `status='sent'` is only ever an assertion by
-- whichever code path last ran; there is no value on the row that can be taken to
-- SendGrid / Gmail / Outlook and checked, and no way to reconcile a bounce,
-- a spam-folder complaint or a silent provider drop back to the message that
-- caused it. This platform has already paid for exactly this shape once —
-- `sendNewsletterCampaign` marking rows 'sent' without sending — and the cure
-- there, as here, is that the terminal status must be written beside the
-- evidence, not instead of it.
--
-- Until this lands, lib/kernel/client-welcome.ts appends the evidence to the free
-- text `rationale` column ("| delivered via sendgrid ref <id> at <iso>"). That is
-- a stopgap and it is the wrong home: `rationale` is the human-readable WHY of a
-- proposal, it is prefix-matched by the welcome's idempotency check, and free text
-- cannot be indexed, joined against a webhook, or trusted not to be edited by an
-- approver. These columns give the evidence a real home; the writer moves onto
-- them and out of `rationale` in the same change that applies this file.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────────
--
--   sent_via_provider   — the provider that ACTUALLY carried it, in the provider's
--                         own vocabulary ('sendgrid' | 'gmail' | 'outlook' | 'lob'
--                         | 'twilio'…). Deliberately NOT constrained: it records
--                         what the egress reported, and a CHECK here would make a
--                         new provider silently unrecordable. (Compare
--                         ai_video_projects.provider_status, kept un-canonicalised
--                         for the same reason.)
--   provider_message_id — the provider's OWN reference (SendGrid x-message-id,
--                         Gmail/Outlook message id, Lob piece id). This is the
--                         value a delivery webhook arrives carrying, so it is the
--                         join key between our claim and the provider's account of
--                         events.
--   sent_confirmed_at   — when a provider ACCEPTED it, as distinct from `sent_at`,
--                         which historically also got stamped by the portal-card
--                         path where no provider is involved at all.
--
-- Every column is nullable and nothing back-fills: a historic row genuinely has no
-- provider evidence and must keep saying so. A NOT NULL default would manufacture
-- exactly the false confirmation this migration exists to end.
--
-- ── AND ONE INDEX, BECAUSE THE IDEMPOTENCY CHECK IS A TABLE SCAN ──────────────
--
-- The welcome dedupes with `.ilike("rationale", 'client_welcome_v1%')` scoped to a
-- recipient. There is no index on `recipient_contact_id` at all — the only index
-- m189 shipped is (brokerage_id, proposed_at) WHERE status='proposed', which this
-- query cannot use, and which stops covering the welcome the moment it sends. On a
-- brokerage with a real message history this runs on every single contact capture.
--
-- NOT APPLIED BY THIS AGENT. Review, then apply.

BEGIN;

ALTER TABLE public.agent_client_messages
  ADD COLUMN IF NOT EXISTS sent_via_provider   text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS sent_confirmed_at   timestamptz;

COMMENT ON COLUMN public.agent_client_messages.sent_via_provider IS
  'The provider that actually carried this message (sendgrid | gmail | outlook | lob | twilio | …), in the provider''s own vocabulary. NULL = no provider was involved (portal card) or the send predates m495. Never guessed.';

COMMENT ON COLUMN public.agent_client_messages.provider_message_id IS
  'The provider''s own message reference — the join key a delivery/bounce webhook arrives carrying. NULL means the provider returned none; it must never be fabricated.';

COMMENT ON COLUMN public.agent_client_messages.sent_confirmed_at IS
  'When a provider ACCEPTED this message. Distinct from sent_at, which is also stamped by the portal-card path where no provider exists. A status of ''sent'' with this NULL and a channel of ''email'' is an unproved claim.';

-- The welcome's idempotency read: recipient + rationale prefix. Indexing the
-- recipient turns a scan of the tenant's whole message history into a lookup;
-- the prefix match then runs over that contact's handful of rows.
CREATE INDEX IF NOT EXISTS idx_agent_client_messages_recipient_contact
  ON public.agent_client_messages (recipient_contact_id)
  WHERE recipient_contact_id IS NOT NULL;

-- Reconciling a provider webhook back to the message it belongs to.
CREATE INDEX IF NOT EXISTS idx_agent_client_messages_provider_ref
  ON public.agent_client_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;
