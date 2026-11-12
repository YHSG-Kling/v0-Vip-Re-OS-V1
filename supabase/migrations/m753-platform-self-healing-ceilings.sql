-- ── APPLIED LIVE 2026-10-08 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
--
-- m753 — THE PLATFORM SELF-HEALING CEILING (wave 139, lane 139F; owner "approve all" (4): "self-healing
-- diagnosis/research budgets, max attempts/day, allowed remediation classes and auto-fix-vs-approval threshold
-- become tenant/platform POLICY (platform ceilings tenant cannot exceed; current defaults stay the fallback)").
--
-- SURVIVORS (no new table):
--   · the TENANT half needs NO schema: it is the versioned tenant policy key `self_healing` in
--     brokerage_settings.settings (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS), versioned in
--     tenant_policy_versions (m696) by the existing promotion path.
--   · the PLATFORM half is one jsonb column on the platform_settings SINGLETON, beside status_notice /
--     retention_offer / product_brand. Reader: lib/kernel/healing-policy.ts loadPlatformHealingCeilings
--     (→ loadHealingPolicy, the ONE reader every healer calls). Writer: setPlatformHealingCeilings, called only
--     by app/actions/superadmin/platform-controls.ts setHealingCeilingsAction (superadmin, superadmin_audit_log).
--
-- NULL = no ceiling set → the code defaults (HEALING_POLICY_DEFAULTS) ARE the ceiling — exactly today's values,
-- so applying this changes no behaviour. Before it is applied the reader sees 42703 and degrades to the same
-- defaults (said, never silently); the ceiling editor refuses to write.
--
-- Shape (validated in code by validateHealingCeilingsEdit; the CHECK below only pins that it is an object):
--   { diagnosis_cap_usd, provider_research_cap_usd, law_rule_research_cap_usd, law_rule_research_max_calls,
--     max_attempts_per_day, allowed_remediation_classes (text[] | null), auto_fix_min_confidence }
--
-- Two small parts (each one statement):

-- PART 1 — the column.
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS self_healing_ceilings jsonb;

-- PART 2 — the shape pin (an object or NULL; never a scalar / array that would read as "no ceiling").
ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_self_healing_ceilings_object_check
  CHECK (self_healing_ceilings IS NULL OR jsonb_typeof(self_healing_ceilings) = 'object');

COMMENT ON COLUMN public.platform_settings.self_healing_ceilings IS
  'Wave 139F: platform self-healing ceiling no tenant self_healing policy can exceed (lib/kernel/healing-policy.ts). NULL = code defaults.';
