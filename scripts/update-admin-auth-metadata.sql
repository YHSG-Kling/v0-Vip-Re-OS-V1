-- Update auth.users raw_user_meta_data to include user_type for admin user
-- This ensures the auth metadata matches the public.users user_type

-- Update the admin user's metadata in auth.users
UPDATE auth.users
SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || '{"user_type": "admin"}'::jsonb
WHERE email = 'admin@yourbrokerage.com';

-- Verify the update
SELECT 
  id,
  email,
  raw_user_meta_data->>'user_type' as auth_user_type
FROM auth.users
WHERE email = 'admin@yourbrokerage.com';
