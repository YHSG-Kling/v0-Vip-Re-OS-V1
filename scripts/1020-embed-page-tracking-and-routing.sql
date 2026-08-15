-- Migration 1020: Embed — per-page tracking + brokerage-wide lead routing
--
-- 1. embed_sessions.page_url  — stores the full URL of the page that hosted
--    the embed when the session started (not just the origin). Used by the
--    analytics view to show which pages drive the most conversations / leads.
--
-- 2. embed_widgets.routing_mode — controls how brokerage-wide embeds (where
--    agent_id IS NULL) assign inbound leads to agents.
--      'primary'    — always assigns to the agent set on the embed, or the
--                     brokerage's first active agent (original behaviour).
--      'round_robin' — cycles through all active brokerage agents in order,
--                      advancing the cursor with each captured lead so no
--                      single agent is overwhelmed.
--
-- 3. embed_widgets.last_routed_agent_id — the agent who received the most
--    recent round-robin assignment; used to determine the next recipient.

ALTER TABLE public.embed_sessions
  ADD COLUMN IF NOT EXISTS page_url text;

CREATE INDEX IF NOT EXISTS idx_embed_sessions_page_url
  ON public.embed_sessions(embed_widget_id, page_url)
  WHERE page_url IS NOT NULL;

ALTER TABLE public.embed_widgets
  ADD COLUMN IF NOT EXISTS routing_mode text NOT NULL DEFAULT 'primary'
    CHECK (routing_mode IN ('primary', 'round_robin')),
  ADD COLUMN IF NOT EXISTS last_routed_agent_id uuid
    REFERENCES public.agents(id) ON DELETE SET NULL;
