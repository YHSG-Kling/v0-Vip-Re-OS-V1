-- Migration 1002: Harden RLS on `leads` table
-- The original policy was `USING (true) WITH CHECK (true)` — at the Postgres
-- layer any authenticated user could query leads. App-layer gates (assertISARole)
-- compensate, but defense-in-depth requires Postgres-level enforcement too.
-- Only admin / broker / superadmin / ISA roles may read or write leads.

DROP POLICY IF EXISTS "leads_all" ON leads;

CREATE POLICY "leads_isa_admin_only"
  ON leads
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.user_type IN ('admin', 'broker', 'broker_admin', 'superadmin', 'isa')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.user_type IN ('admin', 'broker', 'broker_admin', 'superadmin', 'isa')
    )
  );
