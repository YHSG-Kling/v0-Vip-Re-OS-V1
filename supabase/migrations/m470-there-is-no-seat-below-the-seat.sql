-- m470 — THERE IS NO SEAT BELOW THE SEAT
--
-- OWNER RULING, verbatim: "you introduced member awhile back and we don't need
-- it. user is introduced with the usertype and then role just adds more
-- capability."
--
-- This REVERSES m469, which added a 15th users.user_type value, 'member', as a
-- bare seat for "a person in this workspace who has been given nothing yet".
-- m469 argued that value was missing from the model. It was not missing; it was
-- never part of the model. The owner's model has exactly two moving parts:
--
--   users.user_type            the SEAT a user is CREATED WITH. It is not a
--                              placeholder awaiting a role — it IS the role,
--                              and it already carries what that person sees.
--   user_role_assignments      ADDS capability on top of the seat.
--
-- Under that model no user ever exists without a seat, so the rung m469 built
-- underneath every seat has nobody standing on it and never could have. It is
-- removed and the constraint returns to the 14 values it admitted before.
--
-- ── WHAT IS BEING REMOVED, MEASURED ON THE LIVE CATALOGUE ───────────────────
-- Read from pg_constraint immediately before this migration:
--
--   users_user_type_check admits exactly 15 values —
--     admin, agent, broker, broker_owner, compliance_officer, contact, isa,
--     lender, member, superadmin, support, system, tc, team_lead, vendor
--
-- and the 15th is the one m469 added.
--
-- ── WHY NARROWING THIS CHECK CANNOT ORPHAN A ROW ────────────────────────────
-- Narrowing a CHECK is the dangerous direction — unlike m469's widening, a row
-- that passes today can fail tomorrow. So the question is not "did anyone use
-- it" in the abstract; it is "how many rows carry the value being withdrawn".
-- MEASURED, not assumed, on the live database:
--
--   23 users rows in total
--    0 with user_type = 'member'          ← the number this migration rests on
--    0 with user_type IS NULL
--    0 whose user_type falls outside the RESTORED 14-value list
--
--   the full live distribution, all 23 accounted for:
--     admin 3 · agent 6 · broker 1 · compliance_officer 1 · contact 4 ·
--     lender 2 · system 2 · tc 1 · team_lead 1 · vendor 2
--
--    0 rows in user_role_assignments with role = 'member' (7 grant rows exist;
--      none names this value)
--
-- Nothing is reclassified, nothing is deleted, and no account changes seat.
-- 'member' was storable for a day and nothing was ever stored as it.
--
-- ── AND NOTHING IN THE SCHEMA READS IT ──────────────────────────────────────
-- MEASURED across pg_policies, pg_proc, column defaults and every CHECK in the
-- public schema, searching for the quoted literal:
--
--   policies naming 'member' ........................ 0
--   functions naming 'member' ....................... 0
--   users columns defaulting to 'member' ............ 0
--   CHECK constraints naming 'member' ............... 3, and only ONE of them
--                                                     is this one:
--       users.users_user_type_check          ← withdrawn here
--       team_members.team_members_role_check ← UNTOUCHED
--       (team_members.role and organization_members.role also DEFAULT 'member')
--
-- THOSE OTHER TWO ARE A DIFFERENT WORD WEARING THE SAME SPELLING. `member` on
-- team_members / organization_members is a MEMBERSHIP grade inside a team —
-- 'lead' vs 'member' vs 'showing_agent' — and has nothing to do with the seat a
-- person holds in the tenant. They are deliberately not touched. Neither is
-- support_tickets' 'member_to_brokerage' lane (m468), which shares only a
-- substring.
--
-- ── WHY DROP + ADD, AND WHY THE PRE-FLIGHT ──────────────────────────────────
-- Postgres has no "shrink a CHECK" — changing the admitted set is DROP then
-- ADD, and there is a moment inside this transaction when the table has NO
-- user_type constraint. m469 recorded the same risk for the widening; it is
-- STRICTLY LARGER here, because a narrowing genuinely can be refused by live
-- data. So the violating-row count is taken FIRST, against the RESTORED list,
-- and raises a sentence naming the offending values. Inside one transaction, so
-- a failure leaves the 15-value constraint in place, untouched.
--
-- IDEMPOTENT. Safe to re-run: `drop constraint if exists` then a constraint
-- definition that does not depend on the prior state.

begin;

-- ── PRE-FLIGHT ──────────────────────────────────────────────────────────────
-- This is the check m469 could afford to treat as a formality and this one
-- cannot. A single row holding 'member' would make the ADD below fail with a
-- generic 23514; here it fails with the count and the values instead, and the
-- transaction rolls back to the constraint that admits them.
do $$
declare
  v_bad     bigint;
  v_offend  text;
begin
  select count(*),
         coalesce(string_agg(distinct u.user_type, ', '), '(none)')
    into v_bad, v_offend
  from public.users u
  where u.user_type is not null
    and u.user_type not in (
      'admin','agent','broker','broker_owner','compliance_officer','contact',
      'isa','lender','superadmin','support','system','tc','team_lead','vendor'
    );

  if v_bad > 0 then
    raise exception
      'm470: % live users row(s) carry a user_type outside the restored 14-value list (%). Narrowing this CHECK would orphan them. Reseat those users first — this migration will not leave the table unconstrained and will not delete a row to make a constraint fit.',
      v_bad, v_offend;
  end if;
end $$;

-- ── THE CONSTRAINT ──────────────────────────────────────────────────────────
-- The 14 values are the pre-m469 list, carried through VERBATIM and in the same
-- alphabetical order the catalogue already used. 'member' is simply absent, so
-- a future reader diffing this against m469 sees one removed element and not a
-- rewrite.
--
-- NULL semantics are UNCHANGED: `user_type = ANY(...)` yields NULL for a NULL
-- input and a CHECK admits NULL, exactly as both prior constraints did. This
-- migration does not make the column required; that remains a separate decision
-- with a separate blast radius.
alter table public.users drop constraint if exists users_user_type_check;

alter table public.users add constraint users_user_type_check
  check (user_type = any (array[
    'admin'::text,
    'agent'::text,
    'broker'::text,
    'broker_owner'::text,
    'compliance_officer'::text,
    'contact'::text,
    'isa'::text,
    'lender'::text,
    'superadmin'::text,
    'support'::text,
    'system'::text,
    'tc'::text,
    'team_lead'::text,
    'vendor'::text
  ]));

comment on constraint users_user_type_check on public.users is
  'The seat a user is CREATED WITH. There is no seat below it: m469 added a 15th value ''member'' as a bare rung for a user with no role, and m470 withdrew it on the owner''s ruling — "user is introduced with the usertype and then role just adds more capability". A user always has a seat, and a grant in user_role_assignments ADDS capability on top of it. 0 rows ever held ''member''. NOTE: team_members.role and organization_members.role carry their own ''member'' value — that is a membership grade inside a team, unrelated to this column, and it is untouched.';

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Read back from pg_constraint and from the tables themselves, not from this
-- file.
--
--   users_user_type_check admitted values ......... 15 → 14
--   'member' present in the admitted set .......... TRUE → false
--   the other 14 values still admitted ............ 14 of 14 (bool_and over the
--                                                   restored list against the
--                                                   new definition)
--   live users rows ............................... 23 → 23
--   rows with user_type = 'member' ................ 0 → 0
--   rows with user_type = 'agent' ................. 6 → 6
--   distinct user_type values in use .............. 10 → 10
--   grant rows in user_role_assignments ........... 7 → 7
--   team_members_role_check still admits 'member' . TRUE → TRUE  (untouched)
--   organization_members.role default ............. 'member' → 'member' (untouched)
--
-- Behaviourally, both directions. Run inside one DO block that ABORTS at the
-- end (it raises its own report as the exception), so the rollback is
-- structural rather than a delete I would then have to trust.
--
-- The block first SELECTs a real 'agent' row and aborts if it finds none, so
-- the two UPDATE cases are aimed at an id that provably exists — a zero-row
-- UPDATE raises nothing and would report a withdrawn value as still accepted,
-- which is exactly how the first m469 probe came to lie. The two INSERT cases
-- CLONE that whole row into a temp table and change only id/email/username, so
-- no unrelated NOT NULL can fail an insert and be misread as the constraint
-- firing — the other half of the same m469 bug.
--
--   CASE1 update a REAL row  → 'member' ....... REFUSED 23514   (was ACCEPTED)
--   CASE2 update the SAME row → 'tc' .......... ACCEPTED, 1 row (unchanged)
--   CASE3 insert a cloned row, user_type='member' .. REFUSED 23514 (was ACCEPTED)
--   CASE4 insert the SAME clone, user_type='agent' . ACCEPTED, 1 row (unchanged)
--   CASE5 insert team_members(role='member') .. ACCEPTED, 1 row — the OTHER
--                                               'member', proving this
--                                               migration did not reach across
--                                               tables
--
-- CASE2 and CASE4 are the ones that keep this honest. A DROP whose ADD silently
-- failed would pass CASE2 and CASE4 and FAIL to refuse CASE1 and CASE3, and the
-- window between the drop and the add is this migration's whole risk — the same
-- trap m469 recorded, in the opposite direction. Every case asserts a ROW COUNT
-- or a SQLSTATE, never merely the absence of an error.
--
-- Residue re-read after the abort: 23 users, 0 'member', 6 'agent', 1 'tc',
-- 0 rows matching the probe email, 0 team_members, 7 grant rows.
--
-- ── APPLICATION SIDE, REMOVED IN THE SAME CHANGE ────────────────────────────
--   CanonicalRole / CANONICAL_ROLES / CANONICAL_ROLE_CONFIG  lib/security/types.ts
--   UserRole union + the UserRole.MEMBER accessor            types.ts
--   the users.user_type union                                lib/auth/resolve-user-role.ts
--   NAVIGATION_BY_ROLE.member                                app/config/navigation-config.ts
--   ROLE_DASHBOARD_ROUTES.member, ROLE_LABELS.member         lib/kernel/role-routes.ts
--   ROLE_CONFIG.member                                       app/types/roles.ts
--   ROLE_HIERARCHY / ROLE_PERMISSIONS                        lib/security/permission-matrix.ts
--   ROLE_UI_PERMISSIONS / ROLE_NAVIGATION                    lib/security/permissions-service.ts
--   hiddenFields / hiddenMenuItems                           lib/security/ui-helpers.ts
--   the role label map                                       lib/security/role-manager.ts
--   the users.user_type vocabulary                           scripts/check-vocabularies.ts
--
-- WHAT SURVIVES, DELIBERATELY: `team_member: 'agent'` in LEGACY_ROLE_MAP
-- (lib/security/types.ts). That entry is INDEPENDENT of this seat. `team_member`
-- was named in four places — kernel STAFF_ROLES, the isAgent test granting
-- canEdit/canCreate, app-shell STAFF_AI_ROLES, and USER_TYPE_TO_TIER billing it
-- as tier "team" — and existed in no vocabulary at all, so all four references
-- were dead. Mapping it to 'agent' made them live. It means "a producing agent
-- who is on a team", which is the OPPOSITE of a rights-less seat, and it is
-- pinned by probes B10/B10a/B10b in scripts/role-union-nav-simulator.ts.
