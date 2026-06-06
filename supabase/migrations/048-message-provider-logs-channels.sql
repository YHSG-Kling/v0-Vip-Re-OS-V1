-- =====================================================
-- MIGRATION 048: Add ai_social_dm + portal to message_provider_logs.channel
-- =====================================================
-- Communication channels in this product, per the business rules:
--   • email         — transactional + agent → contact mail
--   • sms           — transactional SMS / agent ↔ contact texting
--   • voice         — Vapi inbound / outbound calls
--   • direct_mail   — physical mail (BatchData / printer pipeline)
--   • video         — video DMs / agent-recorded clips
--   • in_app        — push-style in-app notifications
--   • ai_social_dm  — outbound AI-authored DMs on Instagram / Facebook /
--                     LinkedIn / Twitter
--   • portal        — agent ↔ client messages inside the client portal
--                     (mirror of client_portal_messages.channel default)
--
-- GHL is NOT a channel — it's a one-way contact-data sync target.
-- The platform-sync code pushes contact updates to GHL but never sends
-- messages "through" GHL as a transport.
-- =====================================================

ALTER TABLE public.message_provider_logs
  DROP CONSTRAINT IF EXISTS message_provider_logs_channel_check;

ALTER TABLE public.message_provider_logs
  ADD CONSTRAINT message_provider_logs_channel_check
  CHECK (channel IN (
    'email', 'sms', 'voice',
    'direct_mail', 'video', 'in_app',
    'ai_social_dm', 'portal'
  ));
