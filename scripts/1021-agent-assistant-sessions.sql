-- Migration 1021: Track B — Agent's on-the-go AI assistant
--
-- Stand up the data + cap layer for an ElevenLabs Conversational AI assistant
-- that lives behind the floating mic FAB on every staff page. The assistant is
-- voice-first: real-time turn-taking via ElevenLabs Conv AI, with tool calls
-- back to our /api/agent-assistant/tool-call endpoint to drive CRM operations
-- (lookup contact, log activity, schedule appointment, send message, etc.).
--
-- All writes still go through kernel-OS (TCPA + brand voice + compliance) — the
-- assistant is just a voice front-end on the same compliance pipeline that the
-- text chat assistant uses.
--
-- Provisioned-once-per-real-estate-agent: agents.conv_ai_agent_id caches the
-- ElevenLabs agent_id so we don't re-provision on every session.

-- ─── Cache the per-agent ElevenLabs Conv AI agent_id ─────────────────────────
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS conv_ai_agent_id text;

-- ─── Sessions: one row per FAB-tap → assistant call ──────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_assistant_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id                 uuid        REFERENCES public.agents(id) ON DELETE SET NULL,
  user_id                  uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- ElevenLabs conversation_id — surfaced when the assistant connects.
  -- Used by the tool-call webhook to attribute the call to this session row.
  conversation_id          text        UNIQUE,

  -- Page-context the staff member was on when they started the session.
  -- Lets the assistant pre-load "the contact you're looking at" without naming.
  context_url              text,
  context_contact_id       uuid        REFERENCES public.contacts(id)     ON DELETE SET NULL,
  context_listing_id       uuid        REFERENCES public.listings(id)     ON DELETE SET NULL,
  context_transaction_id   uuid        REFERENCES public.transactions(id) ON DELETE SET NULL,

  -- Audit telemetry
  duration_seconds         integer     DEFAULT 0,
  message_count            integer     DEFAULT 0,
  tool_call_count          integer     DEFAULT 0,
  ended_reason             text        CHECK (ended_reason IS NULL OR ended_reason IN (
                                          'user_ended',
                                          'timeout',
                                          'cap_reached',
                                          'error',
                                          'disconnected'
                                        )),

  started_at               timestamptz NOT NULL DEFAULT now(),
  ended_at                 timestamptz,
  metadata                 jsonb       DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agent_assistant_sessions_user
  ON public.agent_assistant_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_assistant_sessions_brokerage_started
  ON public.agent_assistant_sessions(brokerage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_assistant_sessions_conversation
  ON public.agent_assistant_sessions(conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE public.agent_assistant_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename='agent_assistant_sessions'
                 AND policyname='Service role manages agent_assistant_sessions') THEN
    CREATE POLICY "Service role manages agent_assistant_sessions"
      ON public.agent_assistant_sessions FOR ALL USING (true);
  END IF;
END$$;

-- ─── Tool-call audit log ─────────────────────────────────────────────────────
-- Every tool the assistant invokes during a session is logged for compliance,
-- debugging, and "what did my AI do today?" review.
CREATE TABLE IF NOT EXISTS public.agent_assistant_tool_calls (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES public.agent_assistant_sessions(id) ON DELETE CASCADE,
  tool_name       text        NOT NULL,
  tool_input      jsonb       DEFAULT '{}'::jsonb,
  tool_output     jsonb       DEFAULT '{}'::jsonb,
  success         boolean     NOT NULL DEFAULT true,
  error_message   text,
  latency_ms      integer,
  ts              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_assistant_tool_calls_session
  ON public.agent_assistant_tool_calls(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_assistant_tool_calls_tool
  ON public.agent_assistant_tool_calls(tool_name, ts DESC);

ALTER TABLE public.agent_assistant_tool_calls ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename='agent_assistant_tool_calls'
                 AND policyname='Service role manages agent_assistant_tool_calls') THEN
    CREATE POLICY "Service role manages agent_assistant_tool_calls"
      ON public.agent_assistant_tool_calls FOR ALL USING (true);
  END IF;
END$$;

-- ─── Add the live_assistant_minutes metric to the usage system ───────────────
-- Mirrors the live_avatar_minutes pattern from script 1018. Counted per
-- minute-of-conversation; rolled up via usage_counters for cap enforcement.

ALTER TABLE public.usage_counters
  DROP CONSTRAINT IF EXISTS usage_counters_metric_check;

ALTER TABLE public.usage_counters
  ADD CONSTRAINT usage_counters_metric_check CHECK (metric IN (
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb',
    'live_avatar_minutes',
    'live_avatar_sessions',
    'tts_characters',
    'voice_clones_created',
    'avatars_created',
    'vapi_minutes',
    -- NEW: agent's on-the-go assistant
    'live_assistant_minutes',
    'live_assistant_sessions'
  ));

ALTER TABLE public.plan_limits
  DROP CONSTRAINT IF EXISTS plan_limits_metric_check;

ALTER TABLE public.plan_limits
  ADD CONSTRAINT plan_limits_metric_check CHECK (metric IN (
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb',
    'live_avatar_minutes',
    'live_avatar_sessions',
    'tts_characters',
    'voice_clones_created',
    'avatars_created',
    'vapi_minutes',
    'live_assistant_minutes',
    'live_assistant_sessions'
  ));

-- Seed default caps for the new metrics across all tiers. Tier names align
-- with the canonical subscription_tiers.tier_name vocabulary:
--   solo_agent | team | brokerage | multi_location
-- multi_location gets unlimited (-1). Note: when this migration ran originally
-- the live DB still used the legacy starter/professional/team/enterprise vocab;
-- script 1023 renames those rows. Anyone re-applying this script in order on
-- a fresh DB should pre-apply 1023's tier-vocab migration first.
INSERT INTO public.plan_limits (plan_tier, metric, limit_value)
VALUES
  ('solo_agent',     'live_assistant_minutes',   60),
  ('team',           'live_assistant_minutes',  300),
  ('brokerage',      'live_assistant_minutes', 1500),
  ('multi_location', 'live_assistant_minutes',   -1),
  ('solo_agent',     'live_assistant_sessions',  60),
  ('team',           'live_assistant_sessions', 300),
  ('brokerage',      'live_assistant_sessions',1500),
  ('multi_location', 'live_assistant_sessions',  -1)
ON CONFLICT (plan_tier, metric) DO NOTHING;
