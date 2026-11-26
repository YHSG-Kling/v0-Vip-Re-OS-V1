-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m795 — tenant_safety_findings → platform staff only (split from m781 PART 2 at wave-142 integration, 2026-10-19).
-- THIS CHANGES WHAT TENANT ADMINS SEE: app/dashboard/admin/tenant-safety/page.tsx and two sibling session-client
-- readers would read [] after this; the un-counted UPDATE would report success on 0 rows. Apply ONLY together with the
-- app change that re-homes those readers to the platform console (owner call: are tenant safety findings a tenant
-- surface or a platform surface?). Until then the two policies keep their tenant roster arrays with the dead
-- 'superadmin' element removed by nothing — the arm is dead on this database (0 rows can match).

-- PART 2 — tenant_safety_findings: a platform table read by platform staff only (2 policies)
-- Apply TOGETHER WITH the re-homing of its three session-client tenant readers (see the header).
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER POLICY tenant_safety_findings_admin_select ON public.tenant_safety_findings
  USING (public.is_platform_staff());

ALTER POLICY tenant_safety_findings_admin_update ON public.tenant_safety_findings
  USING (public.is_platform_staff())
  WITH CHECK (public.is_platform_staff());
