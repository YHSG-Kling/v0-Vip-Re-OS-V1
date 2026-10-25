-- WRITTEN, NOT APPLIED (wave 144, lane 144C) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m853 — FORM PACKETS ARE THE BROKERAGE'S AND THE TEAM'S (owner ruling 3, wave 144)
--
-- Owner, verbatim essentials: "Form packets are NOT platform-owned. The brokerage or team uploads approved form packets (often
-- carrying their logos/branding, legal-form licensing, field templates, jurisdiction forms) into THEIR OWN tenant/team bucket and
-- shares them with their agents as templates. Agents only see packets reachable through their actual memberships/permissions; no
-- cross-tenant/team leakage. Do not move ownership to the platform because packets render inside VIPAgents."
--
-- THE SURVIVOR IS EXTENDED, NOT REPLACED. `brokerage_form_library` is the tenant packet registry (the ONE upload path,
-- app/api/admin/transaction-forms) and `brokerage-forms` is the tenant bucket (brokerage/{id}/…, teams/{id}/…, agents/{id}/…,
-- filled/…). This migration gives the registry what ruling 3 needs and it lacked — a TEAM owner, the object path, the licence
-- record, the fill-field count, a version, and the provenance of a packet a brokerage added from the platform catalogue — and
-- scopes the bucket to that layout. Code: lib/forms/tenant-form-packets.ts (the one writer / reader), lib/forms/form-path-scope.ts
-- (the fill scope check), lib/forms/platform-form-packets.ts (the catalogue a brokerage adds FROM).
--
-- m807 `platform_form_packets` IS KEPT, ROW FOR ROW. No row is dropped, moved or rewritten: a platform packet has no tenant, so
-- it cannot be "migrated" onto one without inventing an owner. It stays the clearly labelled platform-provided CATALOGUE; a
-- brokerage adds a packet from it to its OWN library (a copy in its own folder + a library row carrying
-- source_platform_packet_id and the licence), and its agents see it there. Only the comment changes.
--
-- A FINDING THIS FIXES: the four storage policies on `brokerage-forms` admitted ANY authenticated user to SELECT, INSERT, UPDATE
-- and DELETE ANY object in the bucket (`bucket_id = 'brokerage-forms'` and nothing else) — every tenant's library and every
-- filled offer form (a buyer's name, price and terms) readable, overwritable and deletable across tenants by any signed-in user.
-- They are replaced with owner-scoped policies over the bucket's own layout.
--
-- Verified against the live database before writing (2026-10-25, project hrvaqgvukzxfskkcrwbt): brokerage_form_library has 0
-- rows and columns id, brokerage_id, state (NOT NULL), packet_type, name, description, pdf_url, field_schema, is_active,
-- uploaded_by, created_at, updated_at; platform_form_packets has 0 rows; storage.objects in 'brokerage-forms' has 0 objects; the
-- four bucket policies are "auth read/upload/update/delete brokerage-forms" (bucket_id only); the helpers used below exist:
-- current_user_brokerage_id(), current_user_type(), current_user_led_team_id(), resolve_team_id(uuid, uuid),
-- is_brokerage_admin() (TENANT_ADMIN roster incl. team_lead + role grants), is_platform_admin().
--
-- THE OVERSIGHT CLASS used below — `is_brokerage_admin() AND current_user_type() <> 'team_lead'` — is the SQL twin of
-- lib/forms/tenant-form-packets.ts PACKET_OVERSIGHT_USER_TYPES (the tenant admin roster minus team_lead, CLAUDE.md §4 "teams see
-- only their own board"). A team lead manages and sees their OWN team's packets.

-- ── 1. the registry gains a team owner, a path, a licence record ─────────────────────────────────────────────────────────────
ALTER TABLE public.brokerage_form_library
  ADD COLUMN IF NOT EXISTS team_id                   uuid    NULL REFERENCES public.teams(id),
  ADD COLUMN IF NOT EXISTS storage_path              text    NULL,
  ADD COLUMN IF NOT EXISTS form_code                 text    NULL,
  ADD COLUMN IF NOT EXISTS field_count               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS version                   integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS license_note              text    NULL,
  ADD COLUMN IF NOT EXISTS license_expires_at        date    NULL,
  ADD COLUMN IF NOT EXISTS source_platform_packet_id uuid    NULL REFERENCES public.platform_form_packets(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.brokerage_form_library.team_id IS
  'm853: NULL = shared with the whole brokerage; a team id = shared ONLY with that team''s members (and the brokerage''s oversight class). Must be a team of the same brokerage (trigger brokerage_form_library_team_in_brokerage). No ON DELETE action on purpose: a packet never silently widens to the whole brokerage when its team goes.';
COMMENT ON COLUMN public.brokerage_form_library.storage_path IS
  'm853: the master in the private brokerage-forms bucket, under its OWNER: brokerage/{brokerage_id}/packets/{id}/… or teams/{team_id}/packets/{id}/…. NULL on a legacy row reached only by pdf_url.';
COMMENT ON COLUMN public.brokerage_form_library.license_note IS
  'm853: under what licence the brokerage / team holds this form (association membership, a forms-provider agreement, its own form). An expired license_expires_at stops the packet being offered or filled.';
COMMENT ON COLUMN public.brokerage_form_library.source_platform_packet_id IS
  'm853: set when the brokerage added this packet FROM the platform catalogue (platform_form_packets); the copy is the brokerage''s own.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_field_count_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_field_count_check CHECK (field_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_version_check') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_version_check CHECK (version >= 1);
  END IF;
  -- A packet lives in its OWNER's folder: brokerage-wide under the brokerage, a team packet under the team.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brokerage_form_library_storage_path_under_owner') THEN
    ALTER TABLE public.brokerage_form_library ADD CONSTRAINT brokerage_form_library_storage_path_under_owner CHECK (
      storage_path IS NULL
      OR (team_id IS NULL     AND storage_path LIKE ('brokerage/' || brokerage_id::text || '/packets/%'))
      OR (team_id IS NOT NULL AND storage_path LIKE ('teams/'     || team_id::text      || '/packets/%'))
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS brokerage_form_library_storage_path_key
  ON public.brokerage_form_library (storage_path) WHERE storage_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS brokerage_form_library_brokerage_team_idx
  ON public.brokerage_form_library (brokerage_id, team_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS brokerage_form_library_source_platform_packet_idx
  ON public.brokerage_form_library (source_platform_packet_id) WHERE source_platform_packet_id IS NOT NULL;

-- A team packet's team must be a team OF THE SAME BROKERAGE — a CHECK cannot read another table, so a trigger refuses it.
CREATE OR REPLACE FUNCTION public.brokerage_form_library_team_in_brokerage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.teams t WHERE t.id = NEW.team_id AND t.brokerage_id = NEW.brokerage_id
  ) THEN
    RAISE EXCEPTION 'brokerage_form_library: team % is not a team of brokerage %', NEW.team_id, NEW.brokerage_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS brokerage_form_library_team_in_brokerage ON public.brokerage_form_library;
CREATE TRIGGER brokerage_form_library_team_in_brokerage
  BEFORE INSERT OR UPDATE OF team_id, brokerage_id ON public.brokerage_form_library
  FOR EACH ROW EXECUTE FUNCTION public.brokerage_form_library_team_in_brokerage();

-- ── 2. row visibility follows membership (no team leakage through a direct client read) ─────────────────────────────────────
DROP POLICY IF EXISTS brokerage_form_library_tenant_select ON public.brokerage_form_library;
CREATE POLICY brokerage_form_library_tenant_select ON public.brokerage_form_library
  FOR SELECT TO authenticated
  USING (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      team_id IS NULL
      OR team_id = public.resolve_team_id(auth.uid(), NULL::uuid)
      OR (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
    )
  );

-- Sharing is an authority: brokerage-wide by the oversight class; a team packet by that team's lead (or oversight). The insert
-- policy it replaces admitted ANY tenant staff seat (an agent included) to write a brokerage-wide packet.
DROP POLICY IF EXISTS brokerage_form_library_tenant_insert ON public.brokerage_form_library;
CREATE POLICY brokerage_form_library_tenant_insert ON public.brokerage_form_library
  FOR INSERT TO authenticated
  WITH CHECK (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
      OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())
    )
  );

DROP POLICY IF EXISTS brokerage_form_library_tenant_update ON public.brokerage_form_library;
CREATE POLICY brokerage_form_library_tenant_update ON public.brokerage_form_library
  FOR UPDATE TO authenticated
  USING (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
      OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())
    )
  )
  WITH CHECK (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
      OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())
    )
  );

DROP POLICY IF EXISTS brokerage_form_library_tenant_delete ON public.brokerage_form_library;
CREATE POLICY brokerage_form_library_tenant_delete ON public.brokerage_form_library
  FOR DELETE TO authenticated
  USING (
    brokerage_id = public.current_user_brokerage_id()
    AND (
      (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
      OR (team_id IS NOT NULL AND team_id = public.current_user_led_team_id())
    )
  );

-- ── 3. the bucket is scoped to its own layout ───────────────────────────────────────────────────────────────────────────────
-- ONE readable rule and ONE writable rule, SECURITY DEFINER so the policy does not depend on how teams / offers RLS answers.
CREATE OR REPLACE FUNCTION public.brokerage_forms_path_readable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    public.is_platform_admin()
    OR (split_part(p_name, '/', 1) = 'brokerage' AND split_part(p_name, '/', 2) = public.current_user_brokerage_id()::text)
    OR (split_part(p_name, '/', 1) = 'teams' AND EXISTS (
          SELECT 1 FROM public.teams t
          WHERE t.id::text = split_part(p_name, '/', 2)
            AND t.brokerage_id = public.current_user_brokerage_id()
            AND (t.id = public.resolve_team_id(auth.uid(), NULL::uuid)
                 OR (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead'))))
    OR (split_part(p_name, '/', 1) = 'agents' AND split_part(p_name, '/', 2) = auth.uid()::text)
    OR (split_part(p_name, '/', 1) = 'filled' AND (
          split_part(p_name, '/', 2) = auth.uid()::text
          OR EXISTS (SELECT 1 FROM public.offers o
                     WHERE o.id::text = split_part(p_name, '/', 2) AND o.brokerage_id = public.current_user_brokerage_id())))
  , false);
$$;

-- Writes: an agent writes only their own folder; a brokerage folder is the oversight class's; a team folder is its lead's (or
-- oversight's). filled/ and platform/ are written by the server (service role) only — never by a browser session.
CREATE OR REPLACE FUNCTION public.brokerage_forms_path_writable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce(
    public.is_platform_admin()
    OR (split_part(p_name, '/', 1) = 'agents' AND split_part(p_name, '/', 2) = auth.uid()::text)
    OR (split_part(p_name, '/', 1) = 'brokerage' AND split_part(p_name, '/', 2) = public.current_user_brokerage_id()::text
        AND public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
    OR (split_part(p_name, '/', 1) = 'teams' AND EXISTS (
          SELECT 1 FROM public.teams t
          WHERE t.id::text = split_part(p_name, '/', 2)
            AND t.brokerage_id = public.current_user_brokerage_id()
            AND (t.id = public.current_user_led_team_id()
                 OR (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead'))))
  , false);
$$;

DROP POLICY IF EXISTS "auth read brokerage-forms"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth update brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth delete brokerage-forms" ON storage.objects;

CREATE POLICY "brokerage-forms owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_readable(name));
CREATE POLICY "brokerage-forms owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));
CREATE POLICY "brokerage-forms owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name))
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));
CREATE POLICY "brokerage-forms owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

-- ── 4. m807 is the platform CATALOGUE now (comment only — no row touched) ───────────────────────────────────────────────────
COMMENT ON TABLE public.platform_form_packets IS
  'm807 (wave 143) + m853 (wave 144, owner ruling 3): the platform-provided CATALOGUE of licensed fillable form packets. NOT an owner of what agents fill: no agent reads or fills a platform/… path. A brokerage (or a team lead, for their team) ADDS a catalogue packet to its OWN library — a copy into brokerage/{id}/packets/… or teams/{id}/packets/… and a brokerage_form_library row with source_platform_packet_id and the licence (lib/forms/platform-form-packets.ts addPlatformPacketToLibrary). Written only by app/actions/superadmin/platform-form-packets.ts (superadmin).';
