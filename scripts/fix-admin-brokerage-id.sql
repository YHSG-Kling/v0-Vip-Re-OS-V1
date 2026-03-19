-- Fix brokerage_id in user_role_assignments for admin user
UPDATE public.user_role_assignments
SET brokerage_id = '231f4e64-5022-4752-8047-696886551c35'
WHERE user_id = '2b1236de-3066-4b0a-97e1-4482e2a5b00a'
AND role = 'admin'
AND brokerage_id IS NULL;

-- Verify the update
SELECT 
  ura.user_id,
  ura.role,
  ura.brokerage_id,
  u.email,
  u.user_type
FROM public.user_role_assignments ura
JOIN public.users u ON ura.user_id = u.id
WHERE u.email = 'admin@yourbrokerage.com';
