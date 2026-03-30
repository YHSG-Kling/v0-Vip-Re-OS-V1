-- ============================================================
-- Fix: Ensure admin/broker users can read their own users row
-- and that every auth user with metadata.user_type gets
-- a users row on first login.
-- ============================================================

-- 1. Make brokerage_id nullable so trigger-created rows don't fail
ALTER TABLE public.users ALTER COLUMN brokerage_id DROP NOT NULL;

-- 2. Make the users SELECT policy explicit and correct.
DROP POLICY IF EXISTS "Users can view own data" ON public.users;
CREATE POLICY "Users can view own data"
  ON public.users FOR SELECT
  USING (id = auth.uid());

-- 3. Allow users to INSERT their own row (needed for on-first-login upsert)
DROP POLICY IF EXISTS "Users can insert own row" ON public.users;
CREATE POLICY "Users can insert own row"
  ON public.users FOR INSERT
  WITH CHECK (id = auth.uid());

-- 4. Allow users to UPDATE their own row
DROP POLICY IF EXISTS "Users can update own row" ON public.users;
CREATE POLICY "Users can update own row"
  ON public.users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- 5. Create a trigger that upserts a users row whenever someone signs up via auth.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id,
    email,
    first_name,
    last_name,
    user_type,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'first_name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'user_type', NEW.raw_user_meta_data->>'role', 'agent'),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    SET
      email     = EXCLUDED.email,
      user_type = COALESCE(public.users.user_type, EXCLUDED.user_type),
      updated_at = NOW();

  RETURN NEW;
END;
$$;

-- Attach trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_auth_user();

-- 6. Backfill: for any existing auth user who has no users row, insert one now.
--    Skip on any conflict (id or email uniqueness) to avoid errors.
INSERT INTO public.users (id, email, first_name, last_name, user_type, created_at, updated_at)
SELECT
  au.id,
  au.email,
  COALESCE(au.raw_user_meta_data->>'first_name', split_part(au.email, '@', 1)),
  COALESCE(au.raw_user_meta_data->>'last_name', ''),
  COALESCE(
    au.raw_user_meta_data->>'user_type',
    au.raw_user_meta_data->>'role',
    'agent'
  ),
  NOW(),
  NOW()
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL
ON CONFLICT DO NOTHING;

-- 7. Sync user_type for any users row where user_type is null but auth metadata has it
UPDATE public.users pu
SET
  user_type  = COALESCE(
    au.raw_user_meta_data->>'user_type',
    au.raw_user_meta_data->>'role'
  ),
  updated_at = NOW()
FROM auth.users au
WHERE pu.id = au.id
  AND pu.user_type IS NULL
  AND (
    au.raw_user_meta_data->>'user_type' IS NOT NULL
    OR au.raw_user_meta_data->>'role' IS NOT NULL
  );
