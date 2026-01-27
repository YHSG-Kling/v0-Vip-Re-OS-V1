-- Stored procedure for getting top contributors with stats
CREATE OR REPLACE FUNCTION get_top_contributors_with_stats()
RETURNS TABLE (
  id UUID,
  name TEXT,
  avatar_url TEXT,
  contribution_count INTEGER,
  upvotes INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.id,
    u.name,
    u.avatar_url,
    (
      SELECT COUNT(*) 
      FROM academy_content ac 
      WHERE ac.created_by = u.id
    )::INTEGER +
    (
      SELECT COUNT(*) 
      FROM template_marketplace tm 
      WHERE tm.creator_id = u.id
    )::INTEGER AS contribution_count,
    (
      SELECT COALESCE(SUM(upvotes), 0)::INTEGER
      FROM academy_content ac
      WHERE ac.created_by = u.id
    ) AS upvotes
  FROM users u
  WHERE EXISTS (
    SELECT 1 FROM academy_content ac WHERE ac.created_by = u.id
    UNION
    SELECT 1 FROM template_marketplace tm WHERE tm.creator_id = u.id
  )
  ORDER BY contribution_count DESC, upvotes DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- Function to increment view count
CREATE OR REPLACE FUNCTION increment_view_count(content_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE academy_content
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = content_id;
END;
$$ LANGUAGE plpgsql;
