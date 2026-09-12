-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m535_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m535 — SET NULL DOES NOT DELETE A CHILD, IT ERASES THE TENANT THAT OWNS IT
--
-- WRITTEN, NOT APPLIED. Lanes write migrations; only the integrator applies them
-- (CLAUDE.md §3). PART 1 changes no row. PART 2 repairs two rows and is written
-- to be reviewable and skippable on its own.
--
-- THIS ALTERS BEHAVIOUR ON CORE TABLES. `contacts`, `listings`, `transactions`,
-- `users` and `messages` are all in scope. Read the blast-radius section before
-- applying. It is stated up front rather than buried because a migration that
-- touches those five tables should never be applied on the strength of a title.
--
-- ══ THE FINDING ══════════════════════════════════════════════════════════════
--
-- m533 closed the 68 tenant anchors the database was never allowed to enforce
-- (parent-shaped `brokerage_id` columns carrying NO foreign key) and named, in
-- its own "WHY RESTRICT AND NOT SET NULL" section, a second population it did
-- NOT cover:
--
--     401 of the 1784 existing foreign keys are ON DELETE SET NULL onto a
--     nullable child column, and 68 of those are brokerage_id → brokerages.
--
-- Re-measured live against hrvaqgvukzxfskkcrwbt on 2026-08-23 from
-- pg_constraint.confdeltype — 406 SET NULL foreign keys, 401 of them onto a
-- nullable column, so the count m533 declared is exact and still current.
--
-- SET NULL IS NOT A DELETE RULE. It is a rule that keeps the child ALIVE and
-- removes its parentage. For an ordinary optional pointer that is the right and
-- humane answer. For the TENANT ANCHOR it produces a row that is:
--
--     · invisible to every tenant-scoped read in the product, because every
--       policy in this schema compares against current_user_brokerage_id() and
--       `NULL = <uuid>` is NULL, never true;
--     · fully present to the service-role client, which names no tenant;
--     · billed to nobody, audited by nobody, revocable by nobody.
--
-- That is the same row m533 describes, arrived at by a different door. m533
-- closed the door where no constraint existed. This one closes the door where a
-- constraint exists and is configured to produce exactly that row.
--
-- ══ THE CLASSIFICATION — WHY 68 AND NOT 401 ══════════════════════════════════
--
-- "Is SET NULL ever right for a tenant anchor?" is a narrower question than "are
-- these 401 wrong", and the 401 do not answer to one rule. Measured live,
-- 2026-08-23, all four counts from pg_constraint:
--
--   68   brokerage_id → brokerages        WRONG. Changed by this migration.
--   16   team_id      → teams             RIGHT. NOT changed — see below.
--   58   *_by / *_user_id → users         RIGHT. NOT changed.
--    5   *_by         → agents            RIGHT. NOT changed.
--   39   agent_id     → agents            RIGHT (assignment). NOT changed.
--   88   contact/lead/listing/transaction  MIXED. NOT changed — see below.
--  127   other optional cross-links        Mostly right. NOT changed.
--
--   · THE 16 team_id FKs ARE NOT A COUNTER-EXAMPLE, THEY ARE THE CONTROL.
--     Every one of the 16 sits on a table that ALSO carries `brokerage_id`
--     (verified: 16 of 16 — ai_search_citation_observations,
--     ai_search_landing_citation_observations, commission_distributions,
--     contacts, contract_signatures, embed_widgets, learning_modules, listings,
--     organization_members, revenue_protection_snapshots, usage_events,
--     user_invitations, user_role_assignments, users, vendors, video_assets).
--     So when a team is dissolved and team_id goes NULL, the row does NOT lose
--     its jurisdiction — it reverts from team-level to brokerage-level, which is
--     a state the product has a name for and a surface for. CLAUDE.md §4 calls a
--     team a mini brokerage, and this is where that stops being literal: a team
--     has a brokerage ABOVE it, and a brokerage has nothing above it. THAT is
--     what makes brokerage_id different in kind rather than in degree, and it is
--     why this migration converts 68 and leaves 16 alone.
--
--   · THE 63 ACTOR REFERENCES ARE RIGHT AND MUST STAY. `created_by`,
--     `approved_by`, `rejected_by`, `resolved_by`, `acted_by`, `cancelled_by`,
--     `adopted_by`, `connected_by`, `updated_by`, `author_user_id`,
--     `compliance_officer_id` and the rest name WHO DID IT on a row whose whole
--     purpose is to record that it happened. CASCADE would delete the audit
--     trail when the actor leaves — the worst possible outcome for an audit
--     table. RESTRICT would make user deletion impossible. SET NULL keeps the
--     record and loses only the name, which is the correct trade and the reason
--     the rule exists at all. Changing these would be worse than the defect.
--
--   · agent_id → agents IS AN ASSIGNMENT, NOT A PARENTAGE. "Unassigned" is a
--     real, reachable, product-meaningful state: an agent leaves, and the lead
--     or listing returns to the brokerage. CLAUDE.md §5 — leads belong to the
--     BROKERAGE — is the ruling that makes this correct rather than tolerable.
--
--   · THE 88 LIFECYCLE PARENTS ARE LEFT UNRESOLVED ON PURPOSE. `listing_id` on
--     `listing_metrics` is a defining parent (a metric of no listing is noise,
--     and CASCADE is probably right); `listing_id` on a marketing asset may be a
--     soft reference where SET NULL is right. Those are 88 individual product
--     judgements, not one rule, and CLAUDE.md §1 says to write "unresolved"
--     rather than guess. They are named here so the next lane starts from a list
--     instead of re-deriving one.
--
-- ══ BLAST RADIUS, MEASURED LIVE 2026-08-23 ═══════════════════════════════════
--
--   · NOTHING TO VALIDATE. RESTRICT and SET NULL differ only in what happens
--     during a parent DELETE; neither constrains the rows that exist. A NULL
--     child value satisfies a foreign key under every delete rule, so no
--     ADD CONSTRAINT below can be refused by existing data, on any row count.
--
--   · WHAT IS THERE TODAY: brokerages 2, users 23, contacts 4, listings 3,
--     transactions 2, messages 0, teams 1. Almost every one of the 68 tables is
--     empty. A zero here is WEAK evidence and is reported as such (CLAUDE.md §2)
--     — the STRUCTURAL question is "can this orphan?", and it answers yes for
--     all 68 regardless of today's row count.
--
--   · ONE POPULATION IS NOT HYPOTHETICAL. `user_role_assignments` holds 7 rows
--     and 2 of them ALREADY have `brokerage_id IS NULL` while their user carries
--     a real brokerage (231f4e64-5022-4752-8047-696886551c35). Those two are
--     seed rows from 2026-03-13, not products of a delete — but they are a live
--     instance of the exact shape, and they demonstrate the consequence rather
--     than assert it: app/dashboard/vendors/page.tsx:263 lists portal grants
--     with `.eq("brokerage_id", profile.brokerage_id)`, so a grant whose anchor
--     is NULL cannot appear on the board the broker uses to see and revoke
--     grants, while app/portal/lender/page.tsx:22 admits the grantee on
--     `user_id` alone and never consults the anchor at all. A login the tenant
--     cannot see and cannot revoke. PART 2 repairs the two rows.
--     (Not currently exploitable: both rows also carry `vendor_id IS NULL`, so
--     neither reaches the lender-portal path today. Structural, not active.)
--
-- ══ WHY RESTRICT, AND NOT CASCADE ════════════════════════════════════════════
--
-- CASCADE is arguably the truer semantic — when a brokerage is genuinely gone,
-- its contacts and listings should go with it. RESTRICT is chosen anyway, for
-- three reasons, the third being the decisive one:
--
--   1. RESTRICT can never destroy data by accident. CASCADE on `brokerages`
--      would make a single mistaken DELETE unrecoverable across 68 tables.
--   2. It costs nothing on the live product path. Brokerage deletion is SOFT
--      everywhere in this tree (`deleted_at`; e.g. lib/platform/provider-posture
--      .ts:177 and every cron that enumerates tenants).
--   3. §6, ONE VOCABULARY PER FUNCTION. m533 already ruled RESTRICT for the
--      tenant anchor on the 68 links it added. Two migrations landing two
--      different delete rules on the same column name in the same schema would
--      be the defect §6 exists to prevent — a second spelling of one idea.
--
-- ══ INTEGRATOR — READ THIS BEFORE APPLYING ═══════════════════════════════════
--
-- THIS MIGRATION AND m533 SHARE ONE DEPENDENCY AND IT IS NOT OPTIONAL.
-- Together they make a hard `DELETE FROM brokerages` refuse whenever the tenant
-- has any child row. There are exactly TWO hard brokerage deletes in the tree
-- and both are creation-rollback paths:
--
--     app/actions/admin/create-subscriber.ts:94
--     app/actions/auth/signup-brokerage.ts:193
--
-- Both must delete their children first, or be converted to a soft delete,
-- BEFORE either migration is applied — otherwise a failed signup leaves a
-- half-created brokerage that the rollback can no longer remove, which trades
-- an orphan-child defect for an orphan-PARENT one. THOSE TWO FILES ARE OWNED BY
-- ANOTHER LANE THIS ROUND and are deliberately untouched here. If that fix has
-- not landed, apply neither m533 nor m535.
--
-- ORDER: m533 first (it ADDS the missing 68 constraints), then m535 (it
-- REPLACES 68 existing ones). They touch disjoint constraint sets — m533's are
-- columns with no FK at all, m535's are columns that already have one — so the
-- order is for reviewability, not correctness.

BEGIN;

-- ── PART 1 — 68 tenant anchors stop erasing themselves ──────────────────────
--
-- WRITTEN AS A LOOP OVER pg_constraint, NOT AS 68 HAND-COPIED PAIRS. The set is
-- DERIVED from the live catalogue at apply time, so it cannot drift from the
-- schema between the day this was written and the day it is applied, and it
-- cannot silently miss a 69th anchor added in between. Every constraint keeps
-- its own name, so nothing downstream that references a constraint by name
-- breaks.
--
-- NARROWLY SCOPED ON PURPOSE, all four predicates load-bearing:
--   confdeltype = 'n'  → only SET NULL rules; CASCADE and NO ACTION are not ours
--   attname = 'brokerage_id'   → the tenant anchor and nothing else
--   confrelid = brokerages     → the anchor's real parent, not a same-named column
--   cardinality(conkey) = 1    → a composite key is a different shape; refuse it

DO $$
DECLARE
  r          record;
  converted  int := 0;
  composite  int := 0;
BEGIN
  FOR r IN
    SELECT c.oid,
           c.conname,
           src.relname  AS child_table,
           a.attname    AS child_col,
           cardinality(c.conkey) AS keycols
    FROM pg_constraint c
    JOIN pg_class     src ON src.oid = c.conrelid
    JOIN pg_namespace n   ON n.oid   = src.relnamespace
    JOIN pg_attribute a   ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype     = 'f'
      AND c.confdeltype = 'n'
      AND n.nspname     = 'public'
      AND a.attname     = 'brokerage_id'
      AND c.confrelid   = 'public.brokerages'::regclass
    ORDER BY src.relname
  LOOP
    IF r.keycols <> 1 THEN
      -- A composite tenant anchor is a shape this migration has not reasoned
      -- about. Counted and reported, never silently rewritten.
      composite := composite + 1;
      RAISE NOTICE 'm535 SKIPPED composite FK % on %', r.conname, r.child_table;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.child_table, r.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES public.brokerages(id) ON DELETE RESTRICT',
      r.child_table, r.conname, r.child_col
    );
    converted := converted + 1;
  END LOOP;

  RAISE NOTICE 'm535 PART 1 — % tenant anchor FK(s) converted SET NULL -> RESTRICT, % composite skipped', converted, composite;

  -- FAIL LOUD ON A SURPRISE (CLAUDE.md §4 — a gate that cannot run must refuse).
  -- 68 is the count measured live on 2026-08-23. Fewer means someone already
  -- changed some of them and this migration is not describing the schema it is
  -- editing; more means the population grew and this file's evidence section is
  -- stale. Either way a human should look before the transaction commits.
  IF converted NOT BETWEEN 60 AND 76 THEN
    RAISE EXCEPTION
      'm535 ABORTED: converted % tenant anchor FKs, expected ~68 (measured live 2026-08-23). '
      'The population this migration reasoned about has changed. Re-measure before applying.',
      converted;
  END IF;
END $$;

-- ASSERT THE RESULT RATHER THAN TRUSTING THE LOOP. A migration that reports what
-- it intended instead of what it achieved is the same class of defect as a guard
-- that cannot see the code it judges.
DO $$
DECLARE remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype='f' AND c.confdeltype='n' AND n.nspname='public'
    AND a.attname='brokerage_id' AND c.confrelid='public.brokerages'::regclass;

  IF remaining <> 0 THEN
    RAISE EXCEPTION 'm535 FAILED: % brokerage_id FK(s) still ON DELETE SET NULL', remaining;
  END IF;
  RAISE NOTICE 'm535 VERIFIED — 0 tenant anchors remain on a parentage-erasing delete rule';
END $$;

-- ── PART 2 — the two role grants that are already tenant-less ───────────────
--
-- SEPARABLE FROM PART 1 AND SAFE TO SKIP. Part 1 stops NEW tenant-less rows
-- from being manufactured; this repairs the two that already exist. Neither
-- needs the other.
--
-- THESE TWO ROWS WERE NOT PRODUCED BY A DELETE — they are seed rows from
-- 2026-03-13 that were inserted without an anchor. They are repaired here
-- anyway because the consequence is identical however the NULL arrived: the
-- broker's grant board (app/dashboard/vendors/page.tsx:263) filters on
-- brokerage_id and cannot show them, so they are grants the tenant can neither
-- see nor revoke.
--
-- THE REPAIR IS DERIVED, NOT INVENTED. The anchor comes from the grantee's OWN
-- users.brokerage_id — the same tenant the account already belongs to — so this
-- moves no grant between tenants and creates no access that did not exist.
-- Guarded three ways: only rows that are already NULL, only where the user has
-- exactly one non-null brokerage, and idempotent (a re-run matches nothing).
UPDATE public.user_role_assignments ura
SET    brokerage_id = u.brokerage_id,
       updated_at   = now()
FROM   public.users u
WHERE  ura.user_id      = u.id
  AND  ura.brokerage_id IS NULL
  AND  u.brokerage_id   IS NOT NULL;

DO $$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
  FROM public.user_role_assignments WHERE brokerage_id IS NULL;
  -- REPORTED, NOT ENFORCED. A grant whose USER also has no brokerage cannot be
  -- repaired from this table and is a different finding (a tenant-less ACCOUNT,
  -- which is the shape MAINTENANCE_DOMAINS
  -- .platform_reads_platform_data_after_its_own_gate records fixing in
  -- demo-auth). Naming it beats a silent zero.
  RAISE NOTICE 'm535 PART 2 — % role grant(s) still without an anchor (their user has none either)', stranded;
END $$;

COMMIT;

-- ══ WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ═════════════════════════════
--
--   · It does not touch the 333 non-anchor SET NULL foreign keys. 63 of them
--     (actor references) are CORRECT and changing them would delete audit trails
--     or make user deletion impossible; 39 (agent assignment) are correct
--     because "unassigned" is a real state; 16 (team_id) are correct because
--     those rows keep a brokerage anchor above them; 88 (lifecycle parents) are
--     genuinely UNRESOLVED and need per-table product judgement.
--
--   · It does not add a NOT NULL to any brokerage_id column. That is the other
--     half of the anchor story and it is a much larger change: it would refuse
--     every insert that omits the tenant, including the ones that legitimately
--     do (platform-wide rows). RESTRICT closes the DELETE door; the INSERT door
--     is a separate migration with its own evidence.
--
--   · It does not convert `NO ACTION` (confdeltype 'a', 701 FKs). NO ACTION and
--     RESTRICT both refuse; the difference is only deferrability, and none of
--     these constraints is deferred. There is no defect there to fix.
