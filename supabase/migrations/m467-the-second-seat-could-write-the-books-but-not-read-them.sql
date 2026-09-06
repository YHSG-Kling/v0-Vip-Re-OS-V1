-- m467 — THE SECOND SEAT COULD WRITE THE BOOKS BUT NOT READ THEM
--
-- m466 made a tenant role grant an administering fact for is_brokerage_admin(),
-- which 225 policies compose. It deliberately stopped there and flagged this
-- function for its own decision, because the role set is different and the
-- blast radius is different. Taking that decision now, because the state m466
-- left behind is INCOHERENT rather than merely incomplete:
--
--   MEASURED, after m466 and before this migration — the grant-only admin
--   (user_type 'agent' holding an 'admin' grant) could INSERT, UPDATE and
--   DELETE rows on the finance tables, and could not SELECT them.
--
-- A gate that admits a write and refuses the corresponding read is not a
-- narrower policy, it is a broken one: the person can change a number they are
-- not allowed to look at. And it contradicts the ruling head-on — the owner's
-- second seat needs "the ability to SEE all of the transactions, compliance,
-- support, admin and marketing", and seeing is precisely what this function
-- governs.
--
-- ── WHY THIS IS THE SAME CHANGE, NOT A NEW ONE ──────────────────────────────
-- MEASURED on the live catalogue:
--   can_read_brokerage_books() is composed by 24 policies over 23 tables
--   22 of them SELECT, 2 write-side
--   0 use it NEGATED — so widening cannot invert any policy's meaning
--   24 of 24 compose it beside has_brokerage_access(<row>.brokerage_id)
--
-- That last number is the one that matters, and it is the same argument m466
-- made. The zero-argument function cannot see the ROW, so it cannot pin a grant
-- to the row's brokerage. It CAN pin the grant to the CALLER's brokerage, and
-- since every one of the 24 policies already requires
-- row.brokerage_id = caller.brokerage_id beside it, the composition IS the
-- row-pinned test. One function changes; 24 policies follow; no second
-- definition of "may read the books" is forked.
--
-- ── THE ROLE SET IS THIS FUNCTION'S OWN, NOT is_brokerage_admin()'s ─────────
-- This function admits FIVE roles — admin, broker, broker_owner, broker_admin,
-- compliance_officer — where is_brokerage_admin() admits three. Reading the
-- books is a wider circle than administering the brokerage: a compliance
-- officer reads them and does not administer. The grant branch therefore
-- mirrors THIS function's set exactly. Copying the three-role set across would
-- have quietly REVOKED the compliance officer's grant path while appearing to
-- widen the function.
--
-- MEASURED: user_role_assignments.role has NO check constraint, so all five
-- values are storable as grants. The branch is reachable, not decorative.
--
-- The user_type branch is carried through UNCHANGED, values and all — every
-- account that could read the books before can still read them.
--
-- IDEMPOTENT. Safe to re-run.

begin;

create or replace function public.can_read_brokerage_books()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- coalesce WRAPS THE WHOLE OR, for the reason m465 and m466 both record: the
  -- first branch is a scalar subquery that is NULL when the caller has no users
  -- row, and `NULL or false` is NULL. RLS reads NULL as unsatisfied so it fails
  -- closed either way, but a boolean function that answers NULL is a trap for
  -- anything that composes it. Could-not-establish = no.
  select coalesce(
    -- BRANCH 1 — user_type. UNCHANGED, all five values.
    (select u.user_type in ('admin','broker','broker_owner','broker_admin','compliance_officer')
     from public.users u
     where u.id = auth.uid()
     limit 1)

    -- BRANCH 2 — a TENANT ROLE GRANT, the same fact m466 made real for the
    -- admin test, with THIS function's five-role set.
    --
    -- PINNED to current_user_brokerage_id(): a grant administering another
    -- brokerage matches nothing here and therefore reads nothing anywhere.
    --
    -- EXISTS, not a single-row read: user_role_assignments is UNIQUE on
    -- (user_id, role) and NOT on user_id, so several grants per user is legal
    -- and live. EXISTS is indifferent to how many rows match, which is exactly
    -- the property the app-side single-row copies of this rule lacked.
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin','broker','broker_owner','broker_admin','compliance_officer')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false
  );
$$;

commit;

-- ── MEASURED AFTER APPLYING ─────────────────────────────────────────────────
-- Each case run as the real account by setting the request JWT subject.
--
--   grant-only admin (user_type 'agent' + admin grant) .... false → TRUE
--   user_type 'admin' ..................................... TRUE  (unchanged)
--   plain agent, no grant ................................. false (unchanged)
--   no identity at all .................................... false, not NULL
--
-- The write/read asymmetry m466 left behind is closed: the account that could
-- change the books can now also look at them, and the account that could do
-- neither still can do neither.
