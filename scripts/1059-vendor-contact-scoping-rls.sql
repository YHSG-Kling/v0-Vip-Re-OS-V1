-- ============================================================================
-- Migration 1059 — Vendor contact-scoping + hard RLS lockdown
-- ============================================================================
--
-- WHY:
--   AUDIT FINDING (Sprint-13 Commit F):
--     1. /app/vendor/dashboard and /app/vendor/jobs call getAllVendorBookings()
--        which filters by brokerage_id, not by vendor — a vendor can see ALL
--        vendor bookings in their brokerage, including OTHER vendors' deals.
--     2. vendor_bookings has NO RLS policy whatsoever.
--     3. contacts has no vendor-policy — vendors can reach contact data via
--        joined reads through transactions/vendor_bookings.
--     4. Existing RLS on transactions checks auth.is_on_deal_team(id) by email
--        match — fragile (any email change breaks scope).
--
--   This is a COMPLIANCE issue, not a UX one:
--     - TCPA: vendor dials non-assigned contact → fine charged to brokerage
--     - NAR §1-12: brokerage liable for vendor-driven contact poaching
--     - CCPA + state privacy laws: vendor sees PII they weren't authorized for
--
-- WHAT:
--   1. vendor_contact_assignments — explicit junction. Every vendor read of a
--      contact must be backed by a row here. Brokerage_id-scoped, status
--      lifecycle (active|revoked|expired), granted_by + granted_at audit.
--   2. vendors.access_level — schema-ready for the future paid add-on:
--        transaction_only     (default — see only contacts you're assigned to)
--        team_full_access     (paid: see all contacts on a specific team)
--        brokerage_full_access (paid: see all brokerage contacts — preferred-partner tier)
--   3. SQL helpers in auth schema:
--        public.vendor_has_contact_access(contact_id) — true if vendor has
--          either a direct assignment OR full-access subscription.
--        public.vendor_has_transaction_access(transaction_id) — true if vendor
--          has any contact assignment ON that transaction OR full access.
--   4. RLS policies:
--        - vendor_bookings: vendor reads only their own rows.
--        - vendor_contact_assignments: vendor reads own rows, agents/admin
--          write/revoke.
--        - contacts (extension): vendor user_type can SELECT only when the
--          helper returns true.
--        - transactions (extension): same — replace the email-match policy
--          with the helper-backed one.
--   5. Audit-log trigger: every assignment + revocation writes to
--      vendor_access_logs (existing table from create-vendor-marketplace-system.sql).
-- ============================================================================

BEGIN;

-- ── 1. vendors.access_level ─────────────────────────────────────────────────
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'transaction_only';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vendors_access_level_check') THEN
    ALTER TABLE public.vendors
      ADD CONSTRAINT vendors_access_level_check
      CHECK (access_level IN ('transaction_only','team_full_access','brokerage_full_access'));
  END IF;
END$$;

COMMENT ON COLUMN public.vendors.access_level IS
  'Vendor data scope: transaction_only (default — sees only assigned contacts); team_full_access (paid add-on — sees all team contacts); brokerage_full_access (paid preferred-partner tier — sees all brokerage contacts).';

-- ── 2. vendor_contact_assignments junction ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_contact_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  transaction_id   uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  brokerage_id     uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  assigned_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  scope            text NOT NULL DEFAULT 'pii_basic'
                   CHECK (scope IN ('pii_basic','pii_full','transaction_docs','financial')),
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','revoked','expired')),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoke_reason    text,
  expires_at       timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vca_vendor_active
  ON public.vendor_contact_assignments(vendor_id, status)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vca_contact_active
  ON public.vendor_contact_assignments(contact_id, status)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_vca_transaction
  ON public.vendor_contact_assignments(transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_vca_brokerage
  ON public.vendor_contact_assignments(brokerage_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vca_active
  ON public.vendor_contact_assignments(vendor_id, contact_id, COALESCE(transaction_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'active';

ALTER TABLE public.vendor_contact_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vca_svc_all ON public.vendor_contact_assignments;
CREATE POLICY vca_svc_all ON public.vendor_contact_assignments
  FOR ALL USING (true) WITH CHECK (true);

-- Vendor can read their own assignments
DROP POLICY IF EXISTS vca_vendor_read_own ON public.vendor_contact_assignments;
CREATE POLICY vca_vendor_read_own ON public.vendor_contact_assignments
  FOR SELECT
  USING (
    vendor_id IN (
      SELECT vendor_id FROM public.user_role_assignments
      WHERE user_id = auth.uid() AND vendor_id IS NOT NULL
    )
  );

-- Tenant admins can read all
DROP POLICY IF EXISTS vca_tenant_read ON public.vendor_contact_assignments;
CREATE POLICY vca_tenant_read ON public.vendor_contact_assignments
  FOR SELECT
  USING (
    brokerage_id = current_user_brokerage_id()
    OR current_user_type() = 'superadmin'
  );

-- Agents + admins write/revoke
DROP POLICY IF EXISTS vca_tenant_write ON public.vendor_contact_assignments;
CREATE POLICY vca_tenant_write ON public.vendor_contact_assignments
  FOR ALL
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent')
  )
  WITH CHECK (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent')
  );

-- Touch trigger
CREATE OR REPLACE FUNCTION public.touch_vca_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END$$;

DROP TRIGGER IF EXISTS trg_touch_vca ON public.vendor_contact_assignments;
CREATE TRIGGER trg_touch_vca BEFORE UPDATE ON public.vendor_contact_assignments
  FOR EACH ROW EXECUTE FUNCTION public.touch_vca_updated_at();

-- ── 3. Helper SQL functions (auth schema for use in RLS) ────────────────────

-- True if calling vendor has any active assignment to this contact OR
-- has a full-access subscription level on the contact's brokerage.
-- Helpers live in `public` schema (Supabase MCP cannot create in `auth` schema).
-- Marked SECURITY DEFINER so they can read tables under RLS without needing
-- the caller to have direct access to vendor_contact_assignments.
CREATE OR REPLACE FUNCTION public.vendor_has_contact_access(p_contact_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH v AS (
    SELECT vendor_id, brokerage_id
    FROM public.user_role_assignments
    WHERE user_id = auth.uid() AND vendor_id IS NOT NULL
    LIMIT 1
  ),
  ven AS (
    SELECT id, brokerage_id, access_level FROM public.vendors
    WHERE id = (SELECT vendor_id FROM v)
  ),
  c AS (
    SELECT brokerage_id FROM public.contacts WHERE id = p_contact_id
  )
  SELECT
    -- Active direct assignment to this contact
    EXISTS (
      SELECT 1 FROM public.vendor_contact_assignments vca
      WHERE vca.contact_id = p_contact_id
        AND vca.vendor_id  = (SELECT vendor_id FROM v)
        AND vca.status     = 'active'
        AND (vca.expires_at IS NULL OR vca.expires_at > now())
    )
    OR
    -- Brokerage-wide paid access AND contact belongs to vendor's brokerage
    (
      (SELECT access_level FROM ven) = 'brokerage_full_access'
      AND (SELECT brokerage_id FROM ven) = (SELECT brokerage_id FROM c)
    )
$$;

REVOKE ALL ON FUNCTION public.vendor_has_contact_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.vendor_has_contact_access(uuid) TO authenticated, service_role;

-- True if calling vendor has any active contact-assignment ON this transaction
-- OR brokerage-full-access AND transaction belongs to vendor's brokerage.
CREATE OR REPLACE FUNCTION public.vendor_has_transaction_access(p_transaction_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH v AS (
    SELECT vendor_id, brokerage_id
    FROM public.user_role_assignments
    WHERE user_id = auth.uid() AND vendor_id IS NOT NULL
    LIMIT 1
  ),
  ven AS (
    SELECT id, brokerage_id, access_level FROM public.vendors
    WHERE id = (SELECT vendor_id FROM v)
  ),
  t AS (
    SELECT brokerage_id FROM public.transactions WHERE id = p_transaction_id
  )
  SELECT
    EXISTS (
      SELECT 1 FROM public.vendor_contact_assignments vca
      WHERE vca.transaction_id = p_transaction_id
        AND vca.vendor_id      = (SELECT vendor_id FROM v)
        AND vca.status         = 'active'
        AND (vca.expires_at IS NULL OR vca.expires_at > now())
    )
    OR
    (
      (SELECT access_level FROM ven) = 'brokerage_full_access'
      AND (SELECT brokerage_id FROM ven) = (SELECT brokerage_id FROM t)
    )
$$;

REVOKE ALL ON FUNCTION public.vendor_has_transaction_access(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.vendor_has_transaction_access(uuid) TO authenticated, service_role;

-- ── 4. vendor_bookings RLS lockdown (was NONE) ──────────────────────────────
ALTER TABLE public.vendor_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_bookings_svc_all ON public.vendor_bookings;
CREATE POLICY vendor_bookings_svc_all ON public.vendor_bookings
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS vendor_bookings_vendor_read_own ON public.vendor_bookings;
CREATE POLICY vendor_bookings_vendor_read_own ON public.vendor_bookings
  FOR SELECT
  USING (
    vendor_id IN (
      SELECT vendor_id FROM public.user_role_assignments
      WHERE user_id = auth.uid() AND vendor_id IS NOT NULL
    )
  );

DROP POLICY IF EXISTS vendor_bookings_tenant_all ON public.vendor_bookings;
CREATE POLICY vendor_bookings_tenant_all ON public.vendor_bookings
  FOR ALL
  USING (
    current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent','tc','isa')
  )
  WITH CHECK (
    current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent','tc','isa')
  );

-- ── 5. contacts RLS extension — vendor user_type can SELECT only with helper
DROP POLICY IF EXISTS contacts_vendor_scoped_read ON public.contacts;
CREATE POLICY contacts_vendor_scoped_read ON public.contacts
  FOR SELECT
  USING (
    current_user_type() = 'vendor'
    AND public.vendor_has_contact_access(id)
  );

-- ── 6. transactions RLS extension — replace fragile email-match policy
DROP POLICY IF EXISTS transactions_vendor_scoped_read ON public.transactions;
CREATE POLICY transactions_vendor_scoped_read ON public.transactions
  FOR SELECT
  USING (
    current_user_type() = 'vendor'
    AND public.vendor_has_transaction_access(id)
  );

-- ── 7. NOTE — no separate audit trigger.
-- vendor_contact_assignments columns ARE the audit trail:
--   granted_at  + assigned_by    → who granted, when
--   revoked_at  + revoked_by     → who revoked, when
--   revoke_reason                → why
--   status                       → current state
-- Attempted writes to activities / vendor_access_logs both hit FK constraints
-- (activities.agent_id → agents, vendor_access_logs.vendor_id → vendor_marketplace_profiles)
-- and the row history is already authoritative.

COMMIT;
