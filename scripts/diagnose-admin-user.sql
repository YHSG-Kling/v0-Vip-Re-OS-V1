-- Check the admin user's data
SELECT 
  id, 
  email, 
  user_type, 
  brokerage_id,
  first_name,
  last_name
FROM public.users 
WHERE email = 'admin@yourbrokerage.com';

-- Check role assignments for admin
SELECT 
  ura.id,
  ura.user_id,
  ura.role,
  ura.brokerage_id,
  u.email
FROM user_role_assignments ura
JOIN public.users u ON u.id = ura.user_id
WHERE u.email = 'admin@yourbrokerage.com';

-- List all brokerages
SELECT id, name FROM brokerages LIMIT 5;
