-- Pass 10 SoI: merge sphere_engagement_scores into client_engagement_scores (canonical)
-- Then expose sphere_engagement_scores as a view for backwards compatibility

-- Backfill from sphere_engagement_scores into client_engagement_scores
INSERT INTO client_engagement_scores (contact_id, agent_user_id, score, updated_at)
SELECT contact_id, agent_user_id, score, updated_at
FROM sphere_engagement_scores
ON CONFLICT (contact_id, agent_user_id) DO UPDATE
  SET score = GREATEST(excluded.score, client_engagement_scores.score),
      updated_at = NOW();

-- Drop the original table and create a view so existing code still works
DROP TABLE IF EXISTS sphere_engagement_scores;
CREATE VIEW sphere_engagement_scores AS SELECT * FROM client_engagement_scores;
