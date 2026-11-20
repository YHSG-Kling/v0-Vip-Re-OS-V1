-- ── APPLIED LIVE 2026-10-14 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m780 — platform staff live in platform_role ONLY (wave 141 integration; owner ruling 2026-10-14:
-- "need to be careful on falling back to user type superadmin").
--
-- public.is_platform_admin() and public.is_platform_staff() each carried a second arm,
--     OR user_type IN ('superadmin', 'super_admin')
-- which read a tenant-class column as platform authority. The app-side resolvers
-- (lib/platform/platform-staff-roster.ts, lib/auth/resolve-user-role.ts) dropped the same arm in
-- this wave; this migration makes the database agree so RLS and the app read staff from ONE column.
--
-- Measured live before applying: 0 rows in public.users carry user_type='superadmin' (the
-- platform's only superadmin is user_type='admin', platform_role='superadmin'), and the app never
-- writes that value — so no live identity changes; only the fallback shape becomes impossible.
--
-- Deliberately NOT in this migration (reported, owner's call — see the wave-141 final report):
--   · 37 RLS policies across 29 tables still inline `user_type … 'superadmin'` arms. They are dead on
--     this database for the same reason (no row can match) and the app gates refuse first; rewriting
--     them one by one is a separate, reviewed migration.
--   · users_user_type_check still admits 'superadmin' as a storable value. Removing it would make the
--     37 arms provably unreachable at the schema level; it is a DROP CONSTRAINT (owner SQL editor).
--
-- Both functions are redefined with CREATE OR REPLACE (no drops): same signature, same volatility,
-- same SECURITY DEFINER, same search_path on is_platform_staff — only the predicate changes.

CREATE OR REPLACE FUNCTION public.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT COALESCE(
    (SELECT platform_role = 'superadmin'
     FROM public.users WHERE id = auth.uid() LIMIT 1),
    FALSE
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select platform_role in ('superadmin', 'admin', 'marketing', 'support')
     from public.users where id = auth.uid() limit 1),
    false
  );
$function$;
