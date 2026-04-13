-- Check 1: Is RLS enabled on contacts?
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'contacts';

-- Check 2: All RLS policies on contacts table
SELECT
  policyname,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'contacts'
ORDER BY policyname;

-- Check 3: Raw contacts rows for this brokerage+agent (no RLS — service role query)
-- Confirms the data exists exactly as the app query would request it
SELECT id, first_name, last_name, agent_id, brokerage_id, deleted_at
FROM contacts
WHERE brokerage_id = 'b0000000-0000-0000-0000-000000000001'
  AND agent_id     = 'c0000000-0000-0000-0000-000000000005'
  AND deleted_at IS NULL;
