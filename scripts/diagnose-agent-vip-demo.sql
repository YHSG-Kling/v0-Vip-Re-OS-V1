-- 1. Is RLS enabled on agents table?
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'agents';

-- 2. All RLS policies on agents table
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename = 'agents'
ORDER BY policyname;

-- 3. Is RLS enabled on users table?
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'users';

-- 4. All RLS policies on users table
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename = 'users'
ORDER BY policyname;
