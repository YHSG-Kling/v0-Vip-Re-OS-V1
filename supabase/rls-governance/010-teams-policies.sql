-- =====================================================
-- 010: TEAMS & COLLABORATION POLICIES
-- =====================================================
-- Governance: Teams enable collaboration while respecting brokerage boundaries
-- Compliance: Team membership must be auditable and controlled

-- =====================================================
-- TEAMS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'teams') THEN
    ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view teams in their brokerage
    DROP POLICY IF EXISTS "users_view_brokerage_teams" ON teams;
    CREATE POLICY "users_view_brokerage_teams"
      ON teams
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
      );

    -- INSERT: Brokers can create teams
    DROP POLICY IF EXISTS "brokers_create_teams" ON teams;
    CREATE POLICY "brokers_create_teams"
      ON teams
      FOR INSERT
      WITH CHECK (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- UPDATE: Brokers and team leaders can update teams
    DROP POLICY IF EXISTS "brokers_update_teams" ON teams;
    CREATE POLICY "brokers_update_teams"
      ON teams
      FOR UPDATE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR team_leader_id = auth_helpers.get_user_agent_id()
        )
      );

    -- DELETE: Only brokers can delete teams
    DROP POLICY IF EXISTS "brokers_delete_teams" ON teams;
    CREATE POLICY "brokers_delete_teams"
      ON teams
      FOR DELETE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );
  END IF;
END $$;

-- =====================================================
-- TEAM MEMBERS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'team_members') THEN
    ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view team members in their brokerage
    DROP POLICY IF EXISTS "users_view_team_members" ON team_members;
    CREATE POLICY "users_view_team_members"
      ON team_members
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = team_members.team_id
          AND t.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- INSERT: Brokers and team leaders can add team members
    DROP POLICY IF EXISTS "brokers_add_team_members" ON team_members;
    CREATE POLICY "brokers_add_team_members"
      ON team_members
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = team_members.team_id
          AND t.brokerage_id = auth_helpers.get_user_brokerage_id()
          AND (
            auth_helpers.user_has_role('broker')
            OR t.team_leader_id = auth_helpers.get_user_agent_id()
          )
        )
      );

    -- UPDATE: Brokers and team leaders can update team member roles
    DROP POLICY IF EXISTS "brokers_update_team_members" ON team_members;
    CREATE POLICY "brokers_update_team_members"
      ON team_members
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = team_members.team_id
          AND t.brokerage_id = auth_helpers.get_user_brokerage_id()
          AND (
            auth_helpers.user_has_role('broker')
            OR t.team_leader_id = auth_helpers.get_user_agent_id()
          )
        )
      );

    -- DELETE: Brokers and team leaders can remove team members
    DROP POLICY IF EXISTS "brokers_remove_team_members" ON team_members;
    CREATE POLICY "brokers_remove_team_members"
      ON team_members
      FOR DELETE
      USING (
        EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = team_members.team_id
          AND t.brokerage_id = auth_helpers.get_user_brokerage_id()
          AND (
            auth_helpers.user_has_role('broker')
            OR t.team_leader_id = auth_helpers.get_user_agent_id()
          )
        )
      );
  END IF;
END $$;

-- =====================================================
-- SHARED CONTACTS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shared_contacts') THEN
    ALTER TABLE shared_contacts ENABLE ROW LEVEL SECURITY;

    -- SELECT: Team members can view contacts shared with their teams
    DROP POLICY IF EXISTS "team_members_view_shared_contacts" ON shared_contacts;
    CREATE POLICY "team_members_view_shared_contacts"
      ON shared_contacts
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = shared_contacts.team_id
          AND tm.agent_id = auth_helpers.get_user_agent_id()
        )
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: Agents can share their contacts with teams
    DROP POLICY IF EXISTS "agents_share_contacts" ON shared_contacts;
    CREATE POLICY "agents_share_contacts"
      ON shared_contacts
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = shared_contacts.contact_id
          AND c.agent_id = auth_helpers.get_user_agent_id()
        )
      );

    -- UPDATE: Agents can update sharing permissions for their contacts
    DROP POLICY IF EXISTS "agents_update_shared_contacts" ON shared_contacts;
    CREATE POLICY "agents_update_shared_contacts"
      ON shared_contacts
      FOR UPDATE
      USING (
        shared_by = auth_helpers.get_user_agent_id()
        OR auth_helpers.user_has_role('broker')
      );

    -- DELETE: Agents can revoke sharing for their contacts
    DROP POLICY IF EXISTS "agents_revoke_shared_contacts" ON shared_contacts;
    CREATE POLICY "agents_revoke_shared_contacts"
      ON shared_contacts
      FOR DELETE
      USING (
        shared_by = auth_helpers.get_user_agent_id()
        OR auth_helpers.user_has_role('broker')
      );
  END IF;
END $$;

-- =====================================================
-- COLLABORATION LOGS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'collaboration_logs') THEN
    ALTER TABLE collaboration_logs ENABLE ROW LEVEL SECURITY;

    -- SELECT: Team members can view collaboration logs for their teams
    DROP POLICY IF EXISTS "team_members_view_collaboration_logs" ON collaboration_logs;
    CREATE POLICY "team_members_view_collaboration_logs"
      ON collaboration_logs
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = collaboration_logs.team_id
          AND tm.agent_id = auth_helpers.get_user_agent_id()
        )
        OR auth_helpers.user_has_role('broker')
      );

    -- INSERT: System can create collaboration logs
    DROP POLICY IF EXISTS "system_create_collaboration_logs" ON collaboration_logs;
    CREATE POLICY "system_create_collaboration_logs"
      ON collaboration_logs
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Collaboration logs are immutable
    -- DELETE: Only admins can delete old logs
    DROP POLICY IF EXISTS "admins_delete_old_collaboration_logs" ON collaboration_logs;
    CREATE POLICY "admins_delete_old_collaboration_logs"
      ON collaboration_logs
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '1 year'
      );
  END IF;
END $$;

-- =====================================================
-- AGENT ASSIGNMENTS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_assignments') THEN
    ALTER TABLE agent_assignments ENABLE ROW LEVEL SECURITY;

    -- SELECT: Agents can view their own assignments
    DROP POLICY IF EXISTS "agents_view_own_assignments" ON agent_assignments;
    CREATE POLICY "agents_view_own_assignments"
      ON agent_assignments
      FOR SELECT
      USING (
        agent_id = auth_helpers.get_user_agent_id()
        OR auth_helpers.user_has_role('broker')
      );

    -- INSERT: Brokers can create agent assignments
    DROP POLICY IF EXISTS "brokers_create_assignments" ON agent_assignments;
    CREATE POLICY "brokers_create_assignments"
      ON agent_assignments
      FOR INSERT
      WITH CHECK (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- UPDATE: Brokers can update agent assignments
    DROP POLICY IF EXISTS "brokers_update_assignments" ON agent_assignments;
    CREATE POLICY "brokers_update_assignments"
      ON agent_assignments
      FOR UPDATE
      USING (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- DELETE: Brokers can delete agent assignments
    DROP POLICY IF EXISTS "brokers_delete_assignments" ON agent_assignments;
    CREATE POLICY "brokers_delete_assignments"
      ON agent_assignments
      FOR DELETE
      USING (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON SCHEMA public IS 'RLS Policies Applied: 010-teams-policies.sql - Enforces team collaboration boundaries with proper access control and audit trails';
