-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150BAA ──
--
-- m999 — TEN VIEWS READ AROUND ROW-LEVEL SECURITY FOR THE ANON KEY, AND FIVE
-- CREDENTIAL STORES ADMIT EVERY SEAT OF THE TENANT (contacts and vendors too).
--
-- ── PART A: THE VIEWS (a LIVE exposure, measured 2026-11-06) ─────────────────
--
-- A Postgres view runs with its OWNER's rights unless it is declared
-- `security_invoker`. Every one of the ten below is owned by `postgres`
-- (rolbypassrls = true), carries no security_invoker option, filters on no
-- caller identity in its body, and is GRANTed SELECT to `anon` and
-- `authenticated`. So RLS on the tables underneath never runs for them.
-- Measured inside a rolled-back transaction as `anon` (the key in the browser
-- bundle): v_platform_margin 2 rows, v_brokerage_onboarding_progress 2 rows,
-- v_brokerage_ai_quota 2 rows — while `brokerages` itself, through its own RLS,
-- returned 0 rows to the same role. escalation_dashboard projects contact
-- name / phone / email; financial_dashboard_view projects commissions — both
-- empty today, both open to every tenant and to anon the day a row lands.
--
-- Every code consumer of these views reads through the SERVICE client
-- (lib/ai/fair-use.ts, lib/platform/affiliates.ts, app/actions/superadmin/
-- brokerage-management.ts, lib/marketing/social-baselines.ts,
-- lib/agents/marketing-agent.ts, lib/lifetime-customer-npv/scorer.ts), which
-- bypasses RLS and holds its own grants — so this is a STRICT narrowing for
-- anon/authenticated and a no-op for every product reader.
--
--   · security_invoker = true on all ten: a session reader now sees exactly what
--     the underlying tables' RLS shows that seat (tenant-confined, role-gated).
--   · REVOKE from anon on all ten: no logged-out caller has a use for any of them.
--   · REVOKE from authenticated on the two PLATFORM views (margin, onboarding
--     progress across every brokerage): platform staff read them via the service
--     client behind requireTenantRead / the superadmin gates.
--
-- contact_lead_history is ALREADY security_invoker (039 / m613) and is untouched.

ALTER VIEW public.ai_isa_validation_dashboard SET (security_invoker = true);
ALTER VIEW public.content_topic_persona_performance SET (security_invoker = true);
ALTER VIEW public.escalation_dashboard SET (security_invoker = true);
ALTER VIEW public.financial_dashboard_view SET (security_invoker = true);
ALTER VIEW public.newsletter_video_persona_renders SET (security_invoker = true);
ALTER VIEW public.social_post_baselines_28d SET (security_invoker = true);
ALTER VIEW public.sphere_engagement_scores SET (security_invoker = true);
ALTER VIEW public.v_brokerage_ai_quota SET (security_invoker = true);
ALTER VIEW public.v_brokerage_onboarding_progress SET (security_invoker = true);
ALTER VIEW public.v_platform_margin SET (security_invoker = true);

REVOKE ALL ON public.ai_isa_validation_dashboard FROM anon;
REVOKE ALL ON public.content_topic_persona_performance FROM anon;
REVOKE ALL ON public.escalation_dashboard FROM anon;
REVOKE ALL ON public.financial_dashboard_view FROM anon;
REVOKE ALL ON public.newsletter_video_persona_renders FROM anon;
REVOKE ALL ON public.social_post_baselines_28d FROM anon;
REVOKE ALL ON public.sphere_engagement_scores FROM anon;
REVOKE ALL ON public.v_brokerage_ai_quota FROM anon;
REVOKE ALL ON public.v_brokerage_onboarding_progress FROM anon;
REVOKE ALL ON public.v_platform_margin FROM anon;

REVOKE ALL ON public.v_brokerage_onboarding_progress FROM authenticated;
REVOKE ALL ON public.v_platform_margin FROM authenticated;

-- ── PART B: THE CREDENTIAL STORES (latent — 0 rows today) ────────────────────
--
-- lib/security/credential-rotation.ts SECRET_STORE_COLUMNS names the four secret
-- stores; calendar_provider_accounts holds the calendar OAuth link beside them.
-- Their WRITE policies already require is_tenant_staff_seat(); their SELECT
-- policies required only `brokerage_id = current_user_brokerage_id()`. Measured
-- live: every `contact` (4/4) and `vendor` (4/4) seat carries users.brokerage_id,
-- so a portal customer or a vendor could SELECT the brokerage's provider tokens
-- (sealed `enc:v1:` envelopes since wave 140H — a ciphertext is still a secret).
-- Two of them also carried the 029/030 `brokerage_id IS NULL OR` escape, so any
-- signed-in seat of ANY tenant read (and staff of any tenant wrote) untenanted
-- credential rows. The reads become the write side's own predicate; an
-- untenanted (platform-owned) credential is platform staff's alone.

ALTER POLICY agent_api_credentials_tenant_select ON public.agent_api_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY agent_api_credentials_tenant_insert ON public.agent_api_credentials
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY agent_api_credentials_tenant_update ON public.agent_api_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY agent_api_credentials_tenant_delete ON public.agent_api_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());

ALTER POLICY platform_credentials_tenant_select ON public.platform_credentials
  USING (((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat()) OR public.is_platform_staff());
ALTER POLICY platform_credentials_tenant_insert ON public.platform_credentials
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY platform_credentials_tenant_update ON public.platform_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat())
  WITH CHECK ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY platform_credentials_tenant_delete ON public.platform_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());

ALTER POLICY integration_credentials_tenant_select ON public.integration_credentials
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY social_media_accounts_tenant_select ON public.social_media_accounts
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());
ALTER POLICY calendar_provider_accounts_tenant_select ON public.calendar_provider_accounts
  USING ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat());

-- ── PART C: THE UNTENANTED-ROW ESCAPE ON FOUR CANARY SURFACES (latent) ───────
--
-- Mail campaigns, open-house events, portal access logs and lead property
-- searches still read `brokerage_id IS NULL OR …` for `authenticated`: an
-- untenanted row belongs to every signed-in seat of every tenant. 0 untenanted
-- rows today on all four (measured). The escape is removed; the tenant
-- predicate is unchanged.

ALTER POLICY direct_mail_campaigns_tenant_select ON public.direct_mail_campaigns
  USING (brokerage_id = public.current_user_brokerage_id());
ALTER POLICY open_house_events_tenant_select ON public.open_house_events
  USING (brokerage_id = public.current_user_brokerage_id());
ALTER POLICY portal_access_logs_tenant_select ON public.portal_access_logs
  USING (brokerage_id = public.current_user_brokerage_id());
ALTER POLICY lead_property_searches_tenant ON public.lead_property_searches
  USING (brokerage_id = public.current_user_brokerage_id())
  WITH CHECK (brokerage_id = public.current_user_brokerage_id());
