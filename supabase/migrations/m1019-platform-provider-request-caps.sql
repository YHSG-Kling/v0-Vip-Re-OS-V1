-- ── APPLIED LIVE 2026-11-25 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 156, lane 156G. Applied by the integrator (additive: one nullable column + a shape CHECK). ──
--
-- m1019 — THE PLATFORM'S OWN PROVIDER REQUEST CEILINGS (directive 156G: "RentCast explicitly states it does not supply a
-- built-in hard overage cap: VIPAgents must enforce its own").
--
-- RentCast, verbatim (developers.rentcast.io/reference/billing-and-pricing, read 2026-11-25): "We do not currently support hard
-- usage caps or automatic API request blocking when you reach your current plan's monthly request limit."
--
-- SURVIVOR EXTENDED (no new table): one jsonb column on the platform_settings SINGLETON, beside acquisition_budget_caps (m976)
-- and self_healing_ceilings (m753) — the same idiom. Reader: lib/property/rentcast-eligibility.ts reserveRentcastPlatformRequest,
-- asked immediately before every real RentCast egress (the REST door in lib/property/rentcast.ts and the MCP tool door in
-- lib/external/rentcast-ai-tools.ts) and before the billed connector-health probe (lib/agentic-os/connector-probe.ts). The
-- editor is the platform console (app/dashboard/superadmin/connector-healing, setRentcastRequestCapAction).
--
-- Shape: { "rentcast": { "monthly_requests": <integer ≥ 1 or null>, "billing_anchor_day": <1–31 or null>, "set_by": <users.id>, "set_at": <iso> } }
-- (billing_anchor_day = the RentCast plan's activation day; null = the calendar month in UTC. Writer: app/actions/superadmin/
-- platform-controls.ts setRentcastRequestCapAction — superadmin-gated, audited, receipted; validator validateRentcastCapEdit.)
--
-- NULL (or no rentcast.monthly_requests) = the requests INCLUDED in the plan the repo prices RentCast at (Foundation, 1,000 —
-- RENTCAST_PLAN_INCLUDED_REQUESTS), i.e. ZERO paid overage until the owner authorizes some. Before this is applied the reader
-- sees 42703 / PGRST204 and applies that same plan-included ceiling (said in the verdict's capSource). Any OTHER read error
-- refuses the request (fail closed).
--
-- Tenant column / row security: platform_settings is the platform singleton (id boolean) with no tenant column and its
-- existing policies; this adds a column only and changes no policy.

ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS provider_request_caps jsonb;

ALTER TABLE public.platform_settings DROP CONSTRAINT IF EXISTS platform_settings_provider_request_caps_object_check;
ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_provider_request_caps_object_check
  CHECK (provider_request_caps IS NULL OR jsonb_typeof(provider_request_caps) = 'object');

COMMENT ON COLUMN public.platform_settings.provider_request_caps IS
  'Wave 156G: the platform''s own monthly request ceilings per provider (RentCast has no vendor-side cap). NULL = the plan''s included requests, zero paid overage. Reader: lib/property/rentcast-eligibility.ts reserveRentcastPlatformRequest.';
