-- m288 — scope the CHILD tables that migration 063 left world-readable/writable.
--
-- WHAT 063 DID AND WHY THIS IS THE FOLLOW-UP
-- Migration 063 fixed a real outage: ~44 tables had RLS ENABLED but ZERO policies,
-- which denies everything, so those features were silently dead. It unblocked them
-- with `USING (TRUE)` / `WITH CHECK (TRUE)`. That was the right emergency shape for
-- platform reference data (plan_limits, state_protected_classes, prohibited_phrases,
-- subscription_tiers …) — those ARE global and stay exactly as they are.
--
-- But the same blanket was laid over CHILD tables that carry TENANT rows. Those
-- children have no brokerage_id of their own, so nothing in 063 could scope them and
-- `TRUE` was the only thing that unblocked them. The result: any authenticated user
-- could read — and on several, UPDATE — every other brokerage's rows.
--
-- The fix is the shape this database already uses correctly on
-- collaborative_search_properties: the child has no brokerage_id, so scope it through
-- an EXISTS on its PARENT, which does. has_brokerage_access() already returns
-- is_platform_admin() OR (target IS NOT NULL AND target = current_user_brokerage_id()),
-- so platform staff keep their cross-tenant view and a NULL parent brokerage denies —
-- fail-closed, not fail-open.
--
-- SAFE TO APPLY: every table below is empty at time of writing (pre-launch), so this
-- tightens a boundary rather than revoking access anyone currently has.
--
-- NOT TOUCHED, and why — no tenant anchor exists to scope BY, so a policy here would
-- be invented rather than derived. Left as-is and tracked by test:child-tenant-scope:
--   long_form_videos    — parent is `scripts`, itself global reference data
--   marketing_stats     — no FK, no brokerage_id/agent_id/user_id
--   transparency_videos — no FK, no tenant column
--   demo_persona_contacts — platform demo fixture; writes are already platform-admin
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. open_house_analytics → open_house_events (event_id)
--    Was the worst of the set: SELECT USING(true) AND UPDATE USING(true)/WITH CHECK(true)
--    on live per-event performance data (attendance, avg_lead_score,
--    serious_buyers_count, performance_insights).
DROP POLICY IF EXISTS oha_select ON public.open_house_analytics;
DROP POLICY IF EXISTS oha_ins    ON public.open_house_analytics;
DROP POLICY IF EXISTS oha_upd    ON public.open_house_analytics;

CREATE POLICY oha_select ON public.open_house_analytics FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.open_house_events e
          WHERE e.id = open_house_analytics.event_id
            AND public.has_brokerage_access(e.brokerage_id))
);
CREATE POLICY oha_ins ON public.open_house_analytics FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.open_house_events e
          WHERE e.id = open_house_analytics.event_id
            AND public.has_brokerage_access(e.brokerage_id))
);
CREATE POLICY oha_upd ON public.open_house_analytics FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.open_house_events e
          WHERE e.id = open_house_analytics.event_id
            AND public.has_brokerage_access(e.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.open_house_events e
          WHERE e.id = open_house_analytics.event_id
            AND public.has_brokerage_access(e.brokerage_id))
);

-- 2. cma_comparables → cma_reports (cma_id)
DROP POLICY IF EXISTS cmacp_upd ON public.cma_comparables;
CREATE POLICY cmacp_upd ON public.cma_comparables FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.cma_reports r
          WHERE r.id = cma_comparables.cma_id
            AND public.has_brokerage_access(r.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.cma_reports r
          WHERE r.id = cma_comparables.cma_id
            AND public.has_brokerage_access(r.brokerage_id))
);

-- 3. cma_price_adjustments → cma_reports (cma_report_id)
DROP POLICY IF EXISTS cmapa_upd ON public.cma_price_adjustments;
CREATE POLICY cmapa_upd ON public.cma_price_adjustments FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.cma_reports r
          WHERE r.id = cma_price_adjustments.cma_report_id
            AND public.has_brokerage_access(r.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.cma_reports r
          WHERE r.id = cma_price_adjustments.cma_report_id
            AND public.has_brokerage_access(r.brokerage_id))
);

-- 4. campaign_sequence_steps → campaign_sequences (sequence_id)
DROP POLICY IF EXISTS css_steps_upd ON public.campaign_sequence_steps;
CREATE POLICY css_steps_upd ON public.campaign_sequence_steps FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.campaign_sequences s
          WHERE s.id = campaign_sequence_steps.sequence_id
            AND public.has_brokerage_access(s.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.campaign_sequences s
          WHERE s.id = campaign_sequence_steps.sequence_id
            AND public.has_brokerage_access(s.brokerage_id))
);

-- 5. objection_training_turns → objection_training_sessions (session_id)
DROP POLICY IF EXISTS ott_upd ON public.objection_training_turns;
CREATE POLICY ott_upd ON public.objection_training_turns FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.objection_training_sessions s
          WHERE s.id = objection_training_turns.session_id
            AND public.has_brokerage_access(s.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.objection_training_sessions s
          WHERE s.id = objection_training_turns.session_id
            AND public.has_brokerage_access(s.brokerage_id))
);

-- 6. newsletter_seo_scores → newsletter_scheduled_sends (scheduled_send_id)
DROP POLICY IF EXISTS nss_seo_upd ON public.newsletter_seo_scores;
DROP POLICY IF EXISTS nseo_upd    ON public.newsletter_seo_scores;
CREATE POLICY nseo_upd ON public.newsletter_seo_scores FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.newsletter_scheduled_sends s
          WHERE s.id = newsletter_seo_scores.scheduled_send_id
            AND public.has_brokerage_access(s.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.newsletter_scheduled_sends s
          WHERE s.id = newsletter_seo_scores.scheduled_send_id
            AND public.has_brokerage_access(s.brokerage_id))
);

-- 7. tool_shares → saved_calculations (calculation_id)
DROP POLICY IF EXISTS tool_shares_upd    ON public.tool_shares;
DROP POLICY IF EXISTS tool_shares_select ON public.tool_shares;
CREATE POLICY tool_shares_select ON public.tool_shares FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.saved_calculations c
          WHERE c.id = tool_shares.calculation_id
            AND public.has_brokerage_access(c.brokerage_id))
);
CREATE POLICY tool_shares_upd ON public.tool_shares FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.saved_calculations c
          WHERE c.id = tool_shares.calculation_id
            AND public.has_brokerage_access(c.brokerage_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.saved_calculations c
          WHERE c.id = tool_shares.calculation_id
            AND public.has_brokerage_access(c.brokerage_id))
);

-- ── Tables that DO carry brokerage_id but were still UPDATE USING(true) ──────
-- No parent hop needed; scope on the row's own column.

DROP POLICY IF EXISTS ai_suggestions_upd ON public.ai_suggestions;
CREATE POLICY ai_suggestions_upd ON public.ai_suggestions FOR UPDATE
  USING (public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS nss_upd ON public.newsletter_scheduled_sends;
CREATE POLICY nss_upd ON public.newsletter_scheduled_sends FOR UPDATE
  USING (public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.has_brokerage_access(brokerage_id));

DROP POLICY IF EXISTS nsec_upd ON public.newsletter_sections;
CREATE POLICY nsec_upd ON public.newsletter_sections FOR UPDATE
  USING (public.has_brokerage_access(brokerage_id))
  WITH CHECK (public.has_brokerage_access(brokerage_id));

-- ── The permissive originals, dropped by their REAL names ────────────────────
--
-- Caught only by re-querying pg_policies after applying the block above: five of
-- the DROPs further up named policies that do not exist, because the 063-era names
-- differ from the convention used elsewhere (ai_suggestions_update not
-- ai_suggestions_upd; nlss_upd / nlsec_upd / nlseo_upd not nss_ / nsec_ / nseo_;
-- tool_shares_update not tool_shares_upd).
--
-- That is not cosmetic. Postgres OR's permissive policies together, so the new
-- correctly-scoped policy sat BESIDE the surviving `USING (true)` one and changed
-- nothing — the tables read as "fixed" while still being world-writable. Dropping
-- the real names is what actually closes them.
DROP POLICY IF EXISTS ai_suggestions_update ON public.ai_suggestions;
DROP POLICY IF EXISTS nlss_upd              ON public.newsletter_scheduled_sends;
DROP POLICY IF EXISTS nlsec_upd             ON public.newsletter_sections;
DROP POLICY IF EXISTS nlseo_upd             ON public.newsletter_seo_scores;
DROP POLICY IF EXISTS tool_shares_update    ON public.tool_shares;

-- ── The fact source for test:child-tenant-scope ──────────────────────────────
--
-- The guard needs pg_policies, which PostgREST will not expose. Same shape as
-- m269's assert_tenant_isolation(): a SECURITY DEFINER function the simulator
-- calls by rpc. It returns FACTS ONLY — which tables are tenant-anchored, which
-- carry a permissive policy — and the judgement (the reasoned allowlist) stays in
-- TypeScript where it can be read and argued with in review.
create or replace function public.tenant_scope_facts()
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  with own as (
    select table_name as t from information_schema.columns
    where table_schema='public' and column_name='brokerage_id'
  ),
  viafk as (
    select con.conrelid::regclass::text as t
    from pg_constraint con join pg_namespace n on n.oid=con.connamespace
    where con.contype='f' and n.nspname='public'
      and con.confrelid::regclass::text in (select t from own)
  ),
  anchored as (
    select distinct t from (select t from own union all select t from viafk) x
  ),
  permissive as (
    select p.tablename, string_agg(distinct p.cmd, ',' order by p.cmd) as cmds
    from pg_policies p
    where p.schemaname='public'
      and p.roles::text ~ '(public|authenticated)'
      and p.qual='true'
      and p.cmd in ('SELECT','UPDATE')
    group by p.tablename
  ),
  oha as (
    select policyname, coalesce(qual,'') as qual
    from pg_policies
    where schemaname='public' and tablename='open_house_analytics' and cmd='SELECT'
  )
  select jsonb_build_object(
    'anchored',   coalesce((select jsonb_agg(t order by t) from anchored), '[]'::jsonb),
    'permissive', coalesce((select jsonb_agg(jsonb_build_object('tablename',tablename,'cmds',cmds) order by tablename) from permissive), '[]'::jsonb),
    'oha_select', coalesce((select jsonb_agg(jsonb_build_object('policyname',policyname,'qual',qual)) from oha), '[]'::jsonb)
  );
$$;

revoke all on function public.tenant_scope_facts() from public;
grant execute on function public.tenant_scope_facts() to service_role;
