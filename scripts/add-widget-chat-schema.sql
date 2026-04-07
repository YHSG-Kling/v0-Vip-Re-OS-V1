-- Widget Chat Schema Migration
-- Adds missing columns to chat_sessions and leads for the public website chat widget.
-- All changes are idempotent (IF NOT EXISTS / DO NOTHING patterns).

-- ──────────────────────────────────────────────────────────────────────────────
-- chat_sessions: add widget-specific columns
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS brokerage_id       uuid        REFERENCES public.brokerages(id),
  ADD COLUMN IF NOT EXISTS agent_id           uuid        REFERENCES public.agents(id),
  ADD COLUMN IF NOT EXISTS source             text        DEFAULT 'website_widget',
  ADD COLUMN IF NOT EXISTS widget_session_token text,
  ADD COLUMN IF NOT EXISTS visitor_fingerprint  text,
  ADD COLUMN IF NOT EXISTS capture_state      text        DEFAULT 'pre_capture',
  ADD COLUMN IF NOT EXISTS status             text        DEFAULT 'active';

-- Unique token index so the widget can resume sessions
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_widget_token_idx
  ON public.chat_sessions (widget_session_token)
  WHERE widget_session_token IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- leads: add assigned_owner column (referenced in spec rule 3)
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS assigned_owner text;

-- ──────────────────────────────────────────────────────────────────────────────
-- RLS: allow anonymous/service-role inserts into chat_sessions + chat_messages
-- (existing policies already cover service_role for chat_messages)
-- ──────────────────────────────────────────────────────────────────────────────
-- chat_sessions: allow widget to insert sessions (no auth required)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'chat_sessions'
      AND policyname = 'widget_insert_chat_sessions'
  ) THEN
    EXECUTE '
      CREATE POLICY widget_insert_chat_sessions
        ON public.chat_sessions
        FOR INSERT
        WITH CHECK (true)
    ';
  END IF;
END $$;

-- chat_sessions: service role can update (to update capture_state, lead_id, etc.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'chat_sessions'
      AND policyname = 'service_role_update_chat_sessions'
  ) THEN
    EXECUTE '
      CREATE POLICY service_role_update_chat_sessions
        ON public.chat_sessions
        FOR ALL
        USING (true)
        WITH CHECK (true)
    ';
  END IF;
END $$;
