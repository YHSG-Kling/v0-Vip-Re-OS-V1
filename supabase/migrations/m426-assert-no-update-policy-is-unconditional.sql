-- m426 — assert what m425 established. Separate migration on purpose: a `raise`
-- rolls back its own transaction, so an assertion sharing a migration with the
-- change it checks would undo that change on failure.
--
-- TWO ASSERTIONS, BOTH ON THE CONSTRUCT RATHER THAN A SPELLING.
--
-- (A) is SCHEMA-WIDE and is the real invariant: no UPDATE policy anywhere in
--     `public` may carry an unconditionally-true predicate. It is deliberately
--     NOT a list of the three table names m425 fixed, because the defect worth
--     preventing is a FOURTH such policy added later on a table that does not
--     exist yet, and a list of three names cannot see one that is not there.
--
--     It also survives legitimate future change. If someone actually builds the
--     long-form-video feature and gives tenants a properly tenant-scoped write,
--     this assertion still passes — any real predicate satisfies it. Only an
--     unconditional one fails. That matters: three guards this session went red
--     on strictly BETTER code because they pinned a spelling instead of a shape.
--
-- (B) is scoped to the three tables m425 touched, and covers INSERT. It is NOT
--     schema-wide because the schema-wide unconditional-INSERT baseline is
--     currently 72 tables (measured, see the note below) and asserting zero
--     there today would simply fail. Narrow assertion now, broad one when the
--     baseline is actually burned down.
--
-- THE 72-TABLE INSERT CLASS IS A KNOWN, MEASURED, UNCLOSED BASELINE, recorded
-- here so it is not mistaken for something this migration handled. Those are
-- tables whose INSERT policy is `WITH CHECK (true)` to `authenticated` — any
-- signed-in user may create a row. Most draw their real protection from the
-- tenant stamp (#156): an unstamped row is the leak, and stamping is what closes
-- it. Two of the 72 are granted to PUBLIC and both are deliberate and named —
-- `tool_usage_sessions_insert` (the owner-ruled anonymous calculator carve-out,
-- m394 keep_anon_insert) and `listing_inquiries_insert` (the public listing
-- enquiry form). That class is future work, not a claim of completion.

do $$
declare n int; offenders text;
begin
  -- (A) schema-wide: no unconditional UPDATE policy
  select count(*), coalesce(string_agg(c.relname || '.' || p.polname, ', ' order by c.relname), '')
    into n, offenders
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and p.polcmd = 'w'
    and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'true'
    and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'true') = 'true';

  if n > 0 then
    raise exception
      'm426(A): % UPDATE polic(ies) in public carry an unconditional predicate: %. An UPDATE policy with USING(true) WITH CHECK(true) lets every caller who can SEE a row REWRITE it.',
      n, offenders;
  end if;

  -- (B) the three tables m425 closed: no unconditional INSERT policy either
  select count(*), coalesce(string_agg(c.relname || '.' || p.polname, ', ' order by c.relname), '')
    into n, offenders
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('long_form_videos', 'marketing_stats', 'transparency_videos')
    and p.polcmd = 'a'
    and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'true') = 'true';

  if n > 0 then
    raise exception
      'm426(B): % INSERT polic(ies) on the three platform reference tables are unconditional: %. These tables gate DELETE on is_platform_admin(); INSERT and UPDATE must agree with that.',
      n, offenders;
  end if;

  raise notice 'm426 OK — no unconditional UPDATE policy in public; no unconditional INSERT on the three platform reference tables.';
end $$;
