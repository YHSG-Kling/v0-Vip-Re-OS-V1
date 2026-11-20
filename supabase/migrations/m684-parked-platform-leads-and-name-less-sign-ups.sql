-- ── APPLIED LIVE 2026-10-01 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m684 — two live refusals from the lane 93D walk, ONE migration (the lane's only pre-assigned number):
--   §1 a platform-origin lead is born PARKED (leads.brokerage_id NULL admitted for source_origin='platform' only)
--   §2 a sign-up that carries no name can create its users row (handle_new_auth_user writes '' not NULL)
-- After apply: §1 adds a CHECK → regenerate the vocabulary cache (CLAUDE.md §3). §2 is a function body only.
--
-- ════ §1 ════════════════════════════════════════════════════════════════════
--
-- m684 §1 — a platform-origin lead is born PARKED (brokerage_id NULL), and the
-- live schema refuses to let it be born at all.
--
-- Lane 93D (wave 93 full-platform walk, real functions through the MCP replay
-- bridge against project hrvaqgvukzxfskkcrwbt). A platform-pool BatchData record
-- cleared every gate in lib/lead-pipeline/pipeline-processor.ts processRawRecord
-- (territory, identity, dedup ×2, enrichment) and the promotion INSERT was refused:
--     23502 null value in column "brokerage_id" of relation "leads" violates not-null constraint
-- The code is RIGHT to write NULL — the owner's round-39 ruling
-- ("PARKED-UNTIL-DISTRIBUTED", pipeline-processor.ts STEP 5 comment; parity with
-- lib/lead-promotion/lead-promoter.ts) is that a platform-origin lead carries no
-- tenant until Engine 1 (lib/platform/distribution-engine.ts distributePlatformLead)
-- assigns one by zip rotation, and stays parked (never deleted) when no subscriber
-- serves its zip. The column's NOT NULL contradicts that ruling, so EVERY
-- platform-scraped record dies at promotion: live `leads` held 0 rows of either
-- origin when this was measured (2026-10-01).
--
-- Fix: the column admits NULL exactly when the lead is platform-origin. The CHECK
-- keeps tenant-origin leads honest — a brokerage-origin lead with no brokerage is
-- still refused (fail closed). RLS needs no change: every leads policy routes
-- through has_brokerage_access(brokerage_id) / current_user_brokerage_id(), which a
-- NULL never satisfies, so a parked lead is visible to platform admins only — the
-- ruling's "no tenant sees it".
--
-- Pre-flight (read live 2026-10-01): leads row count = 0, so the CHECK validates
-- against an empty table; FK leads_brokerage_id_fkey (ON DELETE CASCADE) admits NULL.

-- ════ §2 ════════════════════════════════════════════════════════════════════
--
-- m684 §2 — a sign-up that carries no name can create its users row.
--
-- Lane 93D (wave 93 full-platform walk, real functions through the MCP replay
-- bridge against project hrvaqgvukzxfskkcrwbt). Step 8c — the closed client signs
-- into the portal with an emailed one-time code — was refused at the auth.users
-- INSERT itself:
--     23502 null value in column "first_name" of relation "users" violates not-null constraint
-- The portal's OTP door (app/portal/login/page.tsx signInWithOtp, and
-- lib/portal/portal-invite-core.ts issuePortalInvite's magic link) sends NO user
-- metadata — the visitor typed only an email. on_auth_user_created →
-- public.handle_new_auth_user() then inserts first_name/last_name as
-- NULLIF(parsed, '') = NULL, and both columns are NOT NULL (read live
-- 2026-10-01), so Supabase answers the client "Database error saving new user"
-- and NO first-time portal sign-in can succeed. The same holds for any other
-- metadata-less sign-up.
--
-- Fix: the trigger writes '' (empty, never fabricated — the codebase convention
-- lib/platform/tenant-import.ts uses for the same NOT NULL column) when no name
-- was supplied, and the ON CONFLICT arm keeps treating '' as "no name supplied" so
-- a later name-less sign-in never blanks a name already on file. Nothing else in
-- the function changes (body otherwise verbatim from pg_get_functiondef, 2026-10-01).
--
-- NOT changed here, recorded for the owner: the same trigger defaults
-- user_type to 'agent' when the metadata carries none, so a portal CLIENT's first
-- sign-in seats them as an 'agent' with no brokerage. The app-side adoption in
-- lib/portal/portal-invite-core.ts ensureContactPortalUser (same lane) re-types
-- exactly that bare trigger-default row to 'contact'; changing the trigger's
-- default is a product decision (staff OAuth sign-ups rely on it today).

BEGIN;

-- ── §1 ──

ALTER TABLE public.leads ALTER COLUMN brokerage_id DROP NOT NULL;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_only_platform_origin_is_parked
  -- coalesce: a CHECK that evaluates to NULL PASSES, so a bare `source_origin = 'platform'`
  -- would admit a parked lead whose origin is NULL.
  CHECK (brokerage_id IS NOT NULL OR coalesce(source_origin, '') = 'platform');

COMMENT ON CONSTRAINT leads_only_platform_origin_is_parked ON public.leads IS
  'm684: a NULL brokerage_id is a platform-origin lead parked until Engine 1 distributes it; a brokerage-origin lead always carries its tenant.';

-- ── §2 ──

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
    id, email, first_name, last_name, brokerage_id, user_type, is_contact, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.email,
    -- users.first_name / last_name are NOT NULL: '' when no name was supplied (m684 §2)
    COALESCE(NULLIF(parsed_first, ''), ''), COALESCE(NULLIF(parsed_last, ''), ''),
    NULLIF(NEW.raw_user_meta_data->>'brokerage_id', '')::uuid,
    COALESCE(NEW.raw_user_meta_data->>'user_type', 'agent'),
    false, NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email        = EXCLUDED.email,
    -- '' means "no name supplied" — never overwrite a name on file with it (m684 §2)
    first_name   = COALESCE(NULLIF(EXCLUDED.first_name, ''), public.users.first_name),
    last_name    = COALESCE(NULLIF(EXCLUDED.last_name, ''),  public.users.last_name),
    brokerage_id = COALESCE(EXCLUDED.brokerage_id, public.users.brokerage_id),
    user_type    = COALESCE(public.users.user_type, EXCLUDED.user_type),
    updated_at   = NOW();

  RETURN NEW;
END;
$function$;

COMMIT;

-- ════ VERIFICATION §1 ════

-- Verification (run after apply):
--   SELECT is_nullable FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='leads' AND column_name='brokerage_id';   -- expect YES
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'leads_only_platform_origin_is_parked';                              -- expect the CHECK
-- Positive control (inside a rolled-back transaction):
--   INSERT INTO public.leads (brokerage_id, source_origin, first_name) VALUES (NULL, 'brokerage', 'x');  -- expect 23514

-- ════ VERIFICATION §2 (run after apply; every line must hold) ════
-- 1. A name-less sign-up creates its users row (the 8c refusal is gone):
--      DO $v$ BEGIN
--        INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
--        VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'm684-2.probe@example.invalid', '', '{}', '{}', now(), now());
--        RAISE EXCEPTION 'm684-2 probe users=%', (SELECT count(*) FROM public.users WHERE email = 'm684-2.probe@example.invalid');
--      END $v$;            -- expect: ERROR m684-2 probe users=1 (and nothing persists)
-- 2. POSITIVE CONTROL — the same probe BEFORE apply raised 23502 (lane 93D, 2026-10-01);
--    a named sign-up still splits full_name exactly as before.
-- 3. §2 needs no schema-cache regeneration (function body only). §1's CHECK does (vocabulary cache).
