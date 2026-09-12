-- m608 — EIGHTY ORPHANED-CHILD LINKS (OC1 BURN-DOWN) — APPLIED 2026-09-07
--
-- HOW IT WAS APPLIED: through the Supabase MCP as ONE loop over the same 80
-- (table, column, parent) pairs with the same three skip rules and the same
-- constraint names (<table>_<column>_fkey, ON DELETE RESTRICT) — the sixteen
-- blocks below are that loop unrolled. Read back afterwards: 77 of the 80
-- constraints exist. The THREE that do not are the text columns named in the
-- pre-step: retyping saved_properties.user_id was refused by Postgres
-- (0A000: policy sp_agent_own depends on the column), so none of the three was
-- retyped and the FK loop skipped them as non-uuid. UNRESOLVED, owner's call:
-- a text user_id under an RLS policy needs the policy dropped and recreated
-- around the retype, which is a security change, not a lane's.
--
-- Burn-down lane against scripts/orphaned-child-baseline.json category OC1 —
-- "no FK to <parent>, the schema's own graph agrees on that parent" — from the
-- 2026-09-05 baseline (98 entries). Per CLAUDE.md §7/§3: lanes WRITE migrations,
-- only the integrator APPLIES them and regenerates the schema caches. Nothing in
-- this file has been run against hrvaqgvukzxfskkcrwbt.
--
-- ── SCOPE: 80 OF THE 98 OC1 ENTRIES ────────────────────────────────────────
-- 98 baseline entries, minus:
--   · 16 FROZEN — every column on a lead_* table, plus
--     motivated_seller_signals.lead_id, nextdoor_activity.lead_id,
--     google_search_activity.lead_id, unified_lead_profile.lead_id,
--     communication_audit_log.lead_id, outcome_reconciliations.lead_id,
--     audience_members.lead_id, campaign_bundle_dispatches.lead_id — owner-frozen
--     lead-scraping/sourcing surface, untouched by instruction.
--   · 1 WRONG-PARENT FINDING, reported not silenced (same class CLAUDE.md §3
--     already names for credit_accounts.agent_id → auth.users):
--     `tax_categories.provider_account_id` votes 3/3 for `calendar_provider_accounts`
--     because the SAME column name is used by the calendar-sync tables
--     (lib/kernel/calendar-sync.ts) for an unrelated purpose. The real column, per
--     lib/finance/accounting-egress.ts:10-11,63-66 and
--     app/actions/accounting-sync.ts:427,462, holds a QuickBooks/Xero EXTERNAL
--     account id ("NEVER a fabricated account id") keyed by category_name — it is
--     an external provider id shaped exactly like `stripe_customer_id`, just
--     colliding in name with a real FK-bearing column elsewhere. Adding
--     `REFERENCES calendar_provider_accounts(id)` would be a schema defect, not a
--     fix — CLAUDE.md §1 forbids deleting to move a number and the same logic
--     forbids wiring a wrong parent to move one. Left as a reported finding for
--     the owner/next lane: either rename one of the two columns (§6, one
--     vocabulary per idea) or teach the consensus oracle about this collision.
--   · 1 CACHE DRIFT, not a missing FK: `vendor_subscriptions.brokerage_id`. The
--     census's own [recorded] block (scripts/orphaned-child-census.ts) already
--     states the live constraint exists —
--     `vendor_subscriptions_brokerage_id_fkey → public.brokerages, ON DELETE
--     CASCADE` — and that `scripts/schema-fk-map.ts` simply has not absorbed it.
--     The fix is `npm run schema:regen` against live credentials, which this lane
--     does not hold; a migration here would be a no-op at best (the idempotent
--     check below would skip it) and is not the actual defect.
-- 98 − 16 − 1 − 1 = 80, all added below.
--
-- ── ON DELETE RESTRICT, same reasoning as m533 ─────────────────────────────
-- RESTRICT is the fail-closed default (CLAUDE.md §4): none of these 80 links have
-- a product ruling asking for a cascade or a nulled-parentage row, and `SET NULL`
-- is the exact orphan-factory shape OC2 already flags on the tenant anchor — m533
-- declined to add more of those "under the name of a fix" and this migration
-- makes the same choice for the same reason. A hard `.delete()` on any of the 9
-- parent tables named below (agents, contacts, transactions, listings, teams,
-- vendors, offers, ad_campaigns, users) that this lane could find in app code is
-- confined to test/demo seed simulators (scripts/*-simulator.ts,
-- scripts/demo-seed-and-run.ts) — none in a request-serving path — so RESTRICT
-- costs nothing on the live product path today. If the integrator finds a live
-- hard-delete path onto one of these parents, that path needs the same rollback
-- treatment m533 gave app/actions/admin/create-subscriber.ts and
-- app/actions/auth/signup-brokerage.ts BEFORE this applies.
--
-- ── ROW-COUNT / ORPHAN EVIDENCE: MEASURED LIVE BEFORE APPLYING (2026-09-07) ────
-- All 80 (child.column -> parent) pairs were counted on hrvaqgvukzxfskkcrwbt with
-- `LEFT JOIN parent WHERE child.col IS NOT NULL AND parent.id IS NULL`: 80 of 80
-- carry ZERO orphaned rows. 77 columns are uuid. THREE are TEXT columns with zero
-- non-null rows — journey_states.user_id, saved_properties.user_id,
-- agent_commissions.approved_by — so a uuid FK cannot be declared on them as they
-- stand; the pre-step below retypes exactly those three to uuid (idempotent: only
-- when the column is still text, and only when it holds no non-null value, so no
-- row can be miscast) before the FK blocks run. The earlier note follows as the
-- lane wrote it.
-- ── (lane note) ROW-COUNT / ORPHAN EVIDENCE: NOT MEASURED AT WRITING (§2) ────
-- This lane holds no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, so unlike m533 —
-- which measured "1 row, 1 with a value, 0 orphaned" before writing its ADD
-- CONSTRAINT — the actual row/orphan counts behind these 80 links were NOT
-- measured live. Each loop below is HARD ON DATA: if a table on it holds even one
-- row whose value already fails to resolve, `ADD CONSTRAINT` will refuse to apply
-- (fail loudly) rather than silently accepting bad data. The integrator should
-- expect some of these 80 to need a data cleanup pass before they validate, and
-- should re-run the measurement m533 did (a `LEFT JOIN ... WHERE parent IS NULL`
-- per pair) before applying if a clean run matters more than an honest failure.
--
-- ── GROUPED BY COLUMN NAME, ONE DO BLOCK PER (column, parent) PAIR ─────────
-- Same idempotent, fail-soft-on-shape pattern as m533: skips a table that lost
-- the column or the table itself (another lane's migration reshaped it first),
-- skips a table that already carries the FK (another lane got there first), and
-- otherwise adds it. NO EXPLICIT BEGIN/COMMIT — the migration runner already
-- wraps the file in one transaction, so all-or-nothing across every block below
-- (a COMMIT here would close that outer transaction early).
--
-- AFTER APPLYING: regenerate the schema caches — they are GENERATED, NEVER
-- HAND-EDITED (CLAUDE.md §3) — with `npm run schema:regen`, then retighten:
--   ORPHANED_CHILD_BASELINE=1 npx tsx scripts/orphaned-child-census.ts
-- Expected movement: OC1 falls by up to 80 (bounded by how many of these 80
-- tables are in scripts/schema-snapshot.ts, which is `referenced ∩ live` — a
-- table the code never queries is invisible to the offline census even once
-- protected). The direction is DOWN and the cause is "the database was given the
-- constraint" — never a deletion.


-- ── PRE-STEP: three text columns that should have been uuid ──────────────────
DO $$
DECLARE r record; nn bigint; ty text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('journey_states','user_id'),('saved_properties','user_id'),('agent_commissions','approved_by')) v(t,c) LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO ty FROM pg_attribute a JOIN pg_class cl ON cl.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public' AND cl.relname=r.t AND a.attname=r.c AND NOT a.attisdropped;
    IF ty IS DISTINCT FROM 'text' THEN RAISE NOTICE 'm608: %.% is % — no retype', r.t, r.c, ty; CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL', r.t, r.c) INTO nn;
    IF nn > 0 THEN RAISE NOTICE 'm608: %.% is text with % non-null row(s) — NOT retyped, FK block will skip it', r.t, r.c, nn; CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE uuid USING NULLIF(%I, '''')::uuid', r.t, r.c, r.c);
    RAISE NOTICE 'm608: %.% retyped text -> uuid (0 rows)', r.t, r.c;
  END LOOP;
END $$;

-- ── agent_id → agents (20 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'agent_retention_scores',
    'agent_tax_profile',
    'ai_generated_content',
    'buyer_move_cases',
    'challenge_participants',
    'contact_consent_events',
    'email_campaigns',
    'form_submissions',
    'investor_deal_matches',
    'lifecycle_events',
    'listing_presentations',
    'newsletter_teasers',
    'podcast_show_settings',
    'predictive_listing_actions',
    'predictive_listing_scores',
    'scheduled_touchpoints',
    'transaction_communications',
    'user_role_assignments',
    'wealth_advisor_recommendations',
    'weekly_plans'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'agent_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no agent_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'agent_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, agent_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (agent_id) '
      'REFERENCES public.agents(id) ON DELETE RESTRICT',
      t, t || '_agent_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % agent_id -> agents foreign key(s) of 20 expected', n;
END
$$;

-- ── contact_id → contacts (6 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'audience_members',
    'campaign_bundle_dispatches',
    'contact_property_insights',
    'investor_deal_matches',
    'presentation_sections',
    'video_scripts_library'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'contact_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no contact_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'contact_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, contact_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (contact_id) '
      'REFERENCES public.contacts(id) ON DELETE RESTRICT',
      t, t || '_contact_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % contact_id -> contacts foreign key(s) of 6 expected', n;
END
$$;

-- ── transaction_id → transactions (6 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'buyer_move_cases',
    'client_portal_messages',
    'closing_cost_accuracy_observations',
    'net_sheet_reconciliations',
    'policy_decisions',
    'vendor_reviews'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'transaction_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no transaction_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'transaction_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, transaction_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (transaction_id) '
      'REFERENCES public.transactions(id) ON DELETE RESTRICT',
      t, t || '_transaction_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % transaction_id -> transactions foreign key(s) of 6 expected', n;
END
$$;

-- ── listing_id → listings (3 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'activities',
    'client_documents',
    'video_scripts_library'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'listing_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no listing_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'listing_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, listing_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (listing_id) '
      'REFERENCES public.listings(id) ON DELETE RESTRICT',
      t, t || '_listing_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % listing_id -> listings foreign key(s) of 3 expected', n;
END
$$;

-- ── team_id → teams (5 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'challenges',
    'newsletter_templates',
    'podcast_distribution_channels',
    'subscriber_service_areas',
    'tenant_phone_numbers'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'team_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no team_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'team_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, team_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (team_id) '
      'REFERENCES public.teams(id) ON DELETE RESTRICT',
      t, t || '_team_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % team_id -> teams foreign key(s) of 5 expected', n;
END
$$;

-- ── vendor_id → vendors (1 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'user_role_assignments'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'vendor_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no vendor_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'vendor_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, vendor_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (vendor_id) '
      'REFERENCES public.vendors(id) ON DELETE RESTRICT',
      t, t || '_vendor_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % vendor_id -> vendors foreign key(s) of 1 expected', n;
END
$$;

-- ── offer_id → offers (1 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'net_sheet_reconciliations'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'offer_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no offer_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'offer_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, offer_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (offer_id) '
      'REFERENCES public.offers(id) ON DELETE RESTRICT',
      t, t || '_offer_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % offer_id -> offers foreign key(s) of 1 expected', n;
END
$$;

-- ── ad_campaign_id → ad_campaigns (1 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'ad_performance_history'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'ad_campaign_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no ad_campaign_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'ad_campaign_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, ad_campaign_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (ad_campaign_id) '
      'REFERENCES public.ad_campaigns(id) ON DELETE RESTRICT',
      t, t || '_ad_campaign_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % ad_campaign_id -> ad_campaigns foreign key(s) of 1 expected', n;
END
$$;

-- ── user_id → users (4 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'document_downloads',
    'journey_states',
    'saved_properties',
    'video_generation_queue'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no user_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'user_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, user_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_user_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % user_id -> users foreign key(s) of 4 expected', n;
END
$$;

-- ── agent_user_id → users (5 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'calendar_events',
    'facebook_custom_audiences',
    'remotion_composition_renders',
    'subscriber_service_areas',
    'tenant_phone_numbers'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'agent_user_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no agent_user_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'agent_user_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, agent_user_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (agent_user_id) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_agent_user_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % agent_user_id -> users foreign key(s) of 5 expected', n;
END
$$;

-- ── actor_user_id → users (2 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'superadmin_audit_log',
    'tenant_transition_log'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'actor_user_id' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no actor_user_id column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'actor_user_id'
    ) THEN
      RAISE NOTICE 'm608: skipping %, actor_user_id already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (actor_user_id) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_actor_user_id_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % actor_user_id -> users foreign key(s) of 2 expected', n;
END
$$;

-- ── created_by → users (15 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'ad_retarget_presets',
    'agent_credentials',
    'ai_assistant_notes',
    'campaign_bundles',
    'challenges',
    'direct_mail_presets',
    'document_folders',
    'email_campaigns',
    'email_presets',
    'platform_social_drafts',
    'podcast_episode_presets',
    'portal_push_presets',
    'sms_presets',
    'social_post_presets',
    'voicedrop_presets'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'created_by' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no created_by column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'created_by'
    ) THEN
      RAISE NOTICE 'm608: skipping %, created_by already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (created_by) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_created_by_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % created_by -> users foreign key(s) of 15 expected', n;
END
$$;

-- ── approved_by → users (2 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'agent_commissions',
    'asset_manager_actions'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'approved_by' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no approved_by column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'approved_by'
    ) THEN
      RAISE NOTICE 'm608: skipping %, approved_by already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (approved_by) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_approved_by_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % approved_by -> users foreign key(s) of 2 expected', n;
END
$$;

-- ── resolved_by → users (4 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'compliance_alerts',
    'proactive_interventions',
    'transaction_compliance_log',
    'transaction_pending_actions'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'resolved_by' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no resolved_by column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'resolved_by'
    ) THEN
      RAISE NOTICE 'm608: skipping %, resolved_by already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (resolved_by) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_resolved_by_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % resolved_by -> users foreign key(s) of 4 expected', n;
END
$$;

-- ── completed_by → users (3 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'closing_checklist_items',
    'transaction_deadlines',
    'transaction_tasks'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'completed_by' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no completed_by column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'completed_by'
    ) THEN
      RAISE NOTICE 'm608: skipping %, completed_by already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (completed_by) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_completed_by_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % completed_by -> users foreign key(s) of 3 expected', n;
END
$$;

-- ── updated_by → users (2 tables) ──────────────────────────────
DO $$
DECLARE
  t text;
  n int := 0;
  targets text[] := ARRAY[
    'newsletter_cadence_policy',
    'social_cadence_policy'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_by' AND NOT a.attisdropped
      WHERE c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'm608: skipping %, no such table or no updated_by column', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND c.relname = t AND a.attname = 'updated_by'
    ) THEN
      RAISE NOTICE 'm608: skipping %, updated_by already has a foreign key', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (updated_by) '
      'REFERENCES public.users(id) ON DELETE RESTRICT',
      t, t || '_updated_by_fkey'
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'm608: added % updated_by -> users foreign key(s) of 2 expected', n;
END
$$;
