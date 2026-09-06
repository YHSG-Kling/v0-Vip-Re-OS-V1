-- m469 — A USER WITH NO ROLE NEEDS A SEAT TO BE CREATED INTO
--
-- OWNER RULING, verbatim: "users are users with no rights except seeing their
-- own work but once you give them a role, that is what determines what they can
-- see and do."
--
-- The owner then chose, explicitly, between the two readings of that sentence
-- and picked THIS one: users.user_type is the SEAT, and a role grant ADDS ON
-- TOP. An account created as 'agent' / 'tc' / 'broker' already HAS its role —
-- the seat it was created as — and a grant in user_role_assignments adds a
-- business responsibility beside it. The other reading (any user without a
-- grant drops to minimal) was REJECTED, and this migration does not implement
-- it: it adds a value, it does not change the meaning of any existing one.
--
-- ── WHY A NEW VALUE IS NEEDED AT ALL ────────────────────────────────────────
-- MEASURED on the live catalogue before this migration:
--
--   users_user_type_check admits exactly 14 values —
--     admin, agent, broker, broker_owner, compliance_officer, contact, isa,
--     lender, superadmin, support, system, tc, team_lead, vendor
--
-- Every one of those 14 is either a business seat (it comes with work to do), a
-- platform/service identity (superadmin, support, system), or an external
-- persona (contact, lender, vendor). There is NO value that means "a person in
-- this workspace who has been given nothing yet". So the rights-less user the
-- ruling describes was, until now, unstorable: creating one meant picking a
-- seat that grants surfaces, and the cheapest wrong answer — 'agent' — hands
-- them a producing agent's entire workspace.
--
-- 'member' is that missing value.
--
-- ── WHAT THIS CANNOT BREAK, MEASURED, NOT ASSUMED ───────────────────────────
--   23 users on the live database
--    0 with user_type IS NULL
--    0 whose user_type is outside the NEW 15-value list
--    0 already holding 'member' (so nothing is retro-classified)
--   19 of the 23 hold ZERO rows in user_role_assignments — including the
--      broker, the tc, the compliance officer and all six agents
--    7 grant rows in total, over 4 users
--
-- Those 19 are the number that matters. Widening a CHECK constraint cannot
-- narrow a row that already passes it, and no policy in this schema tests
-- `user_type = 'member'`, so 'member' matches nothing anywhere and the seat
-- fails CLOSED by construction — a member reaches a gated surface only if some
-- future policy names them, or if they are granted a role, which is exactly the
-- ruling. NOTHING CHANGES for the 19.
--
-- ── WHY DROP + ADD, AND WHY THE PRE-FLIGHT ──────────────────────────────────
-- Postgres has no "extend a CHECK" — changing the admitted set is DROP then
-- ADD. That means there is a moment inside this transaction when the table has
-- NO user_type constraint, and if the ADD then failed the transaction would
-- roll back to the old constraint (safe) but the operator would learn about it
-- from a generic 23514. So the violating-row count is taken FIRST, against the
-- NEW list, and raises a sentence that names the offending values. Inside one
-- transaction, so a failure leaves the old constraint in place untouched.
--
-- IDEMPOTENT. Safe to re-run: `drop constraint if exists` then a constraint
-- definition that does not depend on the prior state.

begin;

-- ── PRE-FLIGHT ──────────────────────────────────────────────────────────────
-- Runs BEFORE the drop. A widening should never find a violator; "should
-- never" is not a check, and this is the one migration shape where being wrong
-- leaves a table unconstrained.
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
      'isa','lender','member','superadmin','support','system','tc','team_lead','vendor'
    );

  if v_bad > 0 then
    raise exception
      'm469: % live users row(s) carry a user_type outside the new 15-value list (%). The new list is a strict SUPERSET of the old 14, so a violator here means a row was written while the constraint was absent. Reconcile those rows before re-running; this migration will not leave the table unconstrained.',
      v_bad, v_offend;
  end if;
end $$;

-- ── THE CONSTRAINT ──────────────────────────────────────────────────────────
-- The 14 existing values are carried through VERBATIM and in the same order.
-- 'member' is inserted in the same alphabetical position the rest of the list
-- already uses, so a future reader diffing this against the catalogue sees one
-- added element and not a rewrite.
--
-- NULL semantics are UNCHANGED: `user_type = ANY(...)` yields NULL for a NULL
-- input and a CHECK admits NULL, exactly as the previous constraint did. This
-- migration does not make the column required; that is a different decision
-- with a different blast radius.
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
    'member'::text,
    'superadmin'::text,
    'support'::text,
    'system'::text,
    'tc'::text,
    'team_lead'::text,
    'vendor'::text
  ]));

comment on constraint users_user_type_check on public.users is
  'The seat a user was created as. m469 added ''member'': the seat for a person with no business role and no grant, who sees only their own work (own profile, own notifications, own notification settings — see NAVIGATION_BY_ROLE.member in app/config/navigation-config.ts). Owner ruling: user_type is the SEAT and a role grant in user_role_assignments ADDS ON TOP, so ''agent''/''tc''/''broker'' already carry their role and are unaffected. ''member'' is named by no policy in this schema, so the seat fails closed: a member reaches a business surface only by being granted a role.';

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Read back from pg_constraint and from the table itself, not from this file.
--
--   users_user_type_check admitted values ......... 14 → 15
--   'member' present in the admitted set .......... false → TRUE
--   the other 14 values still admitted ............ 14 of 14 (bool_and over the
--                                                   old list against the new def)
--   live users rows ............................... 23 → 23
--   rows with user_type = 'member' ................ 0 → 0 (nothing reclassified)
--   users holding ZERO role grants ................ 19 → 19
--   grant rows in user_role_assignments ........... 7 → 7
--   rows with user_type = 'agent' ................. 6 → 6
--
-- Behaviourally, both directions. Run inside one DO block that ABORTS at the
-- end, so the rollback is structural rather than a delete I would then have to
-- trust; residue re-read afterwards: 0 rows, 23 users, 6 agents.
--
--   insert users(user_type='member') ......... ACCEPTED, 1 row  (was 23514)
--   insert users(user_type='not_a_seat') ..... REFUSED 23514    (unchanged)
--   update a REAL row to 'not_a_seat' ........ REFUSED 23514    (unchanged)
--   update an existing agent → 'member' ...... ACCEPTED, 1 row
--
-- Lines 2 and 3 are the ones that keep this honest, and line 3 is there because
-- the first attempt at this probe LIED. Its 'member' insert failed on an
-- unrelated NOT NULL (23502), the following UPDATE therefore matched zero rows,
-- and a zero-row UPDATE raises nothing — so the probe reported the unlisted
-- value as ACCEPTED and the constraint as MISSING. It was neither. Every case
-- above now asserts a ROW COUNT, not merely the absence of an error, and case 3
-- is aimed at a row that provably exists.
--
-- Widening a CHECK is only safe if it is still a check: a constraint dropped
-- and not re-added would pass cases 1 and 4 and fail to refuse 2 and 3, and the
-- window between the drop and the add is this migration's whole risk.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- It grants nothing. No policy, no boolean helper and no RLS predicate in this
-- schema names 'member', so this migration adds a storable value and zero
-- access. The seat's actual surfaces are defined in application navigation, and
-- everything beyond them still requires a role grant — which is the ruling.
