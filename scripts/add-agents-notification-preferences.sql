-- add-agents-notification-preferences.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Applied via Supabase migration `add_agents_notification_preferences`.
--
-- The per-agent notification/reputation preferences feature
-- (app/actions/settings/reputation-preferences.ts — review auto-respond mode + approval hours, read
-- by the AI review-automation manager) read/wrote agents.notification_preferences, but the column did
-- not exist — every save silently errored and the setting never persisted. No other table stores these
-- prefs (verified: no duplication), so the fix is to add the backing column.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
