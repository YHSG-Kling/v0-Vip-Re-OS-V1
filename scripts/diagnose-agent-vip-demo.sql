-- Diagnostic: trace agent@vip.demo through every identity table
-- to find where the contacts → agent link is broken.

-- Step 1: Find the auth user for agent@vip.demo
SELECT
  id             AS auth_user_id,
  email,
  raw_user_meta_data
FROM auth.users
WHERE email = 'agent@vip.demo';

-- Step 2: Find the users row for that auth user
SELECT
  u.id           AS users_id,
  u.email,
  u.user_type,
  u.brokerage_id,
  u.team_id
FROM users u
WHERE u.email = 'agent@vip.demo';

-- Step 3: Find the agents row linked to that user
SELECT
  a.id           AS agents_id,
  a.user_id,
  a.brokerage_id AS agent_brokerage_id,
  a.email        AS agent_email,
  a.full_name,
  a.status
FROM agents a
JOIN users u ON u.id = a.user_id
WHERE u.email = 'agent@vip.demo';

-- Step 4: Find contacts where agent_id = agents.id for this user
SELECT
  c.id           AS contact_id,
  c.first_name,
  c.last_name,
  c.agent_id,
  c.brokerage_id AS contact_brokerage_id,
  c.deleted_at
FROM contacts c
JOIN agents a ON a.id = c.agent_id
JOIN users  u ON u.id = a.user_id
WHERE u.email = 'agent@vip.demo';

-- Step 5: Also check contacts where user_id (direct) = the auth user id
-- (some records may have been inserted using users.id instead of agents.id)
SELECT
  c.id           AS contact_id,
  c.first_name,
  c.last_name,
  c.agent_id,
  c.brokerage_id,
  c.deleted_at,
  'agent_id_is_user_id_not_agents_id' AS diagnosis
FROM contacts c
JOIN users u ON u.id = c.agent_id
WHERE u.email = 'agent@vip.demo';

-- Step 6: Check if user_role_assignments has agent_id set
SELECT
  ura.user_id,
  ura.role,
  ura.brokerage_id,
  ura.agent_id
FROM user_role_assignments ura
JOIN users u ON u.id = ura.user_id
WHERE u.email = 'agent@vip.demo';
