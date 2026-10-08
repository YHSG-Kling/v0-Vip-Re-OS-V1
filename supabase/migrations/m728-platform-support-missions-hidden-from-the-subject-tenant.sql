-- ── APPLIED LIVE 2026-10-07 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
-- m728 — PLATFORM SUPPORT MISSIONS ARE THE PLATFORM'S, NOT THE SUBJECT TENANT'S (wave 108B).
--
-- lib/platform/saas-operations.ts opens a PLATFORM-SCOPE support mission on the ONE mission service
-- (lib/kernel/missions.ts): brokerage_id = the SUBJECT tenant (missions.brokerage_id is NOT NULL and
-- the tenant IS the subject), subject_type = 'platform_support' (the platform flag — no new table,
-- no new column), owner_manager = 'platform_sentinel' (PLATFORM_MANAGERS). The code already hides it
-- from every tenant path (activeMissionsFor, sweepMissionDeadlines, the mission controller, and
-- getMission for any actor without scope 'platform'). This migration makes the DATABASE agree:
-- m710's SELECT policies admitted has_brokerage_access(brokerage_id), which would let the subject
-- tenant read the platform's diagnosis of it (churn risk, billing failure) straight from PostgREST.
--
-- Nothing else changes: writes stay REVOKEd from anon/authenticated (m710); platform admins keep
-- is_platform_admin(); tenant missions (subject_type NULL or any other value) read exactly as before.
-- Apply in TWO parts (wave 98 rule) — each part is one statement group.

-- ══════════════════════════════ PART A — missions SELECT ══════════════════════════════
DROP POLICY IF EXISTS missions_select ON public.missions;
CREATE POLICY missions_select ON public.missions
  FOR SELECT TO authenticated
  USING (
    is_platform_admin()
    OR (has_brokerage_access(brokerage_id) AND subject_type IS DISTINCT FROM 'platform_support')
  );

-- ══════════════════════════════ PART B — mission_events SELECT ══════════════════════════════
DROP POLICY IF EXISTS mission_events_select ON public.mission_events;
CREATE POLICY mission_events_select ON public.mission_events
  FOR SELECT TO authenticated
  USING (
    is_platform_admin()
    OR (
      has_brokerage_access(brokerage_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.missions m
        WHERE m.id = mission_events.mission_id AND m.subject_type = 'platform_support'
      )
    )
  );

COMMENT ON POLICY missions_select ON public.missions IS
  'm728 (wave 108B): tenants read their own missions EXCEPT platform-scope support missions (subject_type platform_support, owner platform_sentinel); platform admins read all.';
