-- scripts/404-create-podcast-distribution-tables.sql
-- Creates podcast_distribution_channels and podcast_distribution_log tables.
-- Referenced by seed-podcast-generation-feature.sql and podcast studio UI.
-- Supports brokerage → team → agent hierarchy via agent_user_id + team_id scope.
-- Must run AFTER scripts/403-create-ai-podcast-generation.sql (podcast_episodes FK).

CREATE TABLE IF NOT EXISTS podcast_distribution_channels (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     UUID        REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_user_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL, -- NULL = brokerage-level
  team_id          UUID,       -- optional team-level scope
  channel_name     TEXT        NOT NULL,
  channel_type     TEXT        NOT NULL CHECK (channel_type IN (
    'spotify', 'apple_podcasts', 'google_podcasts', 'amazon_music', 'rss', 'youtube', 'custom'
  )),
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  credentials      JSONB       NOT NULL DEFAULT '{}',
  distribution_url TEXT,
  auto_distribute  BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS podcast_distribution_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     UUID        NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  channel_id     UUID        NOT NULL REFERENCES podcast_distribution_channels(id) ON DELETE CASCADE,
  brokerage_id   UUID        REFERENCES brokerages(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'success', 'failed'
  )),
  error_message  TEXT,
  distributed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_podcast_dist_channels_brokerage
  ON podcast_distribution_channels(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_podcast_dist_channels_agent
  ON podcast_distribution_channels(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_podcast_dist_log_episode
  ON podcast_distribution_log(episode_id);
CREATE INDEX IF NOT EXISTS idx_podcast_dist_log_channel
  ON podcast_distribution_log(channel_id);

-- Row-level security
ALTER TABLE podcast_distribution_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_distribution_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Brokerage members can manage their distribution channels"
  ON podcast_distribution_channels
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
      UNION
      SELECT id AS brokerage_id FROM brokerages WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "Brokerage members can view distribution logs"
  ON podcast_distribution_log
  FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
      UNION
      SELECT id AS brokerage_id FROM brokerages WHERE owner_id = auth.uid()
    )
  );
