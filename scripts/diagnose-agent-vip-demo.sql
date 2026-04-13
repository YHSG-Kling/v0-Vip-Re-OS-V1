-- Full identity chain diagnostic for agent@vip.demo
-- Mirrors exactly what getAgentContext() reads at runtime

-- 1. auth.users row + metadata
SELECT
  'auth.users' AS source,
  au.id        AS user_id,
  au.email,
  au.raw_user_meta_data->>'user_type' AS meta_user_type
FROM auth.users au
WHERE au.email = 'agent@vip.demo';

-- 2. users table (brokerage_id, user_type)
SELECT
  'users' AS source,
  u.id,
  u.brokerage_id,
  u.user_type
FROM users u
JOIN auth.users au ON au.id = u.id
WHERE au.email = 'agent@vip.demo';

-- 3. user_role_assignments (firstRole used by getAgentContext)
SELECT
  'user_role_assignments' AS source,
  ura.brokerage_id,
  ura.role,
  ura.agent_id
FROM user_role_assignments ura
JOIN auth.users au ON au.id = ura.user_id
WHERE au.email = 'agent@vip.demo';

-- 4. agents table (agentId fallback lookup)
SELECT
  'agents' AS source,
  a.id           AS agents_id,
  a.user_id,
  a.brokerage_id
FROM agents a
JOIN auth.users au ON au.id = a.user_id
WHERE au.email = 'agent@vip.demo';

-- 5. contacts owned by this agent (via agents.id)
SELECT
  'contacts via agents.id' AS source,
  c.id, c.first_name, c.last_name, c.agent_id, c.brokerage_id, c.deleted_at
FROM contacts c
JOIN agents a  ON a.id = c.agent_id
JOIN auth.users au ON au.id = a.user_id
WHERE au.email = 'agent@vip.demo'
ORDER BY c.first_name;
