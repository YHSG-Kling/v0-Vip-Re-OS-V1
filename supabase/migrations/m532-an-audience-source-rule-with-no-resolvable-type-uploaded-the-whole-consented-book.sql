-- m532 — AN AUDIENCE SOURCE RULE WITH NO RESOLVABLE TYPE UPLOADED THE WHOLE
--        CONSENTED CONTACT BOOK TO META AND GOOGLE
--
-- APPLICATION STATUS: APPLIED, 2026-08-23, by the integrator.
--
-- VERIFIED LIVE AFTER APPLYING, on all eight shapes this file exists to stop:
--     a real rule type, and SQL NULL ......................... ACCEPTED
--     '{}'::jsonb (what campaign-presets defaulted to) ....... REFUSED 23514
--     an unknown type, 'null'::jsonb, a bare string,
--         a non-string type, an array ....................... REFUSED 23514
--     The two ACCEPTED cases are the positive control: a CHECK that refused
--     everything would also show six refusals and would be broken.
--
-- ── WHAT THIS BACKS UP ──────────────────────────────────────────────────────
-- `lib/kernel/ads.ts syncAudience` declared FIFTEEN `SourceRule` types and
-- narrowed its contacts query for exactly TWO. The other thirteen fell through
-- to the unnarrowed base query —
--
--     select … from contacts
--      where brokerage_id = $tenant and email is not null and tcpa_consent = true
--
-- — and that result was SHA-256 hashed and uploaded to Meta / Google Customer
-- Match on the six-hourly sync cron, under an audience name that promised a
-- narrow slice. All eleven shipped FB audience templates were affected.
--
-- The code fix is `lib/ads/audience-source-rules.ts`: every one of the fifteen
-- types now resolves to a real narrowing or REFUSES, and the resolver has no
-- permissive default arm at all. Three code doors call it (createAudienceSegment,
-- syncAudience, app/actions/campaign-presets.ts) plus the audience_members drip.
--
-- THIS MIGRATION IS THE FOURTH WALL, AND IT IS THE ONLY ONE A CODE PATH CANNOT
-- FORGET. `facebook_custom_audiences.source_rule` is plain `jsonb` with no
-- constraint whatever, so today the database will happily accept:
--
--     '{}'::jsonb                          -- what campaign-presets DEFAULTS to
--     '{"type": "everyone_please"}'::jsonb -- an unknown type
--     'null'::jsonb                        -- no rule at all
--
-- Each of those is precisely the shape that used to resolve to "everybody". A
-- future writer that bypasses all three gated doors — a manual SQL insert during
-- support, a new server action, a data import — can still create one. A CHECK
-- cannot be bypassed.
--
-- ── WHY A CHECK AND NOT A TRIGGER ───────────────────────────────────────────
-- The rule being enforced is a SHAPE, not a computation: the jsonb must carry a
-- `type` key whose value is a member of a fixed vocabulary. That is what CHECK is
-- for, it is visible to `pg_get_constraintdef` (so the vocabulary cache generator
-- can pick it up — see below), and it costs nothing per row.
--
-- ── THE VOCABULARY, AND WHERE IT COMES FROM ─────────────────────────────────
-- Exactly `SOURCE_RULE_TYPES` in lib/ads/audience-source-rules.ts, which is also
-- the source of the `SourceRule["type"]` union in lib/kernel/ads.ts (CLAUDE.md §6
-- — one vocabulary; the TS union is DERIVED from that constant, not restated).
-- Keep the three in agreement: after applying this, REGENERATE THE VOCABULARY
-- CACHE so `check-vocabulary-guard` holds code and database together
-- (CLAUDE.md §3).
--
-- Note the vocabulary admits `website_visitors`, `engagement` and
-- `consultations_completed` even though the resolver REFUSES all three. That is
-- deliberate and it is not a contradiction: those are legitimate audience KINDS
-- that this product cannot populate from its own CRM today (the first two are
-- built on the ad platform's pixel; the third has no writer — `appointments` is
-- empty and unreferenced). The database's job here is to refuse a rule that names
-- NOTHING; deciding which named rules may be populated is the resolver's, and it
-- refuses those three with a reason an operator can act on. Encoding
-- "unpopulatable today" in a CHECK would make it a schema migration to wire an
-- appointment writer, which is the wrong place for that decision to live.
--
-- ── LIVE STATE, MEASURED 2026-08-22 ─────────────────────────────────────────
--     select count(*) from facebook_custom_audiences;  -- 0
-- The table is EMPTY, so NO BACKFILL IS OWED and this cannot fail on existing
-- data. That will not stay true; apply it while it is cheap.
--
-- ── VERIFY AFTER APPLYING ───────────────────────────────────────────────────
--   -- must SUCCEED
--   insert into facebook_custom_audiences
--     (brokerage_id, audience_name, audience_type, source_rule, consent_basis, status)
--   values ('<a real brokerage uuid>', 'probe ok', 'custom',
--           '{"type":"investor_contacts","filters":{}}'::jsonb, 'probe', 'draft');
--
--   -- must each be REFUSED with 23514 (the positive control on this constraint —
--   -- a CHECK that refuses nothing reads exactly like a clean bill of health)
--   …same insert with source_rule '{}'::jsonb
--   …same insert with source_rule '{"type":"everyone_please"}'::jsonb
--   …same insert with source_rule 'null'::jsonb
--   …same insert with source_rule '"investor_contacts"'::jsonb   (a bare string)
--
--   delete from facebook_custom_audiences where audience_name = 'probe ok';

begin;

-- Defensive: re-running this migration must not fail on the constraint it adds.
alter table public.facebook_custom_audiences
  drop constraint if exists facebook_custom_audiences_source_rule_type_check;

alter table public.facebook_custom_audiences
  add constraint facebook_custom_audiences_source_rule_type_check
  check (
    -- NOT NULL-tolerant by design: `source_rule` is nullable and a NULL rule is
    -- already refused by every code door with refusalKind "no_rule". A CHECK
    -- passes on NULL regardless, so this is stated rather than implied — the
    -- guarantee this constraint makes is "if a rule is present, it names a real
    -- type", not "a rule is always present".
    source_rule is null
    or (
      -- Must be a jsonb OBJECT. `'null'::jsonb`, a bare string, a number and an
      -- array are all valid jsonb and all mean "nobody declared a rule".
      jsonb_typeof(source_rule) = 'object'
      -- …carrying a `type` key…
      and source_rule ? 'type'
      -- …whose value is a STRING (not a nested object or a number)…
      and jsonb_typeof(source_rule -> 'type') = 'string'
      -- …drawn from THE roster (lib/ads/audience-source-rules.ts SOURCE_RULE_TYPES).
      and (source_rule ->> 'type') in (
        'website_visitors',
        'contact_list',
        'engagement',
        'lifetime_customers',
        'qualified_leads',
        'active_buyers',
        'active_sellers',
        'consultations_completed',
        'open_house_attendees',
        'high_engagement_contacts',
        'investor_contacts',
        'in_pipeline',
        'lookalike_seed',
        'exclusion_active_pipeline',
        'persona_segment'
      )
    )
  );

comment on constraint facebook_custom_audiences_source_rule_type_check
  on public.facebook_custom_audiences is
  'A source rule must name a type from lib/ads/audience-source-rules.ts SOURCE_RULE_TYPES. '
  'Before this, an empty or typeless jsonb was accepted and syncAudience resolved it to every '
  'consented contact in the tenant, then uploaded them hashed to Meta/Google under the '
  'audience name. The resolver refuses that in code at three doors; this is the wall a new '
  'writer cannot forget. Deciding which named types may be POPULATED stays in the resolver.';

commit;
