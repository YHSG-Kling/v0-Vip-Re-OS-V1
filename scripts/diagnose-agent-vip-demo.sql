-- Check: what does contacts_agent_id_fkey point to?
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

-- Also check what the demo contact's agent_id resolves to
SELECT
  c.id,
  c.agent_id,
  -- Check if it's in agents table
  (SELECT id FROM agents WHERE id = c.agent_id LIMIT 1) AS resolves_to_agents,
  -- Check if it's in users table
  (SELECT id FROM users WHERE id = c.agent_id LIMIT 1) AS resolves_to_users
FROM contacts c
WHERE c.brokerage_id = 'b0000000-0000-0000-0000-000000000001';
