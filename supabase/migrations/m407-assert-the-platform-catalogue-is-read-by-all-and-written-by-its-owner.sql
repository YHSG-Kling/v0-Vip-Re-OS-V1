-- m407 — asserts m406.
--
-- Separate file for the m393/m395/m397/m399/m403 reason: a `raise` rolls back its
-- own transaction, so asserting inside m406 would undo the very rewrites it was
-- checking and leave the schema exactly as open as before, with a red migration
-- as the only difference.
--
-- IT ASSERTS THE CONSTRUCT, IN BOTH DIRECTIONS, AND THE SECOND DIRECTION IS THE
-- POINT OF THE WHOLE WAVE
--
-- (1) No policy admitting INSERT/UPDATE/DELETE on a shared-catalogue table may
--     carry `brokerage_id IS NULL`. Stated as a property of the expression rather
--     than a list of policy names, it also catches a NEW policy written next
--     month by copying a neighbour — which is exactly how the migration-029 shape
--     spread across 320 tables in the first place.
--
-- (2) Every one of those tables must STILL admit `brokerage_id IS NULL` on
--     SELECT. This half exists because the obvious "fix" is the dangerous one:
--     every row in these tables is a platform row (66/66 onboarding_steps, 12/12
--     training_videos, 11/11 help_topics_kb, 13/13 service_status, 4/4
--     thank_you_note_templates, 17/17 content_topic_sources), so stripping the
--     branch from READ would not scope the feature — it would return zero rows to
--     every tenant at once and empty the onboarding checklist, the training
--     library and the help knowledge base. The owner's ruling is explicit:
--     "tenant only sees their own unless it is of course, training or knowledge
--     base and support tickets for the platform." A one-sided assertion would
--     have called that catastrophe a pass.
--
-- (3) buyer_stage_coaching carries exactly ONE permissive SELECT policy. It had
--     two saying the same thing; a count of one is what makes the consolidation
--     stick rather than being re-added by the next hand that reads only one of
--     them.
--
-- support_tickets and api_response_logs are in the WRITE set and deliberately NOT
-- in the READ set: neither is shared catalogue content, so both correctly lost the
-- NULL branch on SELECT too. That asymmetry is load-bearing and is the live
-- negative control for (2) — adding support_tickets to read_set makes it raise.
--
-- NEGATIVE CONTROLS, EACH WATCHED RED BEFORE THIS FILE WAS APPLIED:
--   (1) run before m406 → RED, 15 policies, exactly the target set.
--   (2) run with support_tickets added to read_set → RED.
--   (3) run with the dropped duplicate re-created in a rolled-back transaction
--       → RED, 2 policies; residue checked afterwards, 1 policy remains.

do $$
declare
  read_set  text[] := array['onboarding_steps','training_videos','help_topics_kb',
                            'knowledge_articles','buyer_stage_coaching',
                            'thank_you_note_templates','content_topic_sources',
                            'service_status'];
  write_set text[] := array['onboarding_steps','training_videos','help_topics_kb',
                            'thank_you_note_templates','content_topic_sources',
                            'service_status','support_tickets','api_response_logs'];
  writable   text[];
  unreadable text[];
  dupes      text[];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname || ' [' || p.polcmd::text || ']'
                            order by c.relname, p.polname), '{}')
  into   writable
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname = any(write_set)
    and  p.polpermissive
    and  p.polcmd in ('a','w','d','*')            -- INSERT / UPDATE / DELETE / ALL
    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                'brokerage_id IS NULL') > 0;

  if array_length(writable, 1) is not null then
    raise exception
      'm407(1): % write polic(ies) still admit the untenanted platform row to an ordinary tenant: %. Measured live before m406, that branch let ONE agent at ONE brokerage UPDATE and DELETE 66/66 onboarding_steps, 12/12 training_videos, 11/11 help_topics_kb, 13/13 service_status, 4/4 thank_you_note_templates and 3/3 api_response_logs — the shared catalogue of EVERY tenant, every row of it. A write touching a NULL-tenant row must be gated on is_platform_admin(); a tenant may write only rows carrying its OWN brokerage_id.',
      array_length(writable, 1), array_to_string(writable, ', ');
  end if;

  select coalesce(array_agg(t order by t), '{}')
  into   unreadable
  from   unnest(read_set) t
  where  not exists (
           select 1
           from   pg_policy p
           join   pg_class     c on c.oid = p.polrelid
           join   pg_namespace n on n.oid = c.relnamespace
           where  n.nspname = 'public'
             and  c.relname = t
             and  p.polpermissive
             and  p.polcmd in ('r','*')
             and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                         'brokerage_id IS NULL') > 0);

  if array_length(unreadable, 1) is not null then
    raise exception
      'm407(2): % shared-catalogue table(s) no longer admit the platform row on SELECT: %. Every row in these tables is seeded with brokerage_id IS NULL, so removing that branch from READ does not scope the table — it empties it for every tenant at once, and the onboarding checklist, the training library and the help knowledge base all return nothing. The ruling is that a tenant sees its own rows PLUS the platform''s; only WRITE is owner-or-platform-admin.',
      array_length(unreadable, 1), array_to_string(unreadable, ', ');
  end if;

  select coalesce(array_agg(p.polname order by p.polname), '{}')
  into   dupes
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname = 'buyer_stage_coaching'
    and  p.polpermissive
    and  p.polcmd in ('r','*');

  if coalesce(array_length(dupes, 1), 0) <> 1 then
    raise exception
      'm407(3): buyer_stage_coaching carries % permissive SELECT polic(ies), expected exactly 1: %. It had two spelling the same rule — one resolving the tenant through current_user_brokerage_id() (SECURITY DEFINER) and one through an inline `users` subquery subject to that table''s own RLS. Permissive policies OR together, so the pair was redundant and the weaker one governed. The survivor is bsc_read_brokerage.',
      coalesce(array_length(dupes, 1), 0), array_to_string(dupes, ', ');
  end if;

  raise notice 'm407: the shared platform catalogue is readable by every tenant and writable only by the row''s owner or a platform admin, and buyer_stage_coaching has one SELECT policy. Verified against pg_policy, not assumed.';
end $$;
