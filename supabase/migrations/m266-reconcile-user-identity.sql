-- m266-reconcile-user-identity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE IDENTITY INVARIANT the whole app rests on: public.users.id === auth.users.id
-- (get-agent-context, every RLS auth.uid() policy, the agents.user_id → users.id FK).
--
-- The old owner-provisioning paths could create a public.users row with a random id
-- (never equal to the auth id) — orphaning the profile. m266 ships the DURABLE repair
-- primitive + a batch reconciler so any id-mismatch (past or future) can be healed to
-- the canonical auth id without data loss, plus a runtime helper the invite paths use
-- to keep a stale orphan email from blocking a fresh, correct signup.

-- ── repoint_user_identity(from, to) ──────────────────────────────────────────
-- Move EVERY foreign-key child that references public.users(id) from a mismatched
-- source id to the canonical auth id, then land the users row itself on the auth id.
-- FK columns are discovered dynamically (information_schema) so the primitive never
-- drifts as new child tables are added. Postgres cannot UPDATE a PK that children
-- reference (no ON UPDATE CASCADE) and Supabase forbids session_replication_role, so
-- we re-key via a generic full-row copy: materialize the row destined for the auth id,
-- free the unique columns (email/username) on the source so the copy can insert, then
-- repoint children onto the now-existing canonical row and drop the emptied source.
create or replace function public.repoint_user_identity(p_from uuid, p_to uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r   record;
  cnt integer;
  moved integer := 0;
begin
  if p_from is null or p_to is null or p_from = p_to then return 0; end if;
  if not exists (select 1 from public.users where id = p_from) then return 0; end if;

  if not exists (select 1 from public.users where id = p_to) then
    -- Build the canonical row (all columns preserved) keyed by the auth id.
    drop table if exists _recon_u;
    create temp table _recon_u as select * from public.users where id = p_from;
    update _recon_u set id = p_to;
    -- Free the unique columns on the SOURCE so the copy can be inserted.
    update public.users
       set email      = '__recon__:' || id::text,
           username   = case when username is not null then '__recon__:' || id::text else null end,
           updated_at = now()
     where id = p_from;
    insert into public.users select * from _recon_u;
    drop table if exists _recon_u;
  end if;

  -- Repoint every FK child that references public.users(id): p_from -> p_to.
  for r in
    select tc.table_schema as sch, tc.table_name as tbl, kcu.column_name as col
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_schema = 'public' and ccu.table_name = 'users' and ccu.column_name = 'id'
  loop
    execute format('update %I.%I set %I = $1 where %I = $2', r.sch, r.tbl, r.col, r.col)
      using p_to, p_from;
    get diagnostics cnt = row_count;
    moved := moved + cnt;
  end loop;

  -- Drop the now-emptied source (email/username sentineled, children moved to p_to).
  delete from public.users where id = p_from;
  return moved;
end $$;

-- ── reconcile_orphaned_users() ───────────────────────────────────────────────
-- Batch heal: for every public.users row whose id is NOT itself an auth id but whose
-- email DOES match an auth.users row, repoint it to that auth id. Returns a jsonb
-- report. Idempotent (a second run finds nothing). Auth-less rows (no matching auth
-- user at all) are left untouched — they carry no identity to reconcile to; the invite
-- paths free their email at re-invite time.
create or replace function public.reconcile_orphaned_users()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  r       record;
  moved   integer;
  detail  jsonb := '[]'::jsonb;
begin
  for r in
    select u.id as from_id, a.id as to_id, u.email
    from public.users u
    join auth.users a  on lower(a.email) = lower(u.email) and a.id <> u.id
    left join auth.users self on self.id = u.id
    where self.id is null
  loop
    moved := public.repoint_user_identity(r.from_id, r.to_id);
    detail := detail || jsonb_build_object('email', r.email, 'from', r.from_id, 'to', r.to_id, 'children_moved', moved);
  end loop;
  return jsonb_build_object('reconciled', jsonb_array_length(detail), 'detail', detail);
end $$;

-- Runtime callers use the service role; the fns run as their (superuser) definer.
grant execute on function public.repoint_user_identity(uuid, uuid) to service_role;
grant execute on function public.reconcile_orphaned_users() to service_role;

-- One-time backfill for any historical mismatch (0 today; safe + idempotent).
select public.reconcile_orphaned_users();
