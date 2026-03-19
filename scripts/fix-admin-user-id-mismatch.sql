-- Fix the ID mismatch between auth.users and public.users for admin@yourbrokerage.com
-- The auth.users ID is the source of truth since that's what Supabase auth uses

-- Step 1: Store the brokerage_id before deleting
CREATE TEMP TABLE admin_brokerage_backup AS
SELECT brokerage_id FROM public.users
WHERE email = 'admin@yourbrokerage.com' AND id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a';

-- Step 2: Delete the old user_role_assignments records (this is safe to do first)
DELETE FROM public.user_role_assignments
WHERE user_id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a';

-- Step 3: Update public.users to use the correct auth.users ID
UPDATE public.users
SET id = 'a011f424-9fe0-4473-af2f-f6d38af046ec'
WHERE email = 'admin@yourbrokerage.com'
  AND id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a';

-- Step 4: Re-insert user_role_assignments with the correct user_id
INSERT INTO public.user_role_assignments (user_id, brokerage_id, role)
SELECT 'a011f424-9fe0-4473-af2f-f6d38af046ec', brokerage_id, 'admin'
FROM admin_brokerage_backup;

-- Step 5: Verify the fix
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

