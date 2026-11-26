-- m375 — the ads entitlement keys the ads kernel gates on never existed
--
-- lib/kernel/ads.ts gates every command on canAccessFeature(userId,
-- 'ads_campaigns') / 'ads_audiences'. Neither key had a feature_flags row: the
-- table holds 66 keys and these were not among them (app/api/admin/
-- seed-feature-flags defines only 17 and was never run for these two).
--
-- That is not a soft miss. lib/entitlements/resolve.ts:83 reads
--   if (!i.flag) return { allowed: false, reason: "Feature does not exist" }
-- so the gate DENIES EVERY USER when the row is absent. The live ads dashboard
-- (app/dashboard/campaigns/ads) survives only because it never calls the gate —
-- it loads ad_campaigns / ad_performance / facebook_custom_audiences inline with
-- no entitlement check at all. Wiring the kernel loader without these rows would
-- have taken the ads dashboard dark for every account.
--
-- OWNER RULING: ads is available on every tier. All four tier-access columns are
-- true and every limit is NULL, matching marketing_studio — the closest existing
-- analogue — so no usage cap is introduced by the back door. The entitlement
-- plumbing now EXISTS, so restricting ads later is a data change on this row
-- rather than a code change.
--
-- Idempotent: ON CONFLICT DO NOTHING, so re-running never overwrites a
-- deliberately narrowed grant.

INSERT INTO feature_flags (
  feature_key, display_name, description, category,
  solo_agent_access, team_access, brokerage_access, multi_location_access,
  solo_agent_limit, team_limit, brokerage_limit, multi_location_limit,
  superadmin_only, enabled, beta, deprecated, rollout_percentage
) VALUES
  ('ads_campaigns', 'Ads Campaigns',
   'Launch and monitor paid advertising campaigns across multiple channels',
   'marketing',
   true, true, true, true,
   NULL, NULL, NULL, NULL,
   false, true, false, false, 100),
  ('ads_audiences', 'Ads Audiences',
   'Build and manage targeted ad audiences based on CRM data and behavioral signals',
   'marketing',
   true, true, true, true,
   NULL, NULL, NULL, NULL,
   false, true, false, false, 100)
ON CONFLICT (feature_key) DO NOTHING;

-- Fail loudly rather than leaving a half-seeded entitlement: if either key is
-- still missing after the insert, the gate would silently deny every user and
-- the ads surface would go dark with no error pointing here.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(k, ', ') INTO missing
  FROM (VALUES ('ads_campaigns'), ('ads_audiences')) AS want(k)
  WHERE NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.feature_key = want.k);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'm375: ads entitlement keys still absent after seed: %', missing;
  END IF;
END $$;
