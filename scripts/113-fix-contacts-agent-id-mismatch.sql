-- Migration 113: Fix contacts.agent_id mismatch
-- Problem: contacts were seeded with agent_id = users.id instead of agents.id
-- The contacts and dashboard queries join contacts.agent_id → agents.id,
-- so contacts seeded with users.id are invisible to agents on the dashboard.
--
-- This UPDATE corrects every row where contacts.agent_id points to a users.id
-- that has a corresponding agents row — replacing it with the correct agents.id.
-- Scoped by brokerage_id to ensure isolation.

BEGIN;

-- Preview first: show what will be updated
SELECT
  c.id            AS contact_id,
  c.first_name,
  c.last_name,
  c.agent_id      AS current_agent_id,
  a.id            AS correct_agents_id,
  c.brokerage_id
FROM contacts c
JOIN agents a ON a.user_id = c.agent_id   -- c.agent_id matches users.id
WHERE c.agent_id NOT IN (SELECT id FROM agents)  -- confirms it's not already an agents.id
  AND c.agent_id IN (SELECT user_id FROM agents); -- confirms it resolves via user_id

-- Apply the fix
UPDATE contacts c
SET agent_id = a.id
FROM agents a
WHERE a.user_id = c.agent_id              -- current agent_id is a users.id
  AND c.agent_id NOT IN (SELECT id FROM agents)  -- not already a valid agents.id
  AND c.agent_id IN (SELECT user_id FROM agents) -- is a valid users.id with an agents row
  AND c.brokerage_id = a.brokerage_id;    -- brokerage isolation — never cross-brokerage

-- Confirm results
SELECT COUNT(*) AS contacts_fixed FROM contacts
WHERE agent_id IN (SELECT id FROM agents);

COMMIT;
