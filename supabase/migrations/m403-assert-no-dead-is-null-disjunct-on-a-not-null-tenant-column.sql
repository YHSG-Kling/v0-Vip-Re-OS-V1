-- m403 — asserts m402.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m402 would undo the very rewrites it was checking, so one stubborn
-- policy would revert all 507 and leave the schema exactly as it was with a red
-- migration as the only difference. This is the same split m393/m395/m397/m399
-- use, for the same reason.
--
-- WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
--
-- It asserts the CONSTRUCT, not a policy name and not a count: no policy on a
-- table whose `brokerage_id` is NOT NULL may test `brokerage_id IS NULL` outside
-- a subquery. Stated that way it also catches a NEW policy written next month
-- with the same dead branch, which a name list or a "507 became 0" count would
-- both miss.
--
-- It says NOTHING about the nullable tables. Those are the live half of #156 —
-- 196 tables, 47 of which still carry unstamped writers — and removing the
-- escape there turns an unstamped INSERT into a refusal that supabase-js
-- resolves as success. That work is gated on stamping those writers first, so
-- an assertion demanding it now would be a red gate on work nobody has been
-- asked to finish yet.
--
-- The subquery exclusion is not a loophole, it is precision: a
-- `brokerage_id IS NULL` inside an EXISTS refers to a DIFFERENT table's column,
-- whose nullability this assertion has not established. `prospect_context` is
-- that case — no `brokerage_id` of its own, inheriting
-- `prospects.brokerage_id IS NULL` through a join.

do $$
declare
  dead_disjuncts text[];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   dead_disjuncts
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  join   information_schema.columns col
         on col.table_schema = 'public'
        and col.table_name   = c.relname
        and col.column_name  = 'brokerage_id'
  where  n.nspname = 'public'
    and  col.is_nullable = 'NO'
    and  strpos(
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
           'brokerage_id IS NULL') > 0
    and  strpos(                                          -- outside a subquery only
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
           'SELECT') = 0;

  if array_length(dead_disjuncts, 1) is not null then
    raise exception
      'm403: % polic(ies) test `brokerage_id IS NULL` on a table where that column is NOT NULL: %. The branch can never be true of an existing row, and a NEW row carrying NULL is refused by the constraint whatever RLS says — so the disjunct grants nothing and merely claims an escape this table does not have. Worse, it makes the table look like part of the #156 tenant-escape surface when it is not, which is how the 196 tables that DO carry a live escape stayed lost in a population of 324. Drop the disjunct (ALTER POLICY <name> ON public.<table> USING (brokerage_id = current_user_brokerage_id())), or, if the column is meant to be nullable, change the column and treat the table as part of the live escape surface.',
      array_length(dead_disjuncts, 1),
      array_to_string(dead_disjuncts, ', ');
  end if;

  raise notice 'm403: no policy on a NOT NULL `brokerage_id` column carries the dead `brokerage_id IS NULL` disjunct. Verified, not assumed.';
end $$;
