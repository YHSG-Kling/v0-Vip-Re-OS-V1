-- add-users-communication-preferences.sql
-- Applied via Supabase migration `add_users_communication_preferences`.
--
-- lib/transactions/notification-service.ts selects users.communication_preferences to choose the
-- per-recipient notification channel (email/SMS), but the column did not exist — the select errored,
-- the profile lookup silently failed, and every recipient fell back to default channels. No other
-- per-user channel-preference store exists (no duplication) — add the backing jsonb column.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS communication_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
