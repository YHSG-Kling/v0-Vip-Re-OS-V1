-- Podcast Show Settings: per-agent show branding (one row per agent)
-- Persists "My Show" tab fields: show_name, host_name, description, category, language, cover_art, website
CREATE TABLE IF NOT EXISTS podcast_show_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL,
  brokerage_id  uuid NOT NULL,
  show_name     text,
  host_name     text,
  description   text,
  category      text DEFAULT 'Real Estate',
  language      text DEFAULT 'en',
  cover_art_url text,
  website_url   text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (agent_id)
);

CREATE INDEX IF NOT EXISTS idx_podcast_show_settings_agent ON podcast_show_settings(agent_id);
CREATE INDEX IF NOT EXISTS idx_podcast_show_settings_brokerage ON podcast_show_settings(brokerage_id);

ALTER TABLE podcast_show_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "podcast_show_settings_owner_select" ON podcast_show_settings;
CREATE POLICY "podcast_show_settings_owner_select"
  ON podcast_show_settings FOR SELECT
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "podcast_show_settings_owner_modify" ON podcast_show_settings;
CREATE POLICY "podcast_show_settings_owner_modify"
  ON podcast_show_settings FOR ALL
  USING (agent_id = auth.uid())
  WITH CHECK (agent_id = auth.uid());

-- Add scheduled_at to podcast_episodes for scheduled publishing
ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_scheduled_at
  ON podcast_episodes(scheduled_at)
  WHERE scheduled_at IS NOT NULL;

-- Allow 'scheduled' as a valid status for podcast_episodes (idempotent constraint update)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'podcast_episodes_status_check'
  ) THEN
    ALTER TABLE podcast_episodes DROP CONSTRAINT podcast_episodes_status_check;
  END IF;
  ALTER TABLE podcast_episodes
    ADD CONSTRAINT podcast_episodes_status_check
    CHECK (status IN ('draft','generating','processing','completed','failed','published','scheduled'));
END $$;

-- newsletter_teasers (referenced by generatePodcastNewsletterTeaser).
-- Created defensively so the action persists drafts when the table exists; if it
-- already exists in another migration this is a no-op.
CREATE TABLE IF NOT EXISTS newsletter_teasers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL,
  agent_id      uuid NOT NULL,
  source_type   text NOT NULL,
  source_id     uuid,
  content       text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sent','archived')),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_newsletter_teasers_brokerage ON newsletter_teasers(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_teasers_agent ON newsletter_teasers(agent_id);
