-- Migration 1008: Objection-training practice sessions

CREATE TABLE IF NOT EXISTS objection_training_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id    UUID REFERENCES brokerages(id) ON DELETE SET NULL,
  scenario_key    TEXT NOT NULL,
  scenario_label  TEXT NOT NULL,
  persona         TEXT,
  difficulty      TEXT CHECK (difficulty IN ('easy','medium','hard')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','abandoned')),
  total_score     NUMERIC(5,2),
  summary         TEXT,
  strengths       TEXT[],
  improvements    TEXT[],
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_objection_training_sessions_agent ON objection_training_sessions(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_objection_training_sessions_brokerage ON objection_training_sessions(brokerage_id);
ALTER TABLE objection_training_sessions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS objection_training_turns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES objection_training_sessions(id) ON DELETE CASCADE,
  turn_index  INT NOT NULL,
  speaker     TEXT NOT NULL CHECK (speaker IN ('prospect','agent')),
  text        TEXT NOT NULL,
  audio_url   TEXT,
  turn_score  NUMERIC(5,2),
  feedback    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_objection_training_turns_session ON objection_training_turns(session_id);
ALTER TABLE objection_training_turns ENABLE ROW LEVEL SECURITY;
