-- Sync all users.user_type from auth.users metadata
-- This ensures admin, broker, agent etc. roles are correctly set
-- even if the original backfill left them as 'agent'

UPDATE public.users pu
SET
  user_type  = COALESCE(
    au.raw_user_meta_data->>'user_type',
    au.raw_user_meta_data->>'role',
    pu.user_type
  ),
  updated_at = NOW()
FROM auth.users au
WHERE pu.id = au.id
  AND (
    au.raw_user_meta_data->>'user_type' IS NOT NULL
    OR au.raw_user_meta_data->>'role' IS NOT NULL
  );

-- Show current state for debugging
SELECT pu.email, pu.user_type, au.raw_user_meta_data->>'user_type' as meta_user_type
FROM public.users pu
JOIN auth.users au ON au.id = pu.id
ORDER BY pu.created_at;
