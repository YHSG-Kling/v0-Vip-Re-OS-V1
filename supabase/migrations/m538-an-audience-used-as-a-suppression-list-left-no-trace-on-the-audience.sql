-- m538 — AN AUDIENCE USED AS A SUPPRESSION LIST LEFT NO TRACE ON THE AUDIENCE
--
-- APPLICATION STATUS: APPLIED 2026-08-23 by the integrator, to live project
-- hrvaqgvukzxfskkcrwbt. The lane wrote it and correctly left it unapplied
-- (CLAUDE.md §3 — lanes write migrations; only the integrator applies them);
-- this line was flipped when it landed, because a file that says NOT APPLIED
-- about an applied migration invites a re-apply, and six migrations in the
-- preceding wave were found declaring exactly that falsehood.
--
-- MEASURED LIVE AFTER APPLYING, not assumed from a success return:
--   information_schema.columns on facebook_custom_audiences matching
--     'used_as_suppression%'  →  used_as_suppression_at,
--                                used_as_suppression_by_campaign_id
--   facebook_custom_audiences_suppression_campaign_fkey confdeltype  →  'n'
--     (SET NULL, as argued below — a pointer, not a tenant anchor)
--   facebook_custom_audiences_used_as_suppression_idx  →  present
-- POSITIVE CONTROL (§2), because a finder that returns nothing looks the same as
-- a column that is absent: the same information_schema query asked for
-- 'used_as_suppression_NOPE' returned no rows, so the two hits above are the
-- finder working, not the finder matching everything.
--
-- WHAT APPLYING IT CLEARED: test:schema-drift was failing 150 passed / 1 failed,
-- naming both columns as writes from lib/ads/audience-exclusion.ts to columns the
-- live table lacked. The guard was right and the database was behind the code —
-- which is the correct direction for that guard to fail in, and the reason the
-- code half could ship before the column existed.
--
-- ── THE OWNER RULING THIS SERVES ────────────────────────────────────────────
-- VERBATIM: "capability is vital to this os to have not exclude."
--
-- Read as written: the OS must HAVE the capability, so that it does NOT exclude
-- protected people. The code half of that is `TargetingConfig.excluded_audience_ids`
-- plus the gate at lib/ads/audience-exclusion.ts, which runs
-- `personaAdsEligibility(persona, "exclusion")` on every audience an operator
-- places in a campaign's exclude slot and REFUSES a protected-characteristic
-- persona audience there. This migration is the AUDIT half.
--
-- ── THE GAP, AS IT WAS PUBLISHED ────────────────────────────────────────────
-- Named in lib/ads/audience-source-rules.ts (above EXCLUSION_SOURCE_RULE_TYPES),
-- in lib/ads/audience-persona-basis.ts's header, and as an open seam on
-- lib/kernel/manager-registry.ts:
--
--     the product governs exclusion as DECLARED in an audience's own rule, but
--     `TargetingConfig` had `custom_audience_ids` and NO excluded-audience
--     field, and `facebook_custom_audiences` has no column recording that an
--     audience was used as a suppression list — so an operator who exported a
--     persona audience and pasted it into Meta's own "Exclude" box was outside
--     anything this system could see.
--
-- The first half of that sentence is closed in code. This closes the second: an
-- audience now carries the fact that it was used to SUPPRESS, and which campaign
-- did it. Without these columns the fact lives only inside one campaign's
-- `targeting_config` jsonb — so "was this persona audience ever used to withhold
-- a housing ad?" could only be answered by scanning every campaign's jsonb, and
-- not at all once the campaign was deleted.
--
-- ── WHY TWO COLUMNS AND NOT A COUNTER ───────────────────────────────────────
-- A `suppression_use_count` would have to be read-modify-written by application
-- code with no lock, so concurrent campaign saves would lose increments and the
-- number would be quietly wrong. A wrong number that looks like a measurement is
-- worse than no number (CLAUDE.md §2). What is recorded instead is the FACT and
-- its most recent provenance, both of which a single UPDATE can state truthfully:
--   · used_as_suppression_at          — when an audience was last placed in a
--                                       campaign's gated exclusion slot;
--   · used_as_suppression_by_campaign_id — which campaign did it.
--
-- ── ON DELETE SET NULL, AND WHY IT IS RIGHT *HERE* ──────────────────────────
-- m535's finding was that SET NULL on a TENANT ANCHOR erases the owner of a row
-- rather than deleting the child. This column is not an anchor: it is a pointer
-- to the campaign that last used this audience as a suppression list. If that
-- campaign is deleted the FACT remains true — the audience WAS used that way —
-- and only the provenance is lost, which is exactly what SET NULL says.
-- `used_as_suppression_at` deliberately survives, so a deleted campaign cannot
-- erase the record that a suppression happened. CASCADE here would do precisely
-- that: delete a campaign, and the audit trail of what it suppressed vanishes.
--
-- ── WHO WRITES AND WHO READS (CLAUDE.md §1 — neither half may be missing) ───
-- WRITERS: lib/ads/audience-exclusion.ts `recordSuppressionUse`, called from
--   · lib/kernel/ads.ts createAdCampaign
--   · lib/kernel/ads.ts updateAdCampaign
--   · lib/ads/ad-creator.ts createAdCampaign
-- READER: app/dashboard/campaigns/ads/ads-dashboard-client.tsx — the audience
--   card states, in words, that this audience has been used as an exclusion and
--   when. `loadAdsWorkspace` and `loadAudienceDefinitions` both `select("*")`,
--   so the columns reach that surface with no query change and neither query
--   breaks before this migration is applied.
--
-- ── BEFORE IT IS APPLIED ────────────────────────────────────────────────────
-- `recordSuppressionUse` is the ONLY thing that names these columns, and
-- PostgREST refuses an UPDATE naming an absent column ENTIRELY (PGRST204). That
-- refusal is READ and returned as `suppressionAuditWarning` rather than
-- swallowed (CLAUDE.md §3), and it does NOT fail the campaign: the gate that
-- decides whether the suppression may happen at all is pure code and does not
-- depend on these columns. "Not yet auditable" must not read as "not checked",
-- and it must not brick campaign creation either.
--
-- ── LIVE STATE, MEASURED 2026-08-22 (unchanged since) ───────────────────────
--     select count(*) from facebook_custom_audiences;  -- 0
-- The table is EMPTY, so no backfill is owed and no default has to be chosen for
-- existing rows. NULL means "never used as a suppression list", which is the
-- honest reading for every row that exists today.
--
-- ── VERIFY AFTER APPLYING ───────────────────────────────────────────────────
--   -- the columns exist and are nullable
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'facebook_custom_audiences'
--      and column_name like 'used_as_suppression%';
--
--   -- POSITIVE CONTROL — the stamp lands (this is what recordSuppressionUse does)
--   update facebook_custom_audiences
--      set used_as_suppression_at = now(), used_as_suppression_by_campaign_id = null
--    where id = '<a real audience uuid>';
--
--   -- NEGATIVE CONTROL — the FK is real: a campaign id that does not exist is
--   -- refused with 23503 rather than silently stored.
--   update facebook_custom_audiences
--      set used_as_suppression_by_campaign_id = '00000000-0000-0000-0000-000000000000'
--    where id = '<a real audience uuid>';

begin;

alter table public.facebook_custom_audiences
  add column if not exists used_as_suppression_at timestamptz,
  add column if not exists used_as_suppression_by_campaign_id uuid;

-- Defensive: re-running this migration must not fail on the constraint it adds.
alter table public.facebook_custom_audiences
  drop constraint if exists facebook_custom_audiences_suppression_campaign_fkey;

alter table public.facebook_custom_audiences
  add constraint facebook_custom_audiences_suppression_campaign_fkey
  foreign key (used_as_suppression_by_campaign_id)
  references public.ad_campaigns (id)
  on delete set null;

-- The audit question this exists to answer is "which audiences have ever been
-- used to suppress?", so the index is on the FACT and skips the rows that never
-- were — which today is every row.
create index if not exists facebook_custom_audiences_used_as_suppression_idx
  on public.facebook_custom_audiences (brokerage_id, used_as_suppression_at desc)
  where used_as_suppression_at is not null;

comment on column public.facebook_custom_audiences.used_as_suppression_at is
  'When this audience was last placed in a campaign''s gated exclusion slot '
  '(TargetingConfig.excluded_audience_ids). NULL means it never was. Written by '
  'lib/ads/audience-exclusion.ts recordSuppressionUse from the three campaign '
  'define doors; read onto the audience card in the ads dashboard. Exists because '
  'the product could previously govern exclusion only as DECLARED in an audience''s '
  'own source rule — an audience pasted into Meta''s Exclude box left no trace here '
  'at all. Withholding a housing ad on a protected characteristic is the restricted '
  'act (42 U.S.C. § 3604(c); HUD v. Meta), so the fact that an audience was used to '
  'suppress has to outlive the campaign that did it.';

comment on column public.facebook_custom_audiences.used_as_suppression_by_campaign_id is
  'The ad_campaigns row that last used this audience as a suppression list. '
  'ON DELETE SET NULL: deleting the campaign loses the provenance but must not '
  'erase used_as_suppression_at — the suppression still happened. This is a '
  'pointer, not a tenant anchor, which is why SET NULL is right here and was '
  'wrong in m535.';

commit;
