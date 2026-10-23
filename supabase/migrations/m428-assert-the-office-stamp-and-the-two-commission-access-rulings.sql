-- m428 — asserts m427.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m427 would undo the DDL and the policy rewrites it was checking. Same
-- split as m393/m395/m397/m399/m403/m405/m407/m409/m412/m414/m416/m418/m420/
-- m422/m424/m426.
--
-- Every claim below pins a CONSTRUCT — a column shape, a foreign-key action, a
-- class of policy predicate, the presence of a named helper whose whole purpose
-- is to be the single place a rule lives. None pins a select-list, a column
-- order, or a list of table names, because guards that pin spellings go red on
-- strictly better code.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — THE OFFICE STAMP IS A NULLABLE FK THAT SURVIVES ITS OFFICE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three properties, and each of the three is load-bearing:
--
--   uuid + FK to locations   — it is a real office, not a free-text label that
--                              can drift out of the locations table.
--   NULLABLE                 — an agent may genuinely not be pinned to an
--                              office. NOT NULL would make the split insert FAIL
--                              for that agent and take the commission ledger
--                              down with it; the P&L folds NULL into a named
--                              bucket instead.
--   ON DELETE SET NULL       — deleting an office must not delete the money.
--                              CASCADE here would erase closed commission
--                              history when an admin closes a branch; RESTRICT
--                              would make an office undeletable forever. SET
--                              NULL drops the closing into the named null bucket
--                              where a human can still see it, which is the same
--                              fail-open direction m423 chose for
--                              users.location_id.

do $$
declare
  is_nullable text;
  del_action  char;
  ref_table   text;
  idx_count   int;
begin
  select c.is_nullable into is_nullable
  from   information_schema.columns c
  where  c.table_schema = 'public' and c.table_name = 'commission_splits'
    and  c.column_name = 'location_id' and c.data_type = 'uuid';

  if is_nullable is null then
    raise exception
      'm428: commission_splits.location_id is missing (or is not uuid). Owner ruling: "the closed commission needs to stay on the office that closed the deal." Without a stamped office the only answer available is a read-time join to agents.location_id, which reports where the agent is NOW — so an agent who transfers offices drags their entire closed history to the new office.';
  end if;

  if is_nullable <> 'YES' then
    raise exception
      'm428: commission_splits.location_id is NOT NULL. It must stay nullable: an agent who is not pinned to an office has no office to stamp, and a NOT NULL column turns that ordinary case into a failed INSERT on the commission ledger. lib/intelligence/brokerage-pnl.ts folds NULL into a NAMED "No office assigned" bucket so the office rows still sum to the brokerage total.';
  end if;

  select confdeltype, cl.relname into del_action, ref_table
  from   pg_constraint con
  join   pg_class cl on cl.oid = con.confrelid
  where  con.conrelid = 'public.commission_splits'::regclass
    and  con.contype = 'f'
    and  con.conkey = array[(select attnum from pg_attribute
                             where attrelid = 'public.commission_splits'::regclass
                               and attname = 'location_id')]::int2[];

  if del_action is null then
    raise exception
      'm428: commission_splits.location_id has no FOREIGN KEY. The stamp must reference public.locations(id) so it names a real office rather than a uuid nobody can resolve.';
  end if;

  if ref_table <> 'locations' then
    raise exception
      'm428: commission_splits.location_id references % rather than locations.', ref_table;
  end if;

  if del_action <> 'n' then
    raise exception
      'm428: commission_splits.location_id FK ON DELETE is % — it must be SET NULL (n). CASCADE would DELETE closed commission history when an admin closes a branch office; RESTRICT would make an office permanently undeletable once one deal closed out of it. SET NULL drops the closing into the named "No office assigned" bucket, where a human can still see it.',
      del_action;
  end if;

  select count(*) into idx_count
  from   pg_index i
  where  i.indrelid = 'public.commission_splits'::regclass
    and  (select attnum from pg_attribute
          where attrelid = 'public.commission_splits'::regclass
            and attname = 'location_id') = any(i.indkey::int2[]);

  if idx_count = 0 then
    raise exception
      'm428: commission_splits.location_id is not indexed. The brokerage P&L groups every split in a window by this column; without an index the owner''s report degrades to a full scan of the money ledger as it grows.';
  end if;

  raise notice 'm428 claim 1 OK: commission_splits.location_id is a nullable, indexed uuid FK to locations with ON DELETE SET NULL.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — THE STAMP IS WRITTEN BY THE APPLICATION, NEVER DERIVED BY THE DB
-- ─────────────────────────────────────────────────────────────────────────────
--
-- lib/kernel/resolve-user-office.ts is THE ONE precedence rule for a person's
-- office (users.location_id wins over agents.location_id, because the former is
-- what an admin last set deliberately through the office UI). A DEFAULT or a
-- GENERATED expression on this column would be a SECOND rule living in the
-- database, and it would silently stop agreeing with the resolver the moment
-- m423's precedence changed. Both writers call the resolver; the column stays
-- inert.

do $$
declare
  has_default boolean;
  is_generated text;
begin
  select a.atthasdef, c.is_generated
  into   has_default, is_generated
  from   pg_attribute a
  join   information_schema.columns c
    on   c.table_schema = 'public' and c.table_name = 'commission_splits'
   and   c.column_name = a.attname
  where  a.attrelid = 'public.commission_splits'::regclass
    and  a.attname  = 'location_id';

  if coalesce(has_default, false) or coalesce(is_generated, 'NEVER') <> 'NEVER' then
    raise exception
      'm428: commission_splits.location_id has a DEFAULT or a GENERATED expression. The office must be resolved by lib/kernel/resolve-user-office.ts and stamped by the writer. A database-side derivation is a SECOND precedence rule for a person''s office and will drift from the resolver — which is exactly the class of defect m423 created that one function to prevent.';
  end if;

  raise notice 'm428 claim 2 OK: location_id carries no DB-side derivation; the writers stamp it.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — m420'S INVARIANT STILL HOLDS ON commission_splits
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m427 rewrote this table's SELECT policy. m420 asserted that EVERY policy on
-- this table — all four commands, and BOTH the USING and WITH CHECK side of each
-- — names the tenant through `has_brokerage_access(brokerage_id)` specifically.
-- That claim is re-made here rather than assumed, because the file that could
-- most easily have broken it is the one this file is asserting.
--
-- Restated as "no expression on this table lacks it" and not as a list of four
-- names, for m420's reason: the defect being prevented is a FIFTH policy added
-- later without one, and a list cannot see a policy that does not exist yet.

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
      'm428: m420''s invariant is broken — % commission_splits polic(ies)/clause(s) no longer name the tenant: %. Commission is TENANT ONLY. Use has_brokerage_access(brokerage_id) specifically and not an inlined equality: if multi-location brokerages are ever modelled as separate brokerages rows, that helper is the single place the relationship gets taught, and an inlined copy would not inherit it.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm428 claim 3 OK: every commission_splits policy still names the tenant through has_brokerage_access(brokerage_id).';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — THE FINANCIAL-READER HELPER EXISTS, IS THE RIGHT ROSTER, AND IS
--           REFERENCED BY THE agent_commissions SELECT POLICY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three sub-claims, because the ruling has three failure modes:
--
--   (a) the helper is absent or reshaped        → the roster is not a roster;
--   (b) the helper admits marketing             → ruling 1 says three roles, and
--                                                 the standing staff roster's
--                                                 fourth role is the one it
--                                                 leaves out;
--   (c) SELECT does not reference it            → ruling 1 is not applied at all,
--                                                 which is the state m427 found:
--                                                 platform staff could read
--                                                 NOTHING on this table.
--
-- The helper NAME is pinned deliberately, exactly as m420 pins
-- has_brokerage_access. The point of a helper is that the rule lives in ONE
-- place; a hand-inlined `platform_role in (...)` would satisfy any shape test
-- and then silently fail to inherit a future correction to the roster.

do $$
declare
  fn      oid;
  src     text;
  is_def  boolean;
  vol     char;
  cfg     text[];
  sel     text;
begin
  select p.oid, p.prosrc, p.prosecdef, p.provolatile, p.proconfig
  into   fn, src, is_def, vol, cfg
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'can_read_tenant_financials'
    and  p.pronargs = 0;

  if fn is null then
    raise exception
      'm428: public.can_read_tenant_financials() is missing. Owner ruling 1: "admin, superadmin, support can read tenant financilas of platform." Neither existing helper is that set — is_platform_admin() is superadmin-only (and is depended on by 522 policies across 179 tables, so it cannot be widened), and is_platform_staff() also includes marketing. The ruling needs its own helper.';
  end if;

  if not is_def or vol <> 's' or cfg is null
     or not exists (select 1 from unnest(cfg) x where x like 'search_path=%') then
    raise exception
      'm428: can_read_tenant_financials() is not SECURITY DEFINER + STABLE + pinned search_path. SECURITY DEFINER so it reads users without tripping users'' own RLS and without recursing into a policy that calls it; STABLE so the planner may cache it per statement instead of re-querying per row; a pinned search_path so a caller cannot shadow public.users.';
  end if;

  if src like '%marketing%' then
    raise exception
      'm428: can_read_tenant_financials() admits marketing. The standing platform-staff roster is four roles (superadmin, admin, marketing, support), but the owner''s FINANCIAL ruling named three and left marketing out. If marketing belongs here, is_platform_staff() already exists and this helper has no reason to.';
  end if;

  if src not like '%support%' then
    raise exception
      'm428: can_read_tenant_financials() does not admit support. Ruling 1 names support explicitly.';
  end if;

  select pg_get_expr(p.polqual, p.polrelid) into sel
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'agent_commissions' and p.polcmd = 'r';

  if sel is null or sel not like '%can_read_tenant_financials()%' then
    raise exception
      'm428: the agent_commissions SELECT policy does not reference can_read_tenant_financials(). Before m427 all four policies on this table were exactly brokerage_id = current_user_brokerage_id(), which means platform staff could read NOTHING — ruling 1 was not merely unimplemented, it was inverted. Current SELECT: %',
      coalesce(sel, '<no SELECT policy>');
  end if;

  raise notice 'm428 claim 4 OK: can_read_tenant_financials() exists in the right shape, excludes marketing, and gates the agent_commissions SELECT policy.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — "READ" MEANS READ: THE HELPER APPEARS ON NO WRITE CLAUSE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Ruling 1 grants a READ. A support operator gets the ledger, not a pen. Stated
-- across the whole schema rather than for these two tables, because the next
-- financial table to adopt this helper is exactly where the mistake would be
-- made, and a two-name list cannot see a table that has not adopted it yet.

do $$
declare
  offenders text[];
begin
  select coalesce(array_agg(
           c.relname || '.' || p.polname || ' [' ||
           case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' else 'ALL' end || ']'
           order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polcmd in ('a', 'w', 'd', '*')
    and  ( coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%can_read_tenant_financials()%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%can_read_tenant_financials()%' );

  if array_length(offenders, 1) is not null then
    raise exception
      'm428: can_read_tenant_financials() appears on % write polic(ies): %. The owner ruled that admin, superadmin and support can READ tenant financials. Nothing in that sentence authorises a support operator to alter a commission. Platform WRITE stays on is_platform_admin().',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm428 claim 5 OK: the financial-reader helper gates no write clause anywhere in public.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 6 — agent_commissions CARRIES AN ANCHOR ON EVERY CLAUSE, AND THE
--           AGENT'S OWN ROW IS DISTINGUISHED FROM THEIR COLLEAGUES'
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two things this table did not have before m427:
--
--   · A per-agent clause. Ruling: "agent's commission earned is located in their
--     accounts." Measured on the live database before m427, an ordinary agent
--     could read — and UPDATE — every colleague's commission row, because all
--     four policies were the single expression
--     `brokerage_id = current_user_brokerage_id()` with no agent term in any of
--     them. `current_user_agent_id()` in the SELECT policy is what makes an
--     agent's own row a distinguishable thing at all, and it is the same
--     spelling commission_splits uses so the two ledgers agree.
--
--   · A durable anchor on every clause. Stated as "no expression lacks one",
--     for m420's reason: the defect is a FIFTH policy added later.
--     `has_brokerage_access(brokerage_id)` is the tenant anchor and
--     `current_user_agent_id()` is the person anchor; a clause naming neither is
--     granting rows on something other than who you are or where you work.

do $$
declare
  sel       text;
  offenders text[];
begin
  select pg_get_expr(p.polqual, p.polrelid) into sel
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'agent_commissions' and p.polcmd = 'r';

  if sel is null or sel not like '%current_user_agent_id()%' then
    raise exception
      'm428: the agent_commissions SELECT policy has no per-agent clause. Owner ruling: "agent''s commission earned is located in their accounts" — an agent''s account shows THEIR earnings, not the brokerage''s payroll. Use the same shape commission_splits uses, is_agent_role() AND agent_id = current_user_agent_id(), so the two commission ledgers answer the question the same way. Current SELECT: %',
      coalesce(sel, '<no SELECT policy>');
  end if;

  select coalesce(array_agg(
           p.polname || ' [' ||
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                         when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end ||
           case when coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
                     and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                     and pg_get_expr(p.polqual, p.polrelid) not like '%current_user_agent_id()%'
                then ' USING' else '' end ||
           case when coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
                     and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                     and pg_get_expr(p.polwithcheck, p.polrelid) not like '%current_user_agent_id()%'
                then ' WITH-CHECK' else '' end || ']'
           order by p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname = 'agent_commissions'
    and  ( (coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
            and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
            and pg_get_expr(p.polqual, p.polrelid) not like '%current_user_agent_id()%')
        or (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
            and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
            and pg_get_expr(p.polwithcheck, p.polrelid) not like '%current_user_agent_id()%') );

  if array_length(offenders, 1) is not null then
    raise exception
      'm428: % agent_commissions polic(ies)/clause(s) carry neither anchor: %. Ruling 2: "a brokerage can only have access to their own commission." Every clause must name has_brokerage_access(brokerage_id) (the tenant) or current_user_agent_id() (the person). A clause naming neither grants commission rows on some other basis entirely.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm428 claim 6 OK: agent_commissions distinguishes an agent''s own row and every clause carries a tenant or person anchor.';
end $$;

do $$
begin
  raise notice 'm428: all six claims hold — the office stamp is real and inert, m420''s tenant invariant survived, and both of the owner''s commission access rulings are expressed in policy.';
end $$;
