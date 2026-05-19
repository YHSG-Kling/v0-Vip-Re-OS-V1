-- Migration 1019: Embed Widget — agent's AI twin embedded on external sites
--
-- Brokerage admin / team lead / agent configures an embed → gets a copy-paste
-- <script> snippet → drops it on their website. Visitors interact with the
-- agent's twin (text by default, "Talk live" optionally). Identified visitors
-- become contacts in the CRM with source='widget'.

CREATE TABLE IF NOT EXISTS public.embed_widgets (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id          uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- Owner agent. NULL = brokerage-wide embed (uses brokerage's default twin owner).
  agent_id              uuid        REFERENCES public.agents(id) ON DELETE CASCADE,
  team_id               uuid        REFERENCES public.teams(id)  ON DELETE SET NULL,

  -- Public, URL-safe id used in <script src="…/embed/twin.js?id=<public_id>">.
  -- Random 16-char base62 — non-guessable but human-friendly.
  public_id             text        UNIQUE NOT NULL
                          DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 16),

  -- Identity
  label                 text        NOT NULL DEFAULT 'My Website',
  -- Which twin handles conversations on this embed. NULL = use the agent's
  -- default twin at session boot (resolved live). Locked to this twin when set
  -- so brokerages can require a specific approved twin.
  default_twin_id       uuid        REFERENCES public.agent_avatar_assets(id) ON DELETE SET NULL,

  -- Behavior
  welcome_message       text        DEFAULT 'Hi! I''m here to help you with anything real estate. Ask me a question or tap "Talk live" to chat face-to-face.',
  -- Modes the visitor can use. Text always cheapest; live burns avatar minutes.
  enabled_modes         text[]      NOT NULL DEFAULT ARRAY['text']::text[],
  lead_capture_mode     text        NOT NULL DEFAULT 'after_first_message'
                          CHECK (lead_capture_mode IN ('immediate', 'after_first_message', 'optional')),
  -- Which fields to require from the visitor when capturing them as a contact.
  lead_capture_fields   text[]      NOT NULL DEFAULT ARRAY['first_name','email']::text[],

  -- D-ID client_keys are origin-locked; we enforce too at the server side.
  -- One row per allowed origin (https://example.com), no trailing slash.
  allowed_domains       text[]      NOT NULL DEFAULT ARRAY[]::text[],

  -- Style — small JSONB blob the iframe reads to render the bubble.
  style                 jsonb       NOT NULL DEFAULT '{
    "bubble_color": "#0066ff",
    "text_color": "#ffffff",
    "position": "bottom-right",
    "button_text": "Chat with me",
    "size": "compact"
  }'::jsonb,

  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embed_widgets_public_id   ON public.embed_widgets(public_id);
CREATE INDEX IF NOT EXISTS idx_embed_widgets_brokerage   ON public.embed_widgets(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_embed_widgets_agent       ON public.embed_widgets(agent_id) WHERE agent_id IS NOT NULL;

ALTER TABLE public.embed_widgets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='embed_widgets' AND policyname='Service role manages embed_widgets') THEN
    CREATE POLICY "Service role manages embed_widgets" ON public.embed_widgets FOR ALL USING (true);
  END IF;
END$$;

-- ─── Contact attribution: embed_widget_id on contacts + activities ────────
-- When a visitor identifies themselves on an embed, we create a contact with
-- source='widget'. Track which embed referred them so we can show "leads from
-- this embed" attribution + measure conversion per-embed.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS embed_widget_id uuid REFERENCES public.embed_widgets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_embed_widget
  ON public.contacts(embed_widget_id) WHERE embed_widget_id IS NOT NULL;

-- ─── Visitor sessions (anon-friendly) ──────────────────────────────────────
-- Tracks one row per visitor's bubble open → close. Keyed by a
-- client-generated visitor_id (cookie/localStorage UUID). Once the visitor
-- captures their info, contact_id is filled in.

CREATE TABLE IF NOT EXISTS public.embed_sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  embed_widget_id   uuid        NOT NULL REFERENCES public.embed_widgets(id) ON DELETE CASCADE,
  brokerage_id      uuid        NOT NULL REFERENCES public.brokerages(id)    ON DELETE CASCADE,
  visitor_id        text        NOT NULL,        -- client-generated UUID, persists in localStorage
  contact_id        uuid        REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- Page that hosted the embed when the session started.
  origin            text,
  referrer          text,
  user_agent        text,
  ip_address        text,
  -- D-ID Agent session id once the visitor activates Live mode.
  did_session_ref   text,
  message_count     integer     NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  -- Free-form payload for debugging.
  metadata          jsonb       DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_embed_sessions_widget    ON public.embed_sessions(embed_widget_id);
CREATE INDEX IF NOT EXISTS idx_embed_sessions_visitor   ON public.embed_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_embed_sessions_contact   ON public.embed_sessions(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.embed_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='embed_sessions' AND policyname='Service role manages embed_sessions') THEN
    CREATE POLICY "Service role manages embed_sessions" ON public.embed_sessions FOR ALL USING (true);
  END IF;
END$$;
