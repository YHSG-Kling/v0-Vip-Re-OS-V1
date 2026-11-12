-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — PART 1, all 35 statements, in 5 batched calls ──
--
-- m781 — the 37 live RLS policies that still carry an inline `user_type … 'superadmin'` arm lose it
-- (wave 142, lane 142A; owner, 2026-10-18: "review migration with constraint drop on dead inline
-- superadmin user_type"; the constraint half is m782, an owner SQL-editor file).
--
-- CENSUS (read live 2026-10-18 from pg_policies on hrvaqgvukzxfskkcrwbt — the verbatim quals are in the
-- integrator's live-superadmin-policies-2026-10-18 record): 37 policies on 29 tables. 0 rows in
-- public.users carry user_type='superadmin' (the one superadmin is user_type='admin',
-- platform_role='superadmin'); public.is_platform_admin() / is_platform_staff() read platform_role
-- ONLY since m780 (live on 2026-10-14). Every arm below is therefore DEAD on this database today —
-- no identity changes; the fallback shape the owner ruled out ("never fall back to user type
-- superadmin") simply stops being expressible in a policy.
--
-- TWO SHAPES, ONE FIX EACH:
--   SHAPE P (platform arm)  `EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type
--                           = 'superadmin')`  → replaced by public.is_platform_admin() (platform staff keep
--                           access by platform_role; the dead arm goes). Where a platform_role arm already
--                           sits beside it (agentic_invocation_log, connector_health_log) the dead arm is
--                           simply removed — is_platform_admin() would restate `platform_role = 'superadmin'`.
--   SHAPE T (tenant roster) `current_user_type() = ANY (ARRAY['broker', …, 'superadmin', …])` (always AND-ed
--                           with brokerage_id = current_user_brokerage_id()) → the 'superadmin' (and the
--                           never-legal 'super_admin') element is removed; everything else byte-for-byte.
--                           Non-vocabulary spellings already present ('compliance_manager', 'team_leader',
--                           'transaction_coordinator', 'lender' in agents_read_brokerage) are LEFT AS THEY
--                           ARE and reported — removing them is a separate ruling.
--
-- THREE POLICIES HAD NO TENANT PREDICATE AT ALL (any tenant admin read/updated every tenant's rows):
--   cron_health_snapshot_admin_select, tenant_safety_findings_admin_select, tenant_safety_findings_admin_update.
--   Neither table carries brokerage_id (scripts/schema-snapshot.ts: cron_health_snapshot is keyed on
--   cron_name; tenant_safety_findings carries table_name / finding_type / affected_rows / details) — they
--   are PLATFORM operational tables, so they are gated on public.is_platform_staff().
--
-- MECHANICS: every statement is `ALTER POLICY … ON public.<table> USING (…) [WITH CHECK (…)]` — no DROP,
-- no CREATE — so the Supabase MCP applies it ONE STATEMENT PER CALL without the destructive-DDL hold.
-- IDEMPOTENT: re-running an ALTER POLICY sets the same expression again. A policy that is NOT there errors
-- loudly ("policy … does not exist"), which is the right signal: the live census drifted and must be re-read
-- before continuing. An INSERT policy takes WITH CHECK only; an ALL/UPDATE policy whose live with_check was
-- NULL takes USING only (Postgres applies USING to both); one whose with_check was set takes both.
--
-- APPLY IN TWO PARTS:
--   PART 1 (35 statements) — pure dead-arm removal. No surface changes: no live row matches the removed
--           arm, and the tenant side of every expression is unchanged. cron_health_snapshot is here too:
--           its only app readers go through the SERVICE client (app/actions/pl-truth-engine.ts:311,
--           app/actions/superadmin/platform-overview.ts:212, lib/platform/ai-ops.ts:91), so narrowing the
--           policy changes nothing a page renders.
--   PART 2 (2 statements) — tenant_safety_findings → platform staff only. THIS CHANGES WHAT TENANT ADMINS
--           SEE: three readers use the SESSION client as a tenant admin — app/actions/tenant-safety-actions.ts
--           :66/:107, app/dashboard/admin/components/tenant-safety-widget.tsx:20 and
--           app/dashboard/admin/tenant-safety/page.tsx. After PART 2 those read [] (the widget would render
--           "all clear" — a withheld read is not a clean one, CLAUDE.md §4) and the resolve action's
--           un-counted UPDATE would report success on 0 rows. Apply PART 2 together with the app change that
--           re-homes those three surfaces to platform staff (requirePlatformCapability("sentinel"), or
--           app/dashboard/superadmin/platform) — reported as an outside-lane correction by lane 142A.
--
-- VERIFY AFTER APPLYING (one query; expect 0 rows):
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(user_type|current_user_type\(\))[^)]*super_?admin';
-- and, for the three predicate-less policies (expect is_platform_staff() in every qual/with_check):
--   SELECT policyname, qual, with_check FROM pg_policies WHERE tablename IN ('cron_health_snapshot', 'tenant_safety_findings');
-- Then: scripts/cross-tenant-read-simulator.ts (test:cross-tenant-read) carries the rule — every expression
-- in this file classifies as tenant-tested or platform-gated and carries no legacy arm — with the pre-fix
-- shapes as positive controls.

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1 — SHAPE P: the platform arm becomes public.is_platform_admin() (10 policies)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER POLICY agent_intro_videos_select_brokerage ON public.agent_intro_videos
  USING ((brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY listing_promo_videos_select_brokerage ON public.listing_promo_videos
  USING ((brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY newsletter_video_renders_select_brokerage ON public.newsletter_video_renders
  USING ((brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY podcast_auto_runs_select_brokerage ON public.podcast_auto_runs
  USING ((brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY deconflict_select_brokerage ON public.deconflict_suppression_log
  USING ((brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY content_topic_bank_select_brokerage ON public.content_topic_bank
  USING ((brokerage_id IS NULL) OR (brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY content_topic_sources_select_brokerage ON public.content_topic_sources
  USING ((brokerage_id IS NULL) OR (brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

ALTER POLICY content_topic_uses_select_brokerage ON public.content_topic_uses
  USING ((brokerage_id IS NULL) OR (brokerage_id IN (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()))) OR public.is_platform_admin());

-- The platform_role arm beside the dead one already admits superadmin + support by platform_role; only the
-- dead `u.user_type = 'superadmin'` disjunct is removed.
ALTER POLICY agentic_invocation_log_select ON public.agentic_invocation_log
  USING (EXISTS (SELECT 1 FROM users u WHERE ((u.id = auth.uid()) AND ((u.platform_role = ANY (ARRAY['superadmin'::text, 'support'::text])) OR (u.brokerage_id = agentic_invocation_log.brokerage_id)))));

ALTER POLICY connector_health_log_select ON public.connector_health_log
  USING (EXISTS (SELECT 1 FROM users u WHERE ((u.id = auth.uid()) AND ((u.platform_role = ANY (ARRAY['superadmin'::text, 'support'::text])) OR (u.brokerage_id = connector_health_log.brokerage_id)))));

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1 — SHAPE T: 'superadmin' / 'super_admin' leave the roster arrays (25 policies)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER POLICY agent_pl_admin_all ON public.agent_pl_snapshot
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

-- Non-vocabulary spellings kept byte-for-byte and REPORTED: 'transaction_coordinator', 'team_leader',
-- 'compliance_manager' and 'lender' are not users_user_type_check values (lender left the CHECK in m603).
ALTER POLICY agents_read_brokerage ON public.agents
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['agent'::text, 'broker'::text, 'broker_owner'::text, 'admin'::text, 'tc'::text, 'transaction_coordinator'::text, 'team_lead'::text, 'team_leader'::text, 'compliance_officer'::text, 'compliance_manager'::text, 'isa'::text, 'lender'::text, 'vendor'::text]))))));

ALTER POLICY ai_quota_overrides_admin_insert ON public.ai_quota_overrides
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text])));

ALTER POLICY bii_admin_select ON public.brokerage_intelligence_insights
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

ALTER POLICY bii_admin_update ON public.brokerage_intelligence_insights
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text])))
  WITH CHECK (brokerage_id = public.current_user_brokerage_id());

ALTER POLICY bba_tenant_write ON public.buyer_broker_agreements
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text, 'agent'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text, 'agent'::text])));

ALTER POLICY agent_read_own_compliance_flags ON public.compliance_flags
  USING ((brokerage_id = (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()) LIMIT 1)) AND (((SELECT users.user_type FROM users WHERE (users.id = auth.uid()) LIMIT 1) = ANY (ARRAY['broker'::text, 'admin'::text, 'compliance_officer'::text])) OR (agent_id = (SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()) LIMIT 1)) OR (user_id = auth.uid())));

ALTER POLICY broker_update_compliance_flags ON public.compliance_flags
  USING ((brokerage_id = (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()) LIMIT 1)) AND ((SELECT users.user_type FROM users WHERE (users.id = auth.uid()) LIMIT 1) = ANY (ARRAY['broker'::text, 'admin'::text, 'compliance_officer'::text])));

-- NO brokerage predicate before, and the table has no brokerage_id (keyed on cron_name): a platform table.
ALTER POLICY cron_health_snapshot_admin_select ON public.cron_health_snapshot
  USING (public.is_platform_staff());

ALTER POLICY dsr_admin_write ON public.data_subject_requests
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'compliance_officer'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'compliance_officer'::text])));

ALTER POLICY la_agent_self ON public.learning_assignments
  USING ((agent_user_id = auth.uid()) OR (staff_user_id = auth.uid()) OR (contact_id IN (SELECT contacts.id FROM contacts WHERE (contacts.user_id = auth.uid()))) OR ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text]))));

ALTER POLICY lm_platform_or_owner_delete ON public.learning_modules
  USING (public.is_platform_staff() OR ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text]))));

ALTER POLICY lm_platform_or_owner_insert ON public.learning_modules
  WITH CHECK (public.is_platform_staff() OR ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text]))));

ALTER POLICY lm_platform_or_owner_update ON public.learning_modules
  USING (public.is_platform_staff() OR ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text]))))
  WITH CHECK (public.is_platform_staff() OR ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text]))));

ALTER POLICY mctr_admin_write ON public.marketing_campaign_triggers
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

ALTER POLICY ns_broker_all ON public.negotiation_strategies
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

ALTER POLICY pa_admin_select ON public.pattern_adoptions
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

ALTER POLICY training_videos_delete ON public.training_videos
  USING (public.is_platform_staff() OR ((EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['admin'::text, 'broker'::text]))))) AND (brokerage_id = public.current_user_brokerage_id())));

ALTER POLICY training_videos_insert ON public.training_videos
  WITH CHECK (public.is_platform_staff() OR ((EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['admin'::text, 'broker'::text]))))) AND (brokerage_id = public.current_user_brokerage_id())));

ALTER POLICY training_videos_update ON public.training_videos
  USING (public.is_platform_staff() OR ((EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['admin'::text, 'broker'::text]))))) AND (brokerage_id = public.current_user_brokerage_id())))
  WITH CHECK (public.is_platform_staff() OR ((EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['admin'::text, 'broker'::text]))))) AND (brokerage_id = public.current_user_brokerage_id())));

ALTER POLICY ul_agent_own ON public.usage_logs
  USING ((brokerage_id = (SELECT users.brokerage_id FROM users WHERE (users.id = auth.uid()) LIMIT 1)) AND ((agent_id = (SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()) LIMIT 1)) OR (EXISTS (SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['broker'::text, 'admin'::text])))))));

ALTER POLICY user_invitations_tenant_write ON public.user_invitations
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

ALTER POLICY vca_tenant_write ON public.vendor_contact_assignments
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text, 'agent'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text, 'agent'::text])));

ALTER POLICY vendor_invitations_tenant_insert ON public.vendor_invitations
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text, 'agent'::text])));

ALTER POLICY vendor_invitations_tenant_update ON public.vendor_invitations
  USING ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])))
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND (public.current_user_type() = ANY (ARRAY['broker'::text, 'broker_admin'::text, 'admin'::text, 'team_lead'::text])));

-- ═══════════════════════════════════════════════════════════════════════════════

-- PART 2 (tenant_safety_findings → platform staff only, 2 statements) was split out to
-- m795-tenant-safety-findings-platform-only.sql: it changes what tenant admins see and must ship with the app re-home
-- of the three session-client readers (owner call) — WRITTEN, NOT APPLIED there.
