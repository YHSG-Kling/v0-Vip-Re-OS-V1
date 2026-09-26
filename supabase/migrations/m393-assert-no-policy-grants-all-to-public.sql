-- m393 — the assertion half of m392, and the reason it is a separate file.
--
-- m392 DROPS every permissive `FOR ALL USING (true)` policy granted to PUBLIC /
-- anon / authenticated — but only where the table has another policy left to
-- stand on. Where the bad policy is the table's ONLY policy it leaves it alone
-- and raises a WARNING, because dropping it would deny every non-service caller,
-- which is the opposite failure and just as real.
--
-- That leaves a gap that must not be allowed to close quietly, so this migration
-- is the gate: **if any ALL-to-PUBLIC policy still exists in schema `public`,
-- this FAILS and names every one of them.**
--
-- WHY A SEPARATE MIGRATION rather than a `raise exception` at the end of m392:
-- a raise rolls back its whole transaction. Raising inside m392 would undo the
-- safe drops along with it, so ONE table needing a hand-written replacement
-- policy would block every table that did not — and the schema would stay
-- exactly as wide open as before, with a red migration as the only difference.
-- Split, m392's drops COMMIT and this fails afterwards on the genuine remainder.
--
-- HOW TO SATISFY IT: for each table named in the failure, write a tenant-scoped
-- policy for it in its own migration — the same shape the rest of this schema
-- uses (`has_brokerage_access(brokerage_id)`, or `agent_id =
-- current_user_agent_id()` where the column FKs `agents`; RESOLVE between id
-- spaces, never compare `agents.id` to `auth.uid()` — see m390) — then re-apply
-- m392, which will now find another policy on the table and drop the bad one.
-- Do NOT satisfy it by deleting this file.
--
-- If the legacy `scripts/*.sql` RLS blocks never ran here — which the evidence
-- suggests, since all 173 of those declarations live in a corpus with no runner
-- and `supabase/migrations/` contains none — then m392 dropped nothing and this
-- passes silently. That is the expected outcome, and it is worth asserting
-- precisely because it is the one nobody would otherwise check.

do $$
declare
  remaining text[];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   remaining
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive
    and  p.polcmd = '*'
    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true'
    and  (
           0 = any(p.polroles)
           or exists (
             select 1 from pg_roles r
             where  r.oid = any(p.polroles)
               and  r.rolname in ('anon', 'authenticated')
           )
         );

  if array_length(remaining, 1) is not null then
    raise exception
      'm393: % polic(ies) still grant ALL (select+insert+update+delete) on every row to PUBLIC: %. RLS policies are PERMISSIVE and OR together, so each of these makes every other policy on its table decorative. Each is the ONLY policy on its table, so it cannot simply be dropped — write a tenant-scoped replacement first, then re-apply m392.',
      array_length(remaining, 1), array_to_string(remaining, ', ');
  end if;

  raise notice 'm393: no policy in schema public grants ALL to PUBLIC. Verified, not assumed.';
end $$;
