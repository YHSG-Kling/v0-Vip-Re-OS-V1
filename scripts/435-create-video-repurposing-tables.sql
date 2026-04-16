-- scripts/435-create-video-repurposing-tables.sql
-- Creates video_snippets and repurposed_content_log tables used by the
-- Omnipresence Repurposer (Layer 9.11).
-- Must run AFTER scripts/402-create-heygen-video-generation.sql (video_projects FK).

-- ─── VIDEO SNIPPETS ────────────────────────────────────────────────────────────
-- Individual short-form clips extracted from long-form video assets,
-- ready for distribution to specific social platforms.

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
-- Audit log tracking all repurpose pipeline runs and their output status.

CREATE TABLE IF NOT EXISTS repurposed_content_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  source_type     TEXT        NOT NULL,  -- 'video', 'podcast', 'blog', 'listing'
  source_id       UUID,
  output_type     TEXT        NOT NULL,  -- 'video_snippet', 'social_post', 'email', 'blog'
  output_ref_table TEXT,
  output_ref_id   UUID,
  platform_target TEXT        CHECK (platform_target IN (
    'instagram_reels', 'instagram_story', 'instagram_post',
    'tiktok', 'youtube_shorts', 'facebook_reels', 'linkedin', 'twitter'
  )),
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'completed', 'failed'
  )),
  approval_status TEXT        NOT NULL DEFAULT 'pending' CHECK (approval_status IN (
    'pending', 'approved', 'rejected'
  )),
  notes           TEXT,
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── REPURPOSE PIPELINES ───────────────────────────────────────────────────────
-- Pipeline configuration per agent/brokerage for automated repurposing.

CREATE TABLE IF NOT EXISTS repurpose_pipelines (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   UUID        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_user_id  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  pipeline_name  TEXT        NOT NULL,
  source_type    TEXT        NOT NULL,
  target_platforms TEXT[]    NOT NULL DEFAULT '{}',
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  config         JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── INDEXES ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_video_snippets_brokerage ON video_snippets(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_video_snippets_video_project_id ON video_snippets(video_project_id);
CREATE INDEX IF NOT EXISTS idx_video_snippets_platform ON video_snippets(platform_target);
CREATE INDEX IF NOT EXISTS idx_repurposed_content_log_brokerage_id ON repurposed_content_log(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_repurposed_content_log_created_at ON repurposed_content_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_brokerage_id ON repurpose_pipelines(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_agent_user_id ON repurpose_pipelines(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_created_at ON repurpose_pipelines(created_at DESC);

-- ─── ROW LEVEL SECURITY ────────────────────────────────────────────────────────

ALTER TABLE video_snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE repurposed_content_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE repurpose_pipelines ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "Brokerage members can manage repurpose pipelines"
  ON repurpose_pipelines
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
      UNION
      SELECT id FROM brokerages WHERE owner_id = auth.uid()
    )
  );
