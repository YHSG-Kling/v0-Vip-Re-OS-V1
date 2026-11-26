-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150C ──
--
-- m958 — MEMBERSHIP IS AN EXPLICIT GRANT IN A SCOPE, never a name and never a user_type (C34; directive
-- "Canonical topology" points 1–2: "A user may hold explicitly granted memberships/roles in more than one
-- permissible scope. Never widen a row using a global user_type or superadmin fallback … a brokerage with five
-- offices must see aggregated data only when granted leadership access").
--
-- SURVIVOR EXTENDED (LAW 1, orphan doctrine §1 case 2 — BUILD the missing half). `public.organization_members`
-- (id, brokerage_id, user_id, role default 'member', permissions jsonb, joined_at, organization_id,
-- organization_type, team_id) is LIVE, carries brokerage_id + team_id + user_id, and is WRITER-LESS (0 rows,
-- audited 2026-11-06; app/actions/link-to-video.ts:682 records the earlier repoint). It is exactly the membership
-- record C34 asks for, missing only the office scope and the leadership grade. user_role_assignments is NOT the
-- home: its UNIQUE (user_id, role) (lib/kernel/users.ts upserts onConflict "user_id,role") forbids the same role in
-- two offices, and it is the CAPABILITY grant, not the scope membership. team_members is the commission-split
-- roster (agent_id, split_percent) and stays that.
--
-- WHAT IS ADDED:
--   scope_kind          'tenant' | 'location' | 'team' (CHECK) with a consistency CHECK: tenant → no office/team;
--                       location → location_id set, team_id null; team → team_id set, location_id null.
--   location_id         composite FK (location_id, brokerage_id) → locations(id, brokerage_id) ON DELETE CASCADE.
--   access_level        'member' | 'leadership' (CHECK). ONLY 'leadership' at scope 'tenant' opens the aggregated
--                       all-office view of a multi-location tenant (lib/kernel/resolve-user-office.ts resolveHierarchyScope).
--   source              'provisioning' | 'invite' | 'transfer' | 'admin_grant' (CHECK) — how the grant was made.
--   granted_by_user_id  who granted it (FK users, SET NULL). revoked_at / revoked_by_user_id — a grant is REVOKED,
--                       never deleted (evidence). evidence jsonb (transfer request id, consent, seat verdict).
--   updated_at.
--   team_id FK is REPLACED by the composite (team_id, brokerage_id) → teams(id, brokerage_id) ON DELETE CASCADE:
--                       the old ON DELETE SET NULL would have turned a TEAM membership into a TENANT one when its team
--                       was deleted — a silent WIDENING. 0 rows, so the swap is safe (dropping a FK constraint is not
--                       an index drop).
--   organization_members_active_scope_key — UNIQUE (brokerage_id, user_id, scope_kind, location_id, team_id)
--                       NULLS NOT DISTINCT WHERE revoked_at IS NULL: one active grant per user per scope.
--
-- RLS: the SELECT policy (brokerage_id = current_user_brokerage_id()) stays — the roster is the tenant's own.
-- The three session WRITE policies are DROPPED: the live INSERT check was
-- `brokerage_id = current_user_brokerage_id() AND is_tenant_staff_seat()`, so ANY staff seat could have granted
-- ITSELF tenant leadership through the session client — the user_type widening C34 forbids, one hop removed.
-- Membership writes go through the service-role rails only (provisionTenantStructure — staff creation, paid
-- self-enrollment, consented transfer placement), each gated in code and evidenced.
--
-- OWNER SQL (O-150C-1, NOT in this file — it drops the index behind a UNIQUE constraint, which the wave header
-- reserves for the SQL editor). Until it runs, the legacy UNIQUE (brokerage_id, user_id) admits ONE membership row
-- per user per tenant; a second scope is refused 23505 and lib/kernel/tenant-creation.ts reports it by name
-- ("O-150C-1 pending"), never as success:
--     ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_brokerage_id_user_id_key;
--
-- WRITER: lib/kernel/tenant-creation.ts provisionTenantStructure. READERS: lib/kernel/resolve-user-office.ts
-- readScopeMemberships → resolveHierarchyScope / resolveViewerHierarchy / loadOfficeDirectory
-- (app/dashboard/settings/offices/page.tsx).

ALTER TABLE public.organization_members
  ADD COLUMN IF NOT EXISTS scope_kind         text NOT NULL DEFAULT 'tenant',
  ADD COLUMN IF NOT EXISTS location_id        uuid NULL,
  ADD COLUMN IF NOT EXISTS access_level       text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS source             text NOT NULL DEFAULT 'admin_grant',
  ADD COLUMN IF NOT EXISTS granted_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revoked_at         timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_scope_kind_check') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_scope_kind_check CHECK (scope_kind IN ('tenant', 'location', 'team'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_scope_shape_check') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_scope_shape_check CHECK (
      (scope_kind = 'tenant'   AND location_id IS NULL     AND team_id IS NULL) OR
      (scope_kind = 'location' AND location_id IS NOT NULL AND team_id IS NULL) OR
      (scope_kind = 'team'     AND team_id IS NOT NULL     AND location_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_access_level_check') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_access_level_check CHECK (access_level IN ('member', 'leadership'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_source_check') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_source_check CHECK (source IN ('provisioning', 'invite', 'transfer', 'admin_grant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_location_same_tenant_fkey') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_location_same_tenant_fkey
      FOREIGN KEY (location_id, brokerage_id) REFERENCES public.locations (id, brokerage_id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_team_id_fkey') THEN
    ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_team_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_members_team_same_tenant_fkey') THEN
    ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_team_same_tenant_fkey
      FOREIGN KEY (team_id, brokerage_id) REFERENCES public.teams (id, brokerage_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_active_scope_key
  ON public.organization_members (brokerage_id, user_id, scope_kind, location_id, team_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS organization_members_user_idx ON public.organization_members (user_id) WHERE revoked_at IS NULL;

DROP POLICY IF EXISTS organization_members_tenant_insert ON public.organization_members;
DROP POLICY IF EXISTS organization_members_tenant_update ON public.organization_members;
DROP POLICY IF EXISTS organization_members_tenant_delete ON public.organization_members;

COMMENT ON COLUMN public.organization_members.access_level IS
  'member | leadership. Only an active leadership grant at scope_kind=tenant opens the aggregated all-office view of a multi-location tenant (C34). Never inferred from users.user_type or platform_role.';

-- VERIFY (integrator, read-only, after apply):
--   SELECT conname FROM pg_constraint WHERE conrelid='public.organization_members'::regclass ORDER BY 1;
--     -- expect *_scope_kind_check, *_scope_shape_check, *_access_level_check, *_source_check,
--     --        *_location_same_tenant_fkey, *_team_same_tenant_fkey, and NO organization_members_team_id_fkey
--   SELECT polname FROM pg_policy WHERE polrelid='public.organization_members'::regclass;   -- only organization_members_tenant_select
--   Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and scripts/check-vocabularies.ts (three new CHECKs).
