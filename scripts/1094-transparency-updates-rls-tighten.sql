-- Tighten RLS on transparency_updates (formerly: single permissive policy with `brokerage_id IS NULL`
-- world-read escape and no per-contact scoping for portal clients). Mirrors the contacts table's
-- role-scoped pattern. Writes happen via service role (RLS bypass), so SELECT-only policies are
-- sufficient. Note: brokerage_id = ... naturally evaluates false for NULL, so the NULL escape is
-- closed without a schema change.

DROP POLICY IF EXISTS transparency_updates_tenant ON transparency_updates;

-- Portal client (contact user) sees ONLY their own card.
CREATE POLICY transparency_updates_contact_self ON transparency_updates FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = transparency_updates.contact_id
      AND c.contact_user_id = auth.uid()
  )
);

-- Agent sees cards for contacts assigned to them.
CREATE POLICY transparency_updates_agent_assigned ON transparency_updates FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM contacts c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = transparency_updates.contact_id
      AND a.user_id = auth.uid()
  )
);

-- Broker / team-lead / TC / compliance see brokerage-scoped.
CREATE POLICY transparency_updates_brokerage_staff ON transparency_updates FOR SELECT
USING (
  brokerage_id IS NOT NULL
  AND brokerage_id = current_user_brokerage_id()
  AND (SELECT users.user_type FROM users WHERE users.id = auth.uid())
      = ANY (ARRAY['broker','broker_owner','team_lead','team_leader','tc','transaction_coordinator',
                   'compliance_officer','compliance_manager'])
);

-- Platform admin full read.
CREATE POLICY transparency_updates_platform_admin ON transparency_updates FOR SELECT
USING (is_platform_admin());
