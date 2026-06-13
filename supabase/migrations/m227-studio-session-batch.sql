-- m227: Studio Session Batch
-- Persists a planned-but-not-yet-rendered BATCH of video reels commissioned in one
-- "studio session" voice command (e.g. "book me a week of content"). Each session
-- links to N ai_video_projects rows (via ai_video_projects.studio_session_id) staged
-- at pending_review — nothing auto-publishes.

-- 1. The studio_sessions anchor row ------------------------------------------
CREATE TABLE IF NOT EXISTS studio_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid NOT NULL REFERENCES brokerages(id)  ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  spoken_command text NOT NULL,
  duration_label text NOT NULL DEFAULT 'week',  -- "week" | "month" | custom label
  plan           jsonb NOT NULL DEFAULT '[]',    -- the batch plan items (raw planner output)
  commissioned_count integer NOT NULL DEFAULT 0,
  skipped_count      integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'planned'
                   CONSTRAINT studio_session_status_chk
                   CHECK (status IN ('planned','commissioned','partial','failed')),
  session_key    text,                           -- idempotency key (agent×date×label)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Unique idempotency: one active session per (brokerage, agent, session_key).
-- NULL keys are excluded (UNIQUE NULLS NOT DISTINCT requires PG15; guard in app).
CREATE UNIQUE INDEX IF NOT EXISTS studio_sessions_idempotency_key
  ON studio_sessions (brokerage_id, agent_id, session_key)
  WHERE session_key IS NOT NULL;

-- 2. Link ai_video_projects rows back to their studio session -----------------
ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS studio_session_id uuid
    REFERENCES studio_sessions(id) ON DELETE SET NULL;

-- Index for "give me all reels in this session" query
CREATE INDEX IF NOT EXISTS ai_video_projects_studio_session_idx
  ON ai_video_projects (studio_session_id)
  WHERE studio_session_id IS NOT NULL;
