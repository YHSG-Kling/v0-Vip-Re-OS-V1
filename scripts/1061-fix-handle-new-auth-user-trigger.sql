-- ============================================================================
-- Migration 1061 — Fix broken handle_new_auth_user trigger
-- ============================================================================
--
-- WHY:
--   Pre-existing bug surfaced during the vendor-invite + brokerage-signup
--   flow tests:
--     ERROR: column "full_name" of relation "users" does not exist
--   The trigger on auth.users was written for a different schema generation
--   where users had full_name + avatar_url columns. Today's users table has
--   first_name + last_name only (no full_name, no avatar_url).
--
--   This breaks EVERY new auth signup, including:
--     - Self-serve brokerage signup (Commit C)
--     - Vendor invite acceptance (Commit D)
--     - Manual subscriber provisioning (Commit G)
--     - Admin inviteUser action
--
-- WHAT:
--   Replace the trigger function to insert into the actual columns
--   (first_name + last_name parsed from full_name / name metadata when
--   present). Preserve ON CONFLICT (id) DO UPDATE semantics so subsequent
--   logins still refresh email + brokerage_id.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  meta_full_name text;
  parsed_first   text;
  parsed_last    text;
BEGIN
  meta_full_name := COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'name',
    NULLIF(TRIM(BOTH ' ' FROM
      COALESCE(NEW.raw_user_meta_data->>'first_name','') ||
      ' ' ||
      COALESCE(NEW.raw_user_meta_data->>'last_name','')
    ), '')
  );

  parsed_first := COALESCE(
    NEW.raw_user_meta_data->>'first_name',
    split_part(COALESCE(meta_full_name, ''), ' ', 1)
  );

  parsed_last := COALESCE(
    NEW.raw_user_meta_data->>'last_name',
    NULLIF(
      regexp_replace(COALESCE(meta_full_name, ''), '^\S+\s*', ''),
      ''
    )
  );

  INSERT INTO public.users (
    id,
    email,
    first_name,
    last_name,
    brokerage_id,
    user_type,
    is_contact,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(parsed_first, ''),
    NULLIF(parsed_last,  ''),
    NULLIF(NEW.raw_user_meta_data->>'brokerage_id', '')::uuid,
    COALESCE(NEW.raw_user_meta_data->>'user_type', 'agent'),
    false,
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email        = EXCLUDED.email,
    first_name   = COALESCE(EXCLUDED.first_name,   public.users.first_name),
    last_name    = COALESCE(EXCLUDED.last_name,    public.users.last_name),
    brokerage_id = COALESCE(EXCLUDED.brokerage_id, public.users.brokerage_id),
    user_type    = COALESCE(public.users.user_type, EXCLUDED.user_type),
    updated_at   = NOW();

  RETURN NEW;
END;
$function$;

COMMIT;
