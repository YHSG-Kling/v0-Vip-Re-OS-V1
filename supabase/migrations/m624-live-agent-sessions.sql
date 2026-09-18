-- =====================================================
-- MIGRATION m624: live_agent_sessions
-- ── APPLIED LIVE 2026-09-12 by the integrator (Supabase MCP apply_migration). ──
-- =====================================================
--
-- WAVE 60 LANE A — docs/live-agent-provider-recommendation-2026-09.md §3.1
-- ("Meter live minutes to the tenant"). Live D-ID Agents sessions (portal,
-- embed widget, public website — all three mint through the same
-- ensureDIDAgent/issueClientKey pair, lib/did/agents.ts) had no row of their
-- own: the portal's session-start/session-end routes wrote straight to
-- usage_events/usage_counters (lib/usage/log-media-usage.ts), which has no
-- concept of an in-progress session, no heartbeat, and nothing a sweeper can
-- close when a tab crashes or a network drops without ever calling
-- session/end. This table is that missing half — one row per live session,
-- across all three surfaces, closed either by the client's own explicit end
-- (accurate, LIVE-mode-second-derived duration) or by the cron sweeper
-- (lib/did/live-session-metering.ts sweepStaleLiveAgentSessions,
-- heartbeat-derived duration) when the client never reports back.
--
-- `surface` is CHECK-constrained to the three doors this OS actually has
-- (owner ruling wave 58: "d-id express v4 for live agent for website,
-- widget, in portal as options") — 'site' (SiteChatLauncher's iframe, same
-- app origin), 'widget' (the embeddable widget on a third-party domain,
-- both minted through /api/embed/session and told apart there by request
-- origin), 'portal' (AgentsWidget via /api/did/agents/session).
--
-- RLS: tenant READ only (staff of the brokerage, or the assigned agent).
-- No INSERT/UPDATE/DELETE policy for any authenticated role — every writer
-- (session start/heartbeat/end, the sweeper) is a service-role call
-- (lib/did/live-session-metering.ts), matching CLAUDE.md §4 ("gate first,
-- then use the service client") and the lane brief's own instruction
-- ("service writes"). The service role bypasses RLS regardless, so this is
-- documentation of intent as much as enforcement.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.live_agent_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id        UUID        REFERENCES public.agents(id) ON DELETE SET NULL,
  contact_id      UUID        REFERENCES public.contacts(id) ON DELETE SET NULL,
  surface         TEXT        NOT NULL CHECK (surface IN ('site', 'widget', 'portal')),
  did_agent_id    TEXT,
  provider        TEXT        NOT NULL DEFAULT 'did',
  status          TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'ended', 'swept')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  -- Minutes actually billed to vendor_usage_tracking for this row — set once,
  -- at close (explicit end or sweep), rounded UP to the nearest 15s the same
  -- way D-ID's own billing rounds (lib/video/realism-profile.ts
  -- roundUpToNearest15Seconds). NULL while status = 'active'.
  minutes_billed  NUMERIC,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_agent_sessions_brokerage
  ON public.live_agent_sessions (brokerage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_agent_sessions_contact
  ON public.live_agent_sessions (contact_id) WHERE contact_id IS NOT NULL;
-- The sweeper's own query: every session still marked active, oldest
-- last_seen_at first.
CREATE INDEX IF NOT EXISTS idx_live_agent_sessions_active_sweep
  ON public.live_agent_sessions (last_seen_at)
  WHERE status = 'active';

ALTER TABLE public.live_agent_sessions ENABLE ROW LEVEL SECURITY;

-- SELECT: platform admin; brokerage staff with lead-visible access; the
-- assigned agent viewing their own sessions. No portal/contact-self read —
-- this is an operational metering row, not a portal-visible feature (unlike
-- offer_intents, which the contact's own submission surfaces back to them).
CREATE POLICY live_agent_sessions_select ON public.live_agent_sessions
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
    OR (
      public.is_agent_role()
      AND agent_id IS NOT NULL
      AND agent_id = public.current_user_agent_id()
    )
  );

-- No INSERT/UPDATE/DELETE policy — every writer is the service client
-- (lib/did/live-session-metering.ts), which bypasses RLS. Deliberate: a
-- portal contact or embed visitor never gets a direct write path to a
-- billing-adjacent table.

-- scripts/live-tables.ts, scripts/schema-snapshot.ts, scripts/schema-fk-map.ts
-- and scripts/check-vocabularies.ts must be regenerated from live JSON after
-- application (CLAUDE.md §3) — this migration adds no new CHECK vocabulary
-- beyond `surface`/`status`/`provider`, which check-vocabularies.ts will pick
-- up on the next regen.
