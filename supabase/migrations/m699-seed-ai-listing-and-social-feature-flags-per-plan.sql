-- ── APPLIED LIVE 2026-10-05 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) ──
-- m699 (wave 102, lane 102C — owner answer 1, 2026-10-05): the two AI-content entitlement keys the
-- code gates on never had a feature_flags row.
--
-- app/actions/ai-content-generation.tsx gates generateListingDescription on
--   mayUseFeature(userId, "ai_listing_generation")   and generateSocialContent on
--   mayUseFeature(userId, "ai_social_content")
-- (through lib/billing/billing-access.ts → lib/kernel/0.1-feature-access.ts canAccessFeature). A
-- missing row is not a soft miss: lib/entitlements/resolve.ts refuses with "Feature does not exist",
-- so BOTH surfaces have refused every user on every plan (lane 101C's live read, 2026-10-04: no row
-- for either key). Owner ruling (wave 102): "YES, seed per plan."
--
-- SHAPE: the generated schema cache (scripts/schema-snapshot.ts, feature_flags) lists the columns
--   beta, brokerage_access, brokerage_limit, category, created_at, deprecated, description,
--   display_name, enabled, feature_key, id, multi_location_access, multi_location_limit,
--   rollout_percentage, solo_agent_access, solo_agent_limit, sunset_date, superadmin_only,
--   team_access, team_limit, updated_at
-- The plan access MIRRORS THE LIVE `ai_content_generation` ROW (the sibling gate in the same
-- action file): the four tier-access flags, the four tier limits, enabled, superadmin_only, beta,
-- deprecated, rollout_percentage and category are COPIED from that row at apply time, never
-- retyped here — so if the owner narrows ai_content_generation before this is applied, the two new
-- keys inherit the narrowed grant. (Its seed, scripts/900-seed-layer8-feature-flags.sql, shipped
-- category 'ai', all four tiers true, no limits, enabled, not beta, not deprecated.)
--
-- IDEMPOTENT: INSERT … SELECT … WHERE NOT EXISTS + ON CONFLICT (feature_key) DO NOTHING, so a
-- re-run never overwrites a deliberately narrowed grant. FAILS LOUDLY if the template row is
-- absent or either key is still missing afterwards (the gate would otherwise keep refusing in
-- silence).
--
-- Applies in one part (data only; no DDL, no index, no trigger).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_flags WHERE feature_key = 'ai_content_generation') THEN
    RAISE EXCEPTION 'm699: template row ai_content_generation is absent — seed it first (scripts/900-seed-layer8-feature-flags.sql) so the new keys mirror a real plan grant';
  END IF;
END $$;

INSERT INTO feature_flags (
  feature_key, display_name, description, category,
  solo_agent_access, team_access, brokerage_access, multi_location_access,
  solo_agent_limit, team_limit, brokerage_limit, multi_location_limit,
  superadmin_only, enabled, beta, deprecated, rollout_percentage
)
SELECT
  want.feature_key, want.display_name, want.description, t.category,
  t.solo_agent_access, t.team_access, t.brokerage_access, t.multi_location_access,
  t.solo_agent_limit, t.team_limit, t.brokerage_limit, t.multi_location_limit,
  t.superadmin_only, t.enabled, t.beta, t.deprecated, t.rollout_percentage
FROM feature_flags t
CROSS JOIN (VALUES
  ('ai_listing_generation', 'AI Listing Descriptions',
   'Generate MLS / marketing listing descriptions with the brokerage brand voice (app/actions/ai-content-generation.tsx generateListingDescription)'),
  ('ai_social_content', 'AI Social Content',
   'Generate platform-specific social posts with the brokerage brand voice (app/actions/ai-content-generation.tsx generateSocialContent)')
) AS want(feature_key, display_name, description)
WHERE t.feature_key = 'ai_content_generation'
  AND NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.feature_key = want.feature_key)
ON CONFLICT (feature_key) DO NOTHING;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO missing
  FROM (VALUES ('ai_listing_generation'), ('ai_social_content')) AS want(k)
  WHERE NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.feature_key = want.k);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'm699: AI content entitlement keys still absent after seed: %', missing;
  END IF;
END $$;
