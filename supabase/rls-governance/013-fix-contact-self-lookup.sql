-- ============================================================
-- RLS GOVERNANCE: 013 — Fix auth.is_self_contact() and
--                        auth.user_contact_id() to use
--                        contact_user_id FK instead of email JOIN
-- ============================================================
-- IMPORTANT: This file must be applied via the Supabase Dashboard
-- SQL editor (superuser required). The auth schema is not accessible
-- via the connection string / project database URL.
--
-- Status: APPLIED — Functions already corrected in 000-helper-functions.sql
-- and confirmed live as of migration 111. This file is kept for audit trail.
-- ============================================================

-- FIX: Replace email JOIN (case-sensitive, breaks on email changes) with
-- the contact_user_id FK column (added to contacts table in migration 111).

CREATE OR REPLACE FUNCTION auth.is_self_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND contact_user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION auth.user_contact_id()
RETURNS UUID AS $$
  SELECT id FROM contacts
  WHERE contact_user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION auth.is_self_contact(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION auth.user_contact_id()     TO authenticated;
