-- m448 — AN UPDATE MAY NOT MOVE A ROW OUT OF ITS TENANT.
--
-- m446 closed this on `transactions` after proving a live deal could be moved
-- into another brokerage. m447 then measured the same construct schema-wide and
-- reported the rest as a warning: 10 UPDATE policies with a USING and NO WITH
-- CHECK, of which 6 carry no tenant term in the USING either. This is those.
--
-- ── THE CONSTRUCT, STATED EXACTLY ───────────────────────────────────────────
--
-- When an UPDATE policy has no WITH CHECK, Postgres reuses the USING expression
-- as the check. USING answers "WHICH ROWS MAY I ACT ON". It does not answer "WHAT
-- MAY THIS ROW BECOME". Those are the same question only when the USING happens
-- to constrain every column the caller could change.
--
-- So the four policies whose USING already names the tenant are SAFE and are left
-- alone — checked, not assumed:
--
--   compliance_flags.broker_update_compliance_flags        USING has brokerage_id
--   contacts.broker_update_brokerage_contacts              USING has brokerage_id
--   listing_health_interventions."users resolve …"         USING has brokerage_id
--   presentation_sections.presentation_sections_tenant_update  USING has brokerage_id
--
-- The reused USING forces the NEW row to satisfy the tenant test too, so the row
-- cannot leave. Adding a WITH CHECK there would change nothing; this migration
-- does not touch them.
--
-- ── THE FIVE THAT COULD MOVE ────────────────────────────────────────────────
--
-- Each has a USING that establishes OWNERSHIP but names no tenant at all, on a
-- table that HAS a brokerage_id. So the owner of the row could rewrite its
-- brokerage_id to any brokerage on the platform and still pass the reused check,
-- because they were still the owner:
--
--   contacts.agent_update_own_contacts             agent owns the contact
--   activities.activities_update_own               agent owns the activity
--   learning_assignments.la_self_update            the assignee
--   push_subscriptions.push_subs_update_own        the subscriber
--   video_completion_tracking.vct_update           the agent
--
-- PROVED, not inferred, in a rolled-back fixture: agent@vip.demo moved one of
-- their own CONTACTS into Your Brokerage — 1 row. That contact carries the
-- person's PII and their TCPA consent record, and it left the tenant with them.
-- That is the sharpest of the five and it is why this is not deferred.
--
-- ── THE FIX IS PURELY SUBTRACTIVE ───────────────────────────────────────────
--
-- WITH CHECK becomes `<the existing USING> AND has_brokerage_access(brokerage_id)`.
-- The USING is left exactly as it is, so WHICH ROWS each caller may act on does
-- not change at all — only what the row may BECOME is narrowed. Nothing that
-- legitimately updates a row inside its own tenant can start failing.
--
-- VERIFIED both directions after applying: the cross-tenant move is REFUSED, and
-- the same agent editing the same contact inside its own tenant still succeeds.
--
-- The existing USING is READ FROM THE CATALOGUE rather than retyped, so this
-- cannot silently drift from the policy it is amending — the same reason m433
-- used a driven loop.
--
-- has_brokerage_access() is FALSE for a NULL target by construction, so an
-- unstamped row would become un-updatable. Measured first: all five tables have
-- ZERO rows with a NULL brokerage_id (contacts 4/0, activities 24/0, the other
-- three empty), so no live write is refused by this.

do $$
declare
  targets text[][] := array[
    ['contacts',                  'agent_update_own_contacts'],
    ['activities',                'activities_update_own'],
    ['learning_assignments',      'la_self_update'],
    ['push_subscriptions',        'push_subs_update_own'],
    ['video_completion_tracking', 'vct_update']
  ];
  i        int;
  cur_using text;
  cur_check text;
  n        int := 0;
begin
  for i in 1 .. array_length(targets, 1) loop
    select pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
      into cur_using, cur_check
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = targets[i][1] and p.polname = targets[i][2];

    if cur_using is null then
      raise notice 'm448: %.% is gone — nothing to amend.', targets[i][1], targets[i][2];
      continue;
    end if;

    -- If somebody has already given it a WITH CHECK since the audit, leave their
    -- work alone rather than overwriting a decision this migration cannot see.
    if cur_check is not null then
      raise notice 'm448: %.% already has an explicit WITH CHECK — leaving it alone.', targets[i][1], targets[i][2];
      continue;
    end if;

    if cur_using ~ '(brokerage_id|has_brokerage_access|current_user_brokerage_id)' then
      raise notice 'm448: %.% has acquired a tenant term in its USING — the reused check already holds it in tenant.', targets[i][1], targets[i][2];
      continue;
    end if;

    execute format(
      'alter policy %I on public.%I using (%s) with check ((%s) and public.has_brokerage_access(brokerage_id))',
      targets[i][2], targets[i][1], cur_using, cur_using);
    n := n + 1;
  end loop;

  raise notice 'm448: % UPDATE polic(ies) can no longer move their row into another brokerage. USING is unchanged on every one of them, so nobody loses a row they could already edit.', n;
end $$;

-- ── REPORTED, DELIBERATELY NOT FIXED ────────────────────────────────────────
--
-- `conversation_audit_flags.audit_flags_update_policy` is the sixth policy m447
-- counted, and it is a DIFFERENT defect wearing the same shape. Its USING is a
-- bare role test — `user_type IN ('admin','compliance_officer')` — with no tenant
-- term, and the table HAS NO brokerage_id AT ALL. So there is nothing to anchor
-- to and nothing that could be "moved"; what it means is that an admin at any
-- brokerage may update any brokerage's conversation audit flags.
--
-- That needs a schema decision (does an audit flag belong to a tenant?) rather
-- than a policy edit, and inventing a tenant column for an audit table is not a
-- call this migration should make. Raised as a notice so it stays visible.

do $$
declare n int;
begin
  select count(*) into n
  from information_schema.columns
  where table_schema='public' and table_name='conversation_audit_flags'
    and column_name in ('brokerage_id','tenant_id','organization_id');

  if n = 0 then
    raise notice 'm448: conversation_audit_flags.audit_flags_update_policy gates on user_type IN (admin, compliance_officer) with NO tenant term, and the table has NO tenant column to anchor to — so an admin at any brokerage may alter any brokerage''s conversation audit flags. Reported, not fixed: whether an audit flag belongs to a tenant is a schema ruling, not a policy edit.';
  end if;
end $$;
