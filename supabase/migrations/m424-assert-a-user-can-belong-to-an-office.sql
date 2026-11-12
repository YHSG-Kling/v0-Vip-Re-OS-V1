-- m424 — asserts m423.
--
-- Separate file for the usual reason: a `raise` rolls back its own transaction,
-- so an assertion living inside m423 would undo the column it was checking.
--
-- ── WHAT IS ASSERTED, AND WHY EACH PART ──────────────────────────────────────
--
-- 1. `users.location_id` EXISTS. Without it the office-admin scope that
--    `resolveEgressScope` implements is unreachable on the multi_location tier,
--    because `requiresAgentRow()` gives those admins no `agents` row and
--    `agents.location_id` was the only office anchor in the schema.
--
-- 2. It is NULLABLE. NULL is the meaningful default — "not pinned to an office,
--    sees the whole brokerage" — and it is what every existing row holds. A
--    NOT NULL here would force a fake office onto every user and silently
--    narrow people's scope, which is the opposite of what this is for.
--
-- 3. It has a FOREIGN KEY to `locations`. A free-text office id would let an
--    admin pin a user to an office in ANOTHER brokerage, since the id would
--    never be checked against anything. The FK is the tenancy guarantee here.
--
-- 4. `agents.location_id` SURVIVES. This migration adds a preferred source, it
--    does not replace the old one — the resolver falls back to it for producing
--    agents. If a later change drops that column believing it is superseded,
--    every agent's office silently becomes NULL and every office report empties
--    out. That is exactly the kind of "cleanup" this repo's guards exist to
--    refuse, so it is asserted rather than trusted to a comment.

do $$
declare
  col        record;
  fk_count   int;
  agents_col int;
begin
  select is_nullable, data_type into col
  from   information_schema.columns
  where  table_schema = 'public' and table_name = 'users' and column_name = 'location_id';

  if not found then
    raise exception
      'm424: users.location_id does not exist. Without it a user who has no `agents` row cannot be placed in an office — and on the multi_location tier that is every admin, because requiresAgentRow() deliberately withholds an agents row from a pure-admin owner. The office-admin scope resolveEgressScope implements would be unreachable on the one tier that has offices.';
  end if;

  if col.is_nullable <> 'YES' then
    raise exception
      'm424: users.location_id is NOT NULL. It must be nullable — NULL means "not pinned to an office, sees the whole brokerage", which is the correct default for every user and the only value that does not silently narrow someone''s scope.';
  end if;

  select count(*) into fk_count
  from   information_schema.table_constraints tc
  join   information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
  join   information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
  where  tc.table_schema = 'public' and tc.table_name = 'users'
    and  tc.constraint_type = 'FOREIGN KEY'
    and  kcu.column_name = 'location_id'
    and  ccu.table_name = 'locations';

  if fk_count < 1 then
    raise exception
      'm424: users.location_id has no FOREIGN KEY to public.locations. Unconstrained, it would let an admin pin a user to an office belonging to a DIFFERENT brokerage — the id would never be checked against anything. The FK is the tenancy guarantee on this column.';
  end if;

  select count(*) into agents_col
  from   information_schema.columns
  where  table_schema = 'public' and table_name = 'agents' and column_name = 'location_id';

  if agents_col < 1 then
    raise exception
      'm424: agents.location_id has been dropped. m423 added a PREFERRED office source, it did not replace this one — lib/kernel/resolve-user-office.ts falls back to it for producing agents, and every office rollup on the brokerage P&L joins through it. Dropping it empties every office report rather than migrating it.';
  end if;

  raise notice 'm424: a user can belong to an office — users.location_id exists, is nullable, is FK-bound to locations, and agents.location_id survives as the fallback.';
end $$;
