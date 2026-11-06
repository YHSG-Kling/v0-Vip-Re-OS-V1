-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150C ──
--
-- m957 — A BROKERAGE LOCATION IS AN OFFICE WITH ITS OWN IDENTITY (C34; directive "Canonical topology" point 1:
-- "A brokerage location has its own legal/office identity, location-scoped settings, territories, permissions,
-- teams, brand overrides and seat ownership").
--
-- SURVIVOR KEPT (LAW 1). `public.locations` (brokerage_id, name, address, city, state, managing_broker_user_id —
-- m661) is the office table every reader already uses (users.location_id m423, agents.location_id, the P&L
-- rollup, seat-usage's managing-broker exemption, app/actions/admin/locations.ts). Audited live 2026-11-06: 1 row,
-- one SELECT policy (tenant_read_locations: brokerage_id IN user_brokerage_ids()). Nothing here replaces it.
--
-- WHAT IS ADDED (all nullable or defaulted — no existing row changes meaning):
--   locations.office_code        the office's IDEMPOTENCY KEY inside its tenant. NOT the name: two offices of one
--                                brokerage may carry the SAME name (canary 1's negative test) and stay two offices.
--                                UNIQUE (brokerage_id, office_code) where set.
--   locations.legal_name / dba / license_number / license_state   the office's own legal identity (license_state a
--                                two-letter USPS code, CHECK).
--   locations.territories        text[] — the office's own markets (ZIPs / county keys), never the tenant's.
--   locations.brand_overrides    jsonb — the office layer of the brand cascade (office → team → user).
--   locations.settings           jsonb — location-scoped settings and permissions (`permissions` sub-key).
--   locations.seat_cap           integer >= 0; NULL = the tenant's seat band decides alone (seat ownership:
--                                lib/kernel/seat-usage.ts locationSeatGate).
--   locations.status             'active' | 'archived' (CHECK) — archived offices are never deleted by this rail.
--   locations.created_by_user_id the creating USER owns what they create (owner ruling, wave 149).
--   locations.updated_at
--   UNIQUE (id, brokerage_id) on locations AND on teams — the targets of the composite FKs below and in m958, so a
--   team / membership can never point at ANOTHER tenant's office or team (the database refuses it, 23503).
--   teams.location_id            the office a team works out of (a team is a mini brokerage INSIDE an office);
--                                composite FK (location_id, brokerage_id) → locations(id, brokerage_id),
--                                ON DELETE SET NULL (location_id) — deleting an office never deletes or re-tenants
--                                a team (PG ≥ 15 column-list SET NULL).
--
-- WRITER: lib/kernel/tenant-creation.ts provisionTenantStructure (staff creation, paid self-enrollment and the
-- consented-transfer placement, through lib/kernel/tenant-creation.ts createTenantCore / resumeTenantProvisioning).
-- READERS: lib/kernel/resolve-user-office.ts resolveViewerHierarchy (status, teams.location_id), loadOfficeDirectory
-- (app/dashboard/settings/offices/page.tsx — every column above), lib/kernel/seat-usage.ts locationSeatGate (seat_cap).
-- BACKFILL: none — an identity nobody stated is not invented.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS office_code        text NULL,
  ADD COLUMN IF NOT EXISTS legal_name         text NULL,
  ADD COLUMN IF NOT EXISTS dba                text NULL,
  ADD COLUMN IF NOT EXISTS license_number     text NULL,
  ADD COLUMN IF NOT EXISTS license_state      text NULL,
  ADD COLUMN IF NOT EXISTS territories        text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS brand_overrides    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS seat_cap           integer NULL,
  ADD COLUMN IF NOT EXISTS status             text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS location_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_status_check') THEN
    ALTER TABLE public.locations ADD CONSTRAINT locations_status_check CHECK (status IN ('active', 'archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_license_state_check') THEN
    ALTER TABLE public.locations ADD CONSTRAINT locations_license_state_check CHECK (license_state IS NULL OR license_state ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_seat_cap_check') THEN
    ALTER TABLE public.locations ADD CONSTRAINT locations_seat_cap_check CHECK (seat_cap IS NULL OR seat_cap >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_id_brokerage_key') THEN
    ALTER TABLE public.locations ADD CONSTRAINT locations_id_brokerage_key UNIQUE (id, brokerage_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_id_brokerage_key') THEN
    ALTER TABLE public.teams ADD CONSTRAINT teams_id_brokerage_key UNIQUE (id, brokerage_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_location_same_tenant_fkey') THEN
    ALTER TABLE public.teams ADD CONSTRAINT teams_location_same_tenant_fkey
      FOREIGN KEY (location_id, brokerage_id) REFERENCES public.locations (id, brokerage_id) ON DELETE SET NULL (location_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS locations_brokerage_office_code_key
  ON public.locations (brokerage_id, office_code) WHERE office_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS teams_location_id_idx ON public.teams (location_id) WHERE location_id IS NOT NULL;

COMMENT ON COLUMN public.locations.office_code IS
  'The office''s idempotency key inside its tenant (C34). Never the name: two offices of one brokerage may share a name and remain two offices. Writer: lib/kernel/tenant-creation.ts provisionTenantStructure.';
COMMENT ON COLUMN public.locations.seat_cap IS
  'Seats this office owns (C34 seat ownership). NULL = the tenant seat band decides alone. Read by lib/kernel/seat-usage.ts locationSeatGate.';
COMMENT ON COLUMN public.teams.location_id IS
  'The office a team works out of (C34: tenant → office → team → membership). Composite FK keeps it inside the team''s own tenant.';

-- VERIFY (integrator, read-only, after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='locations'
--     AND column_name IN ('office_code','legal_name','dba','license_number','license_state','territories','brand_overrides','settings','seat_cap','status','created_by_user_id','updated_at');   -- 12 rows
--   SELECT conname FROM pg_constraint WHERE conname IN ('locations_status_check','locations_license_state_check','locations_seat_cap_check','locations_id_brokerage_key','teams_id_brokerage_key','teams_location_same_tenant_fkey');   -- 6 rows
--   Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and scripts/check-vocabularies.ts (two new CHECKs).
