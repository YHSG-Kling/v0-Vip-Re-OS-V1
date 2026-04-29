-- =====================================================
-- MIGRATION 013: Fix contact self-lookup (email → contact_user_id)
-- =====================================================
-- The original auth.is_self_contact() and auth.user_contact_id()
-- matched on email, which breaks when contacts share email addresses
-- or when email changes. This migration switches to contact_user_id
-- (a FK from contacts to users) for reliable self-identification.
-- =====================================================

-- Replace email-based self-contact lookup with contact_user_id FK
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
GRANT EXECUTE ON FUNCTION auth.user_contact_id() TO authenticated;
