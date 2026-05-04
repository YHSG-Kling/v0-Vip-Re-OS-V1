-- Portal notification bell + layout query notifications by contact_id.
-- Plan FIX/J10: portal real-time notifications need contact_id targeting so
-- agents can dispatch portal-bound notifications to specific contacts.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_contact_id
  ON public.notifications(contact_id) WHERE contact_id IS NOT NULL;

-- Realtime publication so portal bell can subscribe to INSERTs.
-- Wrapped in DO block — ALTER PUBLICATION fails if table is already a publication member.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END$$;
