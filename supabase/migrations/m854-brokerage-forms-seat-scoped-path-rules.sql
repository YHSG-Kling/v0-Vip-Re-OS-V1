-- WRITTEN, NOT APPLIED (wave 145, lane 145A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m854 — THE brokerage-forms PATH RULES, CORRECTED: an ACTIVE STAFF SEAT, the registered packet's own row, revocation on
-- membership end, and browser writes only into the caller's own folder (wave 145, lane 145A — owner ruling 23: "Form-bucket
-- security is release-blocking until the live storage policies are applied and verified").
--
-- PUBLIC SCHEMA ONLY — the integrator applies this file through the Supabase MCP. The storage.objects policies that USE these
-- functions are m855 (owner-held: the MCP role `postgres` is neither the owner of storage.objects nor a member of
-- supabase_storage_admin — measured 2026-10-27 — so CREATE / DROP POLICY on it is refused 42501). Apply THIS file first: m855
-- refuses to run until the functions below exist.
--
-- WHAT m853 (wave 144 — live since 2026-10-25 except its storage block, which never ran) GOT WRONG, measured live 2026-10-27:
--   1. ANY users row of the brokerage passed `current_user_brokerage_id()` — and portal CONTACTS (4 live) and VENDOR seats (4 live)
--      carry brokerage_id. Under m853's rule a buyer could list and read the brokerage's licensed packet masters and EVERY
--      `filled/{offerId}/…` copy of the brokerage (another buyer's name, price and terms). CLAUDE.md §5: contacts, lenders and
--      vendors see no financials but their own.
--   2. No revocation: a SUSPENDED user (users.status), a REMOVED one (users.deleted_at), an agent DEACTIVATED in the brokerage
--      (lib/agents/agent-deactivation.ts sets agents.is_active=false and leaves users untouched) and a member of a DELETED team all
--      kept reading.
--   3. A registered packet (`brokerage/{id}/packets/{row}/…`, `teams/{id}/packets/{row}/…`) was readable by every member whether
--      the row was retired, its licence expired, or the path named no row at all — the code's fill rule
--      (lib/forms/tenant-form-packets.ts usableTenantPacketPaths) refuses all three.
--   4. Browser sessions could WRITE brokerage/ and teams/ folders. No browser writer exists there (the census in
--      scripts/transfer-classification-guard.ts: the only browser writer is the FormWizard upload into agents/{own id}/uploads/);
--      packet sharing goes through the registry door (app/api/admin/transaction-forms → registerTenantFormPacket: PDF check, size,
--      licence, authority), and a file dropped straight into brokerage/{id}/ would be offered to every agent as a "loose file"
--      without any of that.
--   5. brokerage_form_library's SELECT policy admitted the same contact / vendor rows, and the upload route persisted a 10-YEAR
--      signed URL into pdf_url — a bearer link to the master that survives retirement, licence expiry and membership end.
--
-- THE SEAT LIST is lib/forms/tenant-form-packets.ts FORM_LIBRARY_SEAT_USER_TYPES = TENANT_ADMIN_USER_TYPES ∪ {agent, tc} (the
-- guard holds the two equal and both inside the live users_user_type_check). Measured live 2026-10-27 with this exact predicate:
-- 13 of 13 staff seats admitted (admin 3, agent 6, broker 1, compliance_officer 1, tc 1, team_lead 1); 0 of 4 contacts, 0 of 4
-- vendors, 0 of 2 system rows. Nobody who works forms today is locked out.
--
-- Live at write time: 0 brokerage_form_library rows (0 with pdf_url), 0 objects in brokerage-forms, 0 catalogue packets.

-- ── 1. the reader / writer must be an ACTIVE tenant staff seat ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.brokerage_forms_seat_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce((
    SELECT u.deleted_at IS NULL
       AND coalesce(u.status, 'active') = 'active'
       AND u.brokerage_id IS NOT NULL
       AND u.user_type IN ('admin', 'broker', 'broker_admin', 'broker_owner', 'team_lead', 'compliance_officer', 'agent', 'tc')
       -- an agent deactivated IN THIS brokerage is revoked; no agents row at all = nothing to revoke (users decided above)
       AND coalesce((SELECT bool_or(a.is_active IS DISTINCT FROM false)
                       FROM public.agents a
                      WHERE a.user_id = u.id AND a.brokerage_id = u.brokerage_id), true)
      FROM public.users u
     WHERE u.id = auth.uid()
     LIMIT 1
  ), false);
$$;

COMMENT ON FUNCTION public.brokerage_forms_seat_active() IS
  'm854 (wave 145, lane 145A): the caller is an ACTIVE tenant staff seat — not deleted, status active, user_type in the forms seat list (lib/forms/tenant-form-packets.ts FORM_LIBRARY_SEAT_USER_TYPES), and not an agent deactivated in this brokerage. Contacts, vendors, system and support rows are never seats.';

-- ── 2. a REGISTERED packet path is readable only through its own library row ────────────────────────────────────────────────
-- MANAGE (the oversight class for any row; a team's lead for that team's rows — retired / expired included, so a manager can review
-- before reactivating) or USE (active, in licence, brokerage-wide or the reader's own live team). The path must be EXACTLY the
-- row's storage_path and its 4th segment the row id — an object under packets/ that names no row is nobody's to read.
CREATE OR REPLACE FUNCTION public.brokerage_forms_registered_packet_readable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(EXISTS (
    SELECT 1
      FROM public.brokerage_form_library l
     WHERE l.storage_path = p_name
       AND split_part(p_name, '/', 4) = l.id::text
       AND l.brokerage_id = public.current_user_brokerage_id()
       AND (
            (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
         OR (l.team_id IS NOT NULL AND l.team_id = public.current_user_led_team_id())
         OR (l.is_active
             AND (l.license_expires_at IS NULL OR l.license_expires_at >= current_date)
             AND (l.team_id IS NULL
                  OR (l.team_id = public.resolve_team_id(auth.uid(), NULL::uuid)
                      AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = l.team_id AND t.deleted_at IS NULL))))
       )
  ), false);
$$;

-- ── 3. the readable rule: platform superadmin, or an active seat reading its own layout ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.brokerage_forms_path_readable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    public.is_platform_admin()
    OR (
      public.brokerage_forms_seat_active()
      AND position('..' in p_name) = 0
      AND (
           -- the caller's own folder (My Forms, uploads)
           (split_part(p_name, '/', 1) = 'agents' AND split_part(p_name, '/', 2) = auth.uid()::text)
           -- the brokerage's loose files (not under packets/)
        OR (split_part(p_name, '/', 1) = 'brokerage' AND split_part(p_name, '/', 2) = public.current_user_brokerage_id()::text
            AND split_part(p_name, '/', 3) <> 'packets')
           -- a registered brokerage / team packet: through its own row (section 2)
        OR (split_part(p_name, '/', 1) IN ('brokerage', 'teams') AND split_part(p_name, '/', 3) = 'packets'
            AND public.brokerage_forms_registered_packet_readable(p_name))
           -- a team's loose files: a member of that live team, or the brokerage's oversight class
        OR (split_part(p_name, '/', 1) = 'teams' AND split_part(p_name, '/', 3) <> 'packets' AND EXISTS (
              SELECT 1 FROM public.teams t
               WHERE t.id::text = split_part(p_name, '/', 2)
                 AND t.brokerage_id = public.current_user_brokerage_id()
                 AND ((t.id = public.resolve_team_id(auth.uid(), NULL::uuid) AND t.deleted_at IS NULL)
                      OR (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead'))))
           -- a filled copy: the caller's own, or an offer of the caller's brokerage
        OR (split_part(p_name, '/', 1) = 'filled' AND (
              split_part(p_name, '/', 2) = auth.uid()::text
              OR EXISTS (SELECT 1 FROM public.offers o
                          WHERE o.id::text = split_part(p_name, '/', 2) AND o.brokerage_id = public.current_user_brokerage_id())))
      )
    )
  , false);
$$;

-- ── 4. the writable rule: a browser session writes ONLY into its own agents/{uid}/ folder ───────────────────────────────────
-- Every other root (brokerage/, teams/, filled/, platform/) is written by the server, on the service client, after its own gate:
-- the registry door (lib/forms/tenant-form-packets.ts registerTenantFormPacket / registerCopiedPacket), the fill action (filled/),
-- the superadmin catalogue (platform/). No browser writer exists for them (census in the guard), so none is admitted.
CREATE OR REPLACE FUNCTION public.brokerage_forms_path_writable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    public.brokerage_forms_seat_active()
    AND position('..' in p_name) = 0
    AND split_part(p_name, '/', 1) = 'agents'
    AND split_part(p_name, '/', 2) = auth.uid()::text
    AND split_part(p_name, '/', 3) <> ''
  , false);
$$;

-- ── 5. the library's row read follows the same seat rule ───────────────────────────────────────────────────────────────────
-- (INSERT / UPDATE / DELETE already require the oversight class or the team's lead — m853; a contact / vendor can match neither.)
ALTER POLICY brokerage_form_library_tenant_select ON public.brokerage_form_library
  USING (
    brokerage_id = public.current_user_brokerage_id()
    AND public.brokerage_forms_seat_active()
    AND (
      team_id IS NULL
      OR team_id = public.resolve_team_id(auth.uid(), NULL::uuid)
      OR (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
    )
  );

-- ── 6. no persisted bearer link to a registered master ──────────────────────────────────────────────────────────────────────
-- The upload route no longer writes pdf_url for a stored master (app/api/admin/transaction-forms/route.ts — links are minted per
-- view by lib/forms/tenant-form-packets.ts issueTenantPacketUrl). Clear any that were written. 0 rows live at write time. (A
-- signed URL already handed out stays valid until its own expiry — nulling the column stops it being re-distributed.)
UPDATE public.brokerage_form_library SET pdf_url = NULL WHERE storage_path IS NOT NULL AND pdf_url IS NOT NULL;
