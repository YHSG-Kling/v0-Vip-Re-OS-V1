-- m420 — asserts m419.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m419 would undo the policy rewrites it was checking. Same split as
-- m393/m395/m397/m399/m403/m405/m407/m409/m412/m414/m416/m418.
--
-- ── THE CLAIM ────────────────────────────────────────────────────────────────
--
-- EVERY policy on `commission_splits` — all four commands, and BOTH the USING
-- and WITH CHECK side of each — names the tenant. Stated as "no expression on
-- this table lacks it" rather than as a list of four names, because the defect
-- being prevented is a FIFTH policy added later without one, and a list cannot
-- see a policy that does not exist yet.
--
-- The tenant is spelled `has_brokerage_access(brokerage_id)`, which is the
-- helper this table already used on SELECT and DELETE:
--
--   has_brokerage_access(x) := is_platform_admin()
--                              OR (x IS NOT NULL AND x = current_user_brokerage_id())
--
-- Accepting only that spelling is deliberate and is the one place this file
-- pins a name rather than a shape. The reason is the multi-location question
-- the owner has open: if locations are ever modelled as separate `brokerages`
-- rows, the relationship gets taught to that ONE function and every policy here
-- inherits it. A hand-inlined `brokerage_id = current_user_brokerage_id()` would
-- pass a shape test and then silently NOT inherit the fix. So the assertion
-- requires the helper.
--
-- ── THE ONE ALLOWED EXCEPTION, NAMED ─────────────────────────────────────────
--
-- SELECT additionally admits the agent's own rows
-- (`is_agent_role() AND agent_id = current_user_agent_id()`). That is not a
-- tenant escape: an agent reading their OWN commission is the feature, and it
-- is narrower than the tenant, not wider. It is allowed because the policy ALSO
-- carries has_brokerage_access; the test below is that the helper is present,
-- not that it is the only disjunct.

do $$
declare
  offenders text[];
begin
  select coalesce(array_agg(
           p.polname || ' [' ||
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                         when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end ||
           case when coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
                     and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                then ' USING' else '' end ||
           case when coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
                     and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                then ' WITH-CHECK' else '' end || ']'
           order by p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname = 'commission_splits'
    and  ( (coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
            and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%')
        or (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
            and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%') );

  if array_length(offenders, 1) is not null then
    raise exception
      'm420: % commission_splits polic(ies)/clause(s) do not name the tenant: %. Owner ruling: commission is TENANT ONLY. A WITH CHECK without has_brokerage_access(brokerage_id) lets any brokerage admin — user_type admin/broker/broker_owner at ANY tenant — INSERT a split for another brokerage, or UPDATE one of their own and move it across the boundary by rewriting brokerage_id. A NULL brokerage_id is worse than a wrong one: has_brokerage_access rejects NULL, so an untenanted split is invisible to every reader and sits in nobody''s books. Use has_brokerage_access(brokerage_id) specifically, not an inlined equality — if multi-location brokerages are ever modelled as separate brokerages rows, that helper is the single place the relationship gets taught, and an inlined copy would not inherit it.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm420: every commission_splits policy names the tenant through has_brokerage_access(brokerage_id).';
end $$;
