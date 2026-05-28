-- Add team_id scope to video_templates
ALTER TABLE video_templates
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_video_templates_team_id ON video_templates(team_id);

COMMENT ON COLUMN video_templates.team_id IS 'If set, template is scoped to this team. Null + null agent_id = brokerage-wide.';
