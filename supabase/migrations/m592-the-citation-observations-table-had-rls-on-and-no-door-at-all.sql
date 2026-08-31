-- m592 — ai_search_landing_citation_observations: RLS ON, zero policies — a
--        locked room with no door, found the day someone built a window
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31, in the
-- same session that wrote it. Verified AFTER applying (bottom of file).
--
-- MEASURED LIVE before writing: relrowsecurity = true, pg_policies = (none).
-- Every session-client statement against this table is therefore refused —
-- which never surfaced because its only writer (the citation monitor,
-- lib/kernel/ai-search-citation-monitor.ts) runs on the SERVICE client and
-- bypasses RLS. The table was write-only BY ACCIDENT OF LOCKOUT, which is part
-- of why all seven of its non-key columns sat in census category 1a: nobody
-- could have built a tenant reader without hitting this wall.
--
-- Lane M2 built that reader (the SEO GeoTab landing-citation card, a
-- session-client read that logs its refusal per §3) — honest about the refusal
-- but permanently empty without a door. This adds the door, mirroring the
-- sibling tenant-select pattern byte-for-byte
-- (error_stack_traces_tenant_select: brokerage NULL-or-mine):
--
--   brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()
--
-- SELECT only. INSERT/UPDATE/DELETE stay unpolicied on purpose: the monitor is
-- the one writer, it is platform machinery on the service client (m409's class
-- of ruling — observation telemetry is not tenant-editable content), and adding
-- tenant write policies would invite a second, session-side writer nothing
-- needs.
--
-- AFTER-APPLY VERIFICATION:
--   select policyname, cmd, qual from pg_policies
--    where tablename='ai_search_landing_citation_observations';
--   → exactly one row, SELECT, the predicate above.
--
-- CORRECTED THE SAME DAY, BEFORE PUSH — the first spelling omitted `TO
-- authenticated`, which defaults the policy to PUBLIC: with the anon SELECT
-- grant Supabase issues by default, every platform-level row (the
-- `brokerage_id IS NULL` arm) was readable by a logged-out caller. The
-- rls-anon-tenant-escape guard caught it (A1/A2: this file was the one
-- escape declaration outside the frozen allow-list — every post-m399 file is
-- held at zero). Narrowed live via
--   ALTER POLICY … TO authenticated
-- and this CREATE corrected to match, so file and database agree again.

CREATE POLICY ai_search_landing_citation_observations_tenant_select
  ON public.ai_search_landing_citation_observations
  FOR SELECT
  TO authenticated
  USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

-- MEASURED AFTER APPLYING + CORRECTING (2026-08-31, hrvaqgvukzxfskkcrwbt):
--   ai_search_landing_citation_observations_tenant_select [SELECT]
--   roles {authenticated}
--   ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
