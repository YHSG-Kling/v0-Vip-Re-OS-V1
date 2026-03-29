-- Migration: add channel and read columns to client_portal_messages
-- channel: supports unified inbox filtering by portal, sms, email, etc.
-- read: boolean flag indicating whether the recipient has read the message

ALTER TABLE public.client_portal_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'portal',
  ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for unified inbox channel-based queries
CREATE INDEX IF NOT EXISTS idx_client_portal_messages_channel
  ON public.client_portal_messages (brokerage_id, channel, contact_id);

-- Index for unread count queries
CREATE INDEX IF NOT EXISTS idx_client_portal_messages_unread
  ON public.client_portal_messages (contact_id, read)
  WHERE read = FALSE;
