-- Migration 1003: Public slug for agents (used in shareable home-value page URLs)
-- Slug auto-generated from name on insert; agent can customize later.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS public_slug TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_agents_public_slug ON agents(public_slug);

-- Backfill slugs for existing agents using their first/last name
UPDATE agents a
SET public_slug = LOWER(
  REGEXP_REPLACE(
    COALESCE(u.first_name, '') || '-' || COALESCE(u.last_name, '') || '-' || SUBSTR(a.id::text, 1, 6),
    '[^a-zA-Z0-9-]', '', 'g'
  )
)
FROM users u
WHERE a.user_id = u.id
  AND a.public_slug IS NULL;
