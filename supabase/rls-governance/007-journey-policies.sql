-- =====================================================
-- 007: JOURNEY & STAGES POLICIES
-- =====================================================
-- Governance: Journey stages track contact progression through the sales funnel
-- Compliance: Journey data must respect brokerage boundaries and agent assignments

-- =====================================================
-- JOURNEY STAGES POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journey_stages') THEN
    ALTER TABLE journey_stages ENABLE ROW LEVEL SECURITY;

    -- SELECT: All authenticated users can view journey stages
    DROP POLICY IF EXISTS "users_view_journey_stages" ON journey_stages;
    CREATE POLICY "users_view_journey_stages"
      ON journey_stages
      FOR SELECT
      USING (auth.uid() IS NOT NULL);

    -- INSERT: Only brokers and admins can create journey stages
    DROP POLICY IF EXISTS "brokers_create_journey_stages" ON journey_stages;
    CREATE POLICY "brokers_create_journey_stages"
      ON journey_stages
      FOR INSERT
      WITH CHECK (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- UPDATE: Only brokers and admins can update journey stages
    DROP POLICY IF EXISTS "brokers_update_journey_stages" ON journey_stages;
    CREATE POLICY "brokers_update_journey_stages"
      ON journey_stages
      FOR UPDATE
      USING (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- DELETE: Only admins can delete journey stages
    DROP POLICY IF EXISTS "admins_delete_journey_stages" ON journey_stages;
    CREATE POLICY "admins_delete_journey_stages"
      ON journey_stages
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- CONTACT JOURNEY HISTORY POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contact_journey_history') THEN
    ALTER TABLE contact_journey_history ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view journey history for contacts in their brokerage
    DROP POLICY IF EXISTS "users_view_contact_journey" ON contact_journey_history;
    CREATE POLICY "users_view_contact_journey"
      ON contact_journey_history
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = contact_journey_history.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- INSERT: System and agents can create journey history records
    DROP POLICY IF EXISTS "agents_create_journey_history" ON contact_journey_history;
    CREATE POLICY "agents_create_journey_history"
      ON contact_journey_history
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = contact_journey_history.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- UPDATE: Journey history should be immutable (no updates)
    -- DELETE: Only admins can delete journey history
    DROP POLICY IF EXISTS "admins_delete_journey_history" ON contact_journey_history;
    CREATE POLICY "admins_delete_journey_history"
      ON contact_journey_history
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- ACTIVITIES POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'activities') THEN
    ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view activities for contacts in their brokerage
    DROP POLICY IF EXISTS "users_view_activities" ON activities;
    CREATE POLICY "users_view_activities"
      ON activities
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
      );

    -- INSERT: Agents can create activities for their contacts
    DROP POLICY IF EXISTS "agents_create_activities" ON activities;
    CREATE POLICY "agents_create_activities"
      ON activities
      FOR INSERT
      WITH CHECK (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('agent')
          OR auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- UPDATE: Users can update activities they created
    DROP POLICY IF EXISTS "users_update_own_activities" ON activities;
    CREATE POLICY "users_update_own_activities"
      ON activities
      FOR UPDATE
      USING (
        created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      )
      WITH CHECK (
        brokerage_id = auth_helpers.get_user_brokerage_id()
      );

    -- DELETE: Users can delete activities they created
    DROP POLICY IF EXISTS "users_delete_own_activities" ON activities;
    CREATE POLICY "users_delete_own_activities"
      ON activities
      FOR DELETE
      USING (
        created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );
  END IF;
END $$;

-- =====================================================
-- TASKS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks') THEN
    ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view tasks assigned to them or created by them
    DROP POLICY IF EXISTS "users_view_tasks" ON tasks;
    CREATE POLICY "users_view_tasks"
      ON tasks
      FOR SELECT
      USING (
        assigned_to = auth.uid()
        OR created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: Users can create tasks
    DROP POLICY IF EXISTS "users_create_tasks" ON tasks;
    CREATE POLICY "users_create_tasks"
      ON tasks
      FOR INSERT
      WITH CHECK (
        created_by = auth.uid()
      );

    -- UPDATE: Users can update tasks assigned to them or created by them
    DROP POLICY IF EXISTS "users_update_tasks" ON tasks;
    CREATE POLICY "users_update_tasks"
      ON tasks
      FOR UPDATE
      USING (
        assigned_to = auth.uid()
        OR created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- DELETE: Users can delete tasks they created
    DROP POLICY IF EXISTS "users_delete_own_tasks" ON tasks;
    CREATE POLICY "users_delete_own_tasks"
      ON tasks
      FOR DELETE
      USING (
        created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );
  END IF;
END $$;

-- =====================================================
-- NOTES POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notes') THEN
    ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view notes for contacts in their brokerage
    DROP POLICY IF EXISTS "users_view_notes" ON notes;
    CREATE POLICY "users_view_notes"
      ON notes
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = notes.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: Users can create notes for contacts in their brokerage
    DROP POLICY IF EXISTS "users_create_notes" ON notes;
    CREATE POLICY "users_create_notes"
      ON notes
      FOR INSERT
      WITH CHECK (
        created_by = auth.uid()
        AND EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = notes.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- UPDATE: Users can update their own notes
    DROP POLICY IF EXISTS "users_update_own_notes" ON notes;
    CREATE POLICY "users_update_own_notes"
      ON notes
      FOR UPDATE
      USING (
        created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- DELETE: Users can delete their own notes
    DROP POLICY IF EXISTS "users_delete_own_notes" ON notes;
    CREATE POLICY "users_delete_own_notes"
      ON notes
      FOR DELETE
      USING (
        created_by = auth.uid()
        OR auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON SCHEMA public IS 'RLS Policies Applied: 007-journey-policies.sql - Enforces access control for journey stages, activities, tasks, and notes';
