-- m458 — asserts m457. Separate file: a `raise` rolls back its own transaction.
--
-- These claims are STRUCTURAL on purpose. The behavioural proof was run live
-- against real users before m457 was written to disk, in DO blocks that raised
-- and therefore rolled back — agent-edits-team=0, lead-edits-OWN=1,
-- lead-edits-SIBLING=0, tenantA-admin-sees-tenantB=0, sees-OWN=1, residue 0.
-- Repeating that here would mean INSERTing fixture teams and settings rows into
-- a migration that COMMITS when it passes, which is how a "test" leaves rows
-- behind in a live database. Structure is what a re-run can safely check.

-- ── CLAIM 1 — NO POLICY NAMES A ROLE AND FORGETS THE TENANT (HARD) ─────────
--
-- The defect m457 closed was not a missing policy, it was a CORRECT policy
-- standing next to a tenant-free one. Permissive policies OR together, so the
-- weakest predicate wins and a reviewer reading only the good one sees safety
-- that is not there. This claim is therefore about EVERY policy on the table,
-- not about the existence of a good one.
do $$
declare bad text;
begin
  select string_agg(tablename || '.' || policyname || ' [' || cmd || ']', '; ')
    into bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('global_settings', 'teams')
    and 'service_role' <> all(roles)
    -- mentions an identity/role test of some kind …
    and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ '(user_type|is_brokerage_admin|is_platform_admin|is_platform_staff|auth\.uid)'
    -- … but never anchors to a tenant
    and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) !~ '(brokerage_id|current_user_brokerage_id|has_brokerage_access)';

  if bad is not null then
    raise exception 'm458: policy/policies naming a role with NO tenant anchor: %. Permissive policies OR together — one of these beside a correct policy re-opens cross-tenant access no matter how right the other one is.', bad;
  end if;
end $$;

-- ── CLAIM 2 — EVERY WRITE CARRIES BOTH HALVES (HARD) ──────────────────────
--
-- A tenant anchor alone is what `teams` had on all four commands, and it let an
-- ordinary agent — or a contact, i.e. a client — rewrite the team split the
-- commission waterfall reads. A role test alone is what global_settings had. A
-- write needs BOTH: which tenant, and who within it.
do $$
declare bad text;
begin
  select string_agg(tablename || '.' || policyname || ' [' || cmd || ']', '; ')
    into bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('global_settings', 'teams')
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and 'service_role' <> all(roles)
    and not (
      (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ '(brokerage_id|current_user_brokerage_id|has_brokerage_access)'
      and
      (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ '(is_brokerage_admin|is_platform_admin|team_lead_id)'
    );

  if bad is not null then
    raise exception 'm458: write polic(ies) missing a tenant anchor or an authority test: %. Both halves are required — WHICH tenant, and WHO within it.', bad;
  end if;
end $$;

-- ── CLAIM 3 — THE LEAD CAN STILL BRAND THEIR OWN TEAM (HARD) ──────────────
--
-- THE CLAIM THAT PROTECTS THE FEATURE, not just the boundary. It is easy to
-- close a hole by narrowing a policy to admins and quietly break the owner's
-- ruling that a team may carry its own logo. The team-branding surface this wave
-- ships is useless if the one real team lead cannot write their own row.
--
-- Asserted as a CONSTRUCT: the UPDATE policy must reach ownership by the FK
-- (team_lead_id), never by a role label. `user_type = 'team_lead'` is measurably
-- wrong here — the live lead carries user_type 'agent' and the account labelled
-- 'team_lead' leads no team at all.
do $$
declare upd_qual text; upd_check text;
begin
  select qual, with_check into upd_qual, upd_check
  from pg_policies
  where schemaname='public' and tablename='teams' and cmd='UPDATE' limit 1;

  if upd_qual is null then
    raise exception 'm458: teams has no UPDATE policy at all — the team-branding settings surface would save nothing.';
  end if;
  if upd_qual !~ 'team_lead_id' then
    raise exception 'm458: the teams UPDATE policy does not reach ownership through team_lead_id (%). A team lead must be able to brand their own team, and leading a team is a FACT on the row, not a user_type label.', upd_qual;
  end if;
  if coalesce(upd_check,'') !~ '(brokerage_id|current_user_brokerage_id)' then
    raise exception 'm458: the teams UPDATE policy has no tenant anchor in WITH CHECK (%). Without it an owner may rewrite brokerage_id and move the team — and its splits — into another tenant.', coalesce(upd_check,'(absent)');
  end if;
end $$;

-- ── CLAIM 4 — CREATING OR DELETING A TEAM STAYS ADMINISTRATIVE (HARD) ─────
do $$
declare bad text;
begin
  select string_agg(policyname || ' [' || cmd || ']', '; ') into bad
  from pg_policies
  where schemaname='public' and tablename='teams'
    and cmd in ('INSERT','DELETE')
    and 'service_role' <> all(roles)
    and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) !~ 'is_brokerage_admin';

  if bad is not null then
    raise exception 'm458: teams %  allow creation/removal without a brokerage-admin test. A lead brands a team; only an admin creates or dissolves one.', bad;
  end if;
end $$;

do $$
begin
  raise notice 'm458: no policy on global_settings or teams names a role without a tenant, every write carries both halves, the team lead can still brand their own team through the FK, and creating or dissolving a team stays administrative.';
end $$;
