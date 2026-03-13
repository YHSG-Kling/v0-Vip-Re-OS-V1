-- Fix the ID mismatch between auth.users and public.users for admin@yourbrokerage.com
-- The auth.users ID is the source of truth since that's what Supabase auth uses

-- Step 1: Update public.users to use the correct auth.users ID
UPDATE public.users
SET id = 'a011f424-9fe0-4473-af2f-f6d38af046ec'
WHERE email = 'admin@yourbrokerage.com'
  AND id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a';

-- Step 2: Update user_role_assignments to use the correct user_id
UPDATE public.user_role_assignments
SET user_id = 'a011f424-9fe0-4473-af2f-f6d38af046ec'
WHERE user_id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a';

-- Step 3: Verify the fix
SELECT 
  'public.users' as table_name,
  id,
  email,
  user_type,
  brokerage_id
FROM public.users
WHERE email = 'admin@yourbrokerage.com';

SELECT 
  'user_role_assignments' as table_name,
  user_id,
  role,
  brokerage_id
FROM public.user_role_assignments
WHERE user_id = 'a011f424-9fe0-4473-af2f-f6d38af046ec';
