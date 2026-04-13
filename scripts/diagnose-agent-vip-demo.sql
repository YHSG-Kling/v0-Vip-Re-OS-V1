-- Verify: contacts.agent_id now correctly resolves to agents.id for agent@vip.demo

-- Step 1: Confirm FK now points to agents table
SELECT
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name  AS foreign_table,
  ccu.column_name AS foreign_column
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'contacts'
  AND kcu.column_name = 'agent_id';

-- Step 2: Confirm the agent@vip.demo contact rows resolve correctly
-- agents.id should match contacts.agent_id (not users.id)
SELECT
  c.id           AS contact_id,
  c.first_name,
  c.last_name,
  c.agent_id,
  a.id           AS agents_id_matches,
  au.email       AS agent_email
FROM contacts c
JOIN agents a     ON a.id = c.agent_id
JOIN auth.users au ON au.id = a.user_id
WHERE au.email = 'agent@vip.demo'
ORDER BY c.first_name;
