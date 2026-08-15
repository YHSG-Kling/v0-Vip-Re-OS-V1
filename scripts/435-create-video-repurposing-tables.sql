-- scripts/435-create-video-repurposing-tables.sql
-- Creates video_snippets, repurposed_content_log, and repurpose_pipelines tables.
-- Column definitions are derived from the actual writers in:
--   app/actions/video-repurposing.ts (logRepurposedContent, createVideoSnippet)
--   lib/repurpose/actions.ts (createPipeline, executePipeline)
-- Must run AFTER scripts/402-create-heygen-video-generation.sql (video_projects FK).

-- ─── VIDEO SNIPPETS ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS video_snippets (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           UUID        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  source_video_asset_id  UUID,
  video_project_id       UUID,
  snippet_title          TEXT        NOT NULL,
  start_seconds          NUMERIC     NOT NULL DEFAULT 0,
  end_seconds            NUMERIC     NOT NULL,
  aspect_ratio           TEXT        NOT NULL DEFAULT '9:16' CHECK (aspect_ratio IN ('9:16','1:1','16:9','4:5')),
  platform_target        TEXT        NOT NULL CHECK (platform_target IN (
    'instagram_reels', 'instagram_story', 'instagram_post',
    'tiktok', 'youtube_shorts', 'facebook_reels', 'linkedin', 'twitter'
  )),
  caption_text           TEXT,
  hashtags               TEXT[]      DEFAULT '{}',
  thumbnail_url          TEXT,
  video_url              TEXT,
  approval_status        TEXT        NOT NULL DEFAULT 'pending' CHECK (approval_status IN (
    'pending', 'approved', 'rejected'
  )),
  created_by             UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── REPURPOSED CONTENT LOG ────────────────────────────────────────────────────
-- Status values match what logRepurposedContent() in video-repurposing.ts writes:
--   insert: status = "created"
--   (future updates may set "processing", "completed", "failed")

CREATE TABLE IF NOT EXISTS repurposed_content_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id     UUID        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  source_type      TEXT        NOT NULL,  -- 'video_project' | 'video_asset' | 'script' | 'social_post'
  source_id        UUID,
  output_type      TEXT        NOT NULL,  -- 'snippet' | 'social_post' | 'story' | 'reel'
  output_ref_table TEXT,
  output_ref_id    UUID,
  platform_target  TEXT        CHECK (platform_target IN (
    'instagram_reels', 'instagram_story', 'instagram_post',
    'tiktok', 'youtube_shorts', 'facebook_reels', 'linkedin', 'twitter'
  )),
  -- "created" is the initial insert status; processing/completed/failed are lifecycle transitions
  status           TEXT        NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'pending', 'processing', 'completed', 'failed'
  )),
  approval_status  TEXT        NOT NULL DEFAULT 'pending' CHECK (approval_status IN (
    'pending', 'approved', 'rejected'
  )),
  notes            TEXT,
  created_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── REPURPOSE PIPELINES ───────────────────────────────────────────────────────
-- Column list derived from lib/repurpose/actions.ts createPipeline() and executePipeline():
--   insert: brokerage_id, agent_user_id, team_id, pipeline_name, source_type,
--           source_content_id, output_formats, status='draft'
--   update: status='processing', started_at; status='completed', completed_at

CREATE TABLE IF NOT EXISTS repurpose_pipelines (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  team_id           UUID,
  pipeline_name     TEXT        NOT NULL,
  source_type       TEXT        NOT NULL,
  source_content_id UUID,                  -- FK to the source video/podcast/listing
  output_formats    TEXT[]      NOT NULL DEFAULT '{}',  -- e.g. ['snippet','social_post','reel']
  status            TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'processing', 'completed', 'failed', 'cancelled'
  )),
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  config            JSONB       NOT NULL DEFAULT '{}',
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEXES ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_video_snippets_brokerage       ON video_snippets(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_video_snippets_video_project   ON video_snippets(video_project_id);
CREATE INDEX IF NOT EXISTS idx_video_snippets_platform        ON video_snippets(platform_target);
CREATE INDEX IF NOT EXISTS idx_repurposed_log_brokerage       ON repurposed_content_log(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_repurposed_log_created_at      ON repurposed_content_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_brokerage  ON repurpose_pipelines(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_agent      ON repurpose_pipelines(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_created_at ON repurpose_pipelines(created_at DESC);

-- ─── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

ALTER TABLE video_snippets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE repurposed_content_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE repurpose_pipelines    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Brokerage members can manage video snippets"
  ON video_snippets
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
      UNION
      SELECT id FROM brokerages WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "Brokerage members can view repurposed content log"
  ON repurposed_content_log
  FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
      UNION
      SELECT id FROM brokerages WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "Agents manage own pipelines; admins manage all brokerage pipelines"
  ON repurpose_pipelines
  USING (
    agent_user_id = auth.uid()
    OR brokerage_id IN (
      SELECT id FROM brokerages WHERE owner_id = auth.uid()
      UNION
      SELECT brokerage_id FROM agents
        WHERE user_id = auth.uid()
        AND role IN ('broker', 'admin', 'team_lead')
    )
  );
