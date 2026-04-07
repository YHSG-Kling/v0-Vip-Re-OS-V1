-- Check admin user's brokerage assignment
SELECT u.email, u.user_type, u.brokerage_id, b.name as brokerage_name
FROM public.users u
LEFT JOIN public.brokerages b ON b.id = u.brokerage_id
WHERE u.email = 'admin@yourbrokerage.com';

-- Also check if there are any brokerages
SELECT id, name FROM public.brokerages LIMIT 5;
