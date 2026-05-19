-- Migration 1018: Usage Meter — extend metric vocabulary for media/AI usage
--
-- The existing usage_counters + plan_limits tables (script 120) cover billing
-- metrics like llm_calls, video_minutes, sms_sent, etc. The platform now
-- holds keys for D-ID Agents (live conversational avatar), ElevenLabs (voice
-- clones + TTS), and Vapi (phone calls), so we need more granular metrics to
-- attribute consumption per-customer for safe scaling on platform keys.
--
-- Strategy:
--   1. Drop the metric CHECK constraints on usage_counters + plan_limits and
--      replace them with a wider vocabulary (kept all existing metrics so
--      historical rows still satisfy the new CHECK).
--   2. Add a usage_events table — per-event records (vs the monthly counter
--      rollups) so we can attribute who/when/which-resource and surface a
--      "your top consumers this month" view.
--   3. Seed plan_limits rows for the four new media metrics across all four
--      existing plan tiers.

-- ─── 1. Replace CHECK constraints with the wider vocabulary ────────────────
-- DDL note: Postgres doesn't let you ALTER a CHECK constraint in place; we
-- have to DROP + ADD. Idempotent guards via DO blocks.

DO $$
BEGIN
  ALTER TABLE public.usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
  ALTER TABLE public.plan_limits DROP CONSTRAINT IF EXISTS plan_limits_metric_check;
END$$;

ALTER TABLE public.usage_counters
  ADD CONSTRAINT usage_counters_metric_check CHECK (metric IN (
    -- legacy (script 120)
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb',
    -- live conversational avatar (D-ID Agents WebRTC)
    'live_avatar_minutes',
    'live_avatar_sessions',
    -- ElevenLabs
    'tts_characters',
    'voice_clones_created',
    -- D-ID one-shot avatar creation (Twin Studio "Look" step)
    'avatars_created',
    -- Vapi calls — agent-driven outbound + inbound ISA calls
    'vapi_minutes'
  ));

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
    'vapi_minutes'
  ));

-- ─── 2. usage_events (per-event audit trail) ──────────────────────────────
-- usage_counters holds monthly aggregates for billing/cap checks. usage_events
-- holds one row per chargeable event for attribution: which agent, which
-- contact, which session triggered it. Used by the "top consumers" view + for
-- debugging spikes.

CREATE TABLE IF NOT EXISTS public.usage_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  team_id         uuid        REFERENCES public.teams(id)           ON DELETE SET NULL,
  agent_id        uuid        REFERENCES public.agents(id)          ON DELETE SET NULL,
  user_id         uuid        REFERENCES public.users(id)           ON DELETE SET NULL,
  -- Same vocabulary as usage_counters.metric. Kept loose (no FK / enum) so
  -- callers can log new metrics ahead of a constraint update without breaking.
  metric          text        NOT NULL,
  -- Quantity in the metric's natural unit:
  --   live_avatar_minutes  → minutes consumed
  --   tts_characters       → character count
  --   voice_clones_created → 1 per clone
  --   avatars_created      → 1 per avatar
  --   vapi_minutes         → minutes
  quantity        numeric     NOT NULL CHECK (quantity >= 0),
  -- Optional contextual references for attribution.
  contact_id      uuid        REFERENCES public.contacts(id)        ON DELETE SET NULL,
  session_ref     text,        -- D-ID session id, Vapi call id, etc.
  feature         text,        -- 'portal_widget', 'twin_studio_clone', 'isa_outbound', etc.
  -- Cost in cents at the time of the event — stored alongside so historical
  -- costs are stable even if vendor pricing changes later.
  cost_cents      integer,
  -- Free-form payload for debugging.
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_brokerage_metric_created
  ON public.usage_events(brokerage_id, metric, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_agent_created
  ON public.usage_events(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_events_contact
  ON public.usage_events(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'usage_events' AND policyname = 'Service role manages usage_events'
  ) THEN
    CREATE POLICY "Service role manages usage_events"
      ON public.usage_events FOR ALL USING (true);
  END IF;
END$$;

-- ─── 3. Seed plan_limits for the new media metrics ─────────────────────────
-- These are starting allowances per month. -1 = unlimited.
-- Tune after launch based on actual consumption patterns.

INSERT INTO public.plan_limits (plan_tier, metric, limit_value, soft_limit_threshold) VALUES
  -- Starter tier — solo agent, get-them-started
  ('starter', 'live_avatar_minutes',   30,    0.80),
  ('starter', 'live_avatar_sessions',  100,   0.80),
  ('starter', 'tts_characters',        50000, 0.80),
  ('starter', 'voice_clones_created',  3,     0.80),
  ('starter', 'avatars_created',       3,     0.80),
  ('starter', 'vapi_minutes',          60,    0.80),

  -- Professional tier — solo agent power user
  ('professional', 'live_avatar_minutes',   120,    0.80),
  ('professional', 'live_avatar_sessions',  500,    0.80),
  ('professional', 'tts_characters',        250000, 0.80),
  ('professional', 'voice_clones_created',  10,     0.80),
  ('professional', 'avatars_created',       10,     0.80),
  ('professional', 'vapi_minutes',          300,    0.80),

  -- Team tier — small brokerage, per-agent share
  ('team', 'live_avatar_minutes',   600,     0.80),
  ('team', 'live_avatar_sessions',  2500,    0.80),
  ('team', 'tts_characters',        1500000, 0.80),
  ('team', 'voice_clones_created',  50,      0.80),
  ('team', 'avatars_created',       50,      0.80),
  ('team', 'vapi_minutes',          1800,    0.80),

  -- Enterprise tier — multi-location brokerage / contracted custom usage
  ('enterprise', 'live_avatar_minutes',   -1, 0.80),
  ('enterprise', 'live_avatar_sessions',  -1, 0.80),
  ('enterprise', 'tts_characters',        -1, 0.80),
  ('enterprise', 'voice_clones_created',  -1, 0.80),
  ('enterprise', 'avatars_created',       -1, 0.80),
  ('enterprise', 'vapi_minutes',          -1, 0.80)
ON CONFLICT (plan_tier, metric) DO NOTHING;
