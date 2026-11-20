-- m459 — agent_licenses: the E&O certificate gets a column, and the licence row
-- stops being writable by everyone in the brokerage.
--
-- Found while fixing #213 (E&O insurance was never persisted at all — the app
-- compared an agents.id column to a users.id). Reading the table to fix the
-- write path surfaced two more problems in the same row.
--
-- ══ PART 1 — the E&O certificate had nowhere to go ═════════════════════════
--
-- MEASURED: app/dashboard/onboarding/license/license-intake-client.tsx:533
-- uploads the certificate to storage under `${userId}/eo-insurance/…` and hands
-- the public URL to submitEOInsurance as `certificateUrl`. The action then
-- DROPPED it: agent_licenses has `document_url`, but that column already holds
-- the LICENCE document, so writing the certificate there would clobber it.
--
-- So the agent uploaded a compliance document, the app said "saved", and the URL
-- existed only in the request. The column is the honest fix — the two documents
-- are different documents and each needs its own place.
alter table public.agent_licenses
  add column if not exists eo_certificate_url text;

comment on column public.agent_licenses.eo_certificate_url is
  'Errors & omissions certificate of insurance. DISTINCT from document_url, which holds the real-estate licence itself.';

-- ══ PART 2 — one FOR ALL policy over a compliance record ═══════════════════
--
-- MEASURED before this migration, the table's ONLY policy was:
--   "agent_licenses_brokerage_isolation"  ALL  TO public
--       USING (brokerage_id = current_user_brokerage_id())
--       WITH CHECK — ABSENT
--
-- The tenant test is right and the rest is missing. On a FOR ALL policy USING
-- alone governs DELETE, and an absent WITH CHECK means Postgres reuses USING as
-- the check — so any authenticated member of the brokerage, INCLUDING a
-- user_type='contact' (a client with a users row), could UPDATE or DELETE ANY
-- agent's licence record. Not their own: anyone's.
--
-- A licence row carries license_number, expiration_date, the E&O policy the
-- brokerage's insurance position depends on, and verification_status. It is a
-- compliance record. "Everyone in the tenant may rewrite it" is not a posture a
-- compliance record can have.
--
-- VERIFIED FIRST, so this cannot break a live flow:
--   · the ONLY session-client INSERT is app/actions/onboarding/license.ts:283,
--     an agent creating their OWN row;
--   · the ONLY session-client UPDATE is the E&O write in the same file, also the
--     agent's own row;
--   · app/actions/admin/license-tracking.ts and lib/onboarding/license-verifier.ts
--     both use the SERVICE client, which bypasses RLS entirely;
--   · NOTHING anywhere deletes an agent_licenses row.
--
-- SELECT is deliberately left tenant-wide (narrowed only from `public` to
-- `authenticated`): the broker's licence-tracking board and the readiness sweep
-- read other agents' rows, and narrowing reads is a behaviour change this
-- migration has no evidence to justify.
drop policy if exists agent_licenses_brokerage_isolation on public.agent_licenses;

create policy agent_licenses_tenant_select on public.agent_licenses
  for select to authenticated
  using (brokerage_id = public.current_user_brokerage_id());

-- An agent files their own licence; an admin may file one on their behalf.
create policy agent_licenses_tenant_insert on public.agent_licenses
  for insert to authenticated
  with check (
    brokerage_id = public.current_user_brokerage_id()
    and (public.is_own_agent_id(agent_id) or public.is_brokerage_admin())
  );

-- The tenant anchor is repeated in WITH CHECK (the m448 lesson): a USING that
-- proves only ownership does not stop the owner rewriting the tenant column, or
-- reassigning the row to a different agent.
create policy agent_licenses_tenant_update on public.agent_licenses
  for update to authenticated
  using (
    brokerage_id = public.current_user_brokerage_id()
    and (public.is_own_agent_id(agent_id) or public.is_brokerage_admin())
  )
  with check (
    brokerage_id = public.current_user_brokerage_id()
    and (public.is_own_agent_id(agent_id) or public.is_brokerage_admin())
  );

-- Deleting a licence record is an administrative act. An agent may not erase
-- their own compliance history.
create policy agent_licenses_tenant_delete on public.agent_licenses
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

-- ══ PART 3 — verification is not self-service ══════════════════════════════
--
-- Part 2 lets an agent update their OWN licence row, which is required (they
-- file it, and they file their E&O against it). But `verification_status` and
-- `verified_at` are not theirs to set: verification means a state regulator's
-- registry agreed, or a human reviewer signed off.
--
-- RLS cannot express "these two columns, but not those" — so the column-level
-- rule is a trigger. auth.uid() IS NULL is the service role and the server-side
-- jobs, which is exactly where both legitimate writers live:
--   lib/onboarding/license-verifier.ts (service client, state-registry result)
--   app/actions/admin/license-tracking.ts (service client, human review outcome)
--
-- The app-side twin of this hole is being removed in the same change:
-- app/actions/ai-agent-onboarding.ts:verifyAgentLicense asked an LLM to
-- "simulate a verification result with high confidence" and then stamped
-- verification_status='verified' through the AGENT'S OWN session. This trigger
-- is what stops that shape coming back.
create or replace function public.agent_licenses_verification_is_not_self_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No session = the service role or a server-side job. Those ARE the verifier.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_platform_admin() or public.is_brokerage_admin() then
    return new;
  end if;

  if new.verification_status is distinct from old.verification_status
     or new.verified_at is distinct from old.verified_at then
    raise exception
      'agent_licenses.verification_status is set by licence verification or a brokerage admin, not by the licence holder'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists agent_licenses_verification_guard on public.agent_licenses;
create trigger agent_licenses_verification_guard
  before update on public.agent_licenses
  for each row
  execute function public.agent_licenses_verification_is_not_self_service();

-- NOT addressed here, and named so it is not mistaken for covered: an agent may
-- still edit their own license_number / license_state / expiration_date after a
-- verification has passed, which would leave a `verified` stamp attached to
-- values the registry never saw. The right fix is to reset verification_status
-- when an identifying field changes, and it needs the verifier's owner to say
-- what the reset state should be — so it is reported, not guessed at.

-- ══ MEASURED AFTER — a live behavioural proof, not a reading of the policy ══
--
-- Run against the live project as two real impersonated users (agent@vip.demo
-- holding the licence, teamlead@vip.demo as a colleague in the same brokerage),
-- on a throwaway row that was deleted in the same transaction. Residue 0.
--
--   A  the holder writes their OWN E&O ......................... 1 row
--   B  the holder self-verifies ................................ REFUSED
--        "agent_licenses.verification_status is set by licence
--         verification or a brokerage admin, not by the licence holder"
--   C  the holder moves the row to another tenant .............. REFUSED
--        "new row violates row-level security policy" — note this RAISES
--        rather than matching zero rows, because WITH CHECK rejects the NEW
--        row outright. Stronger than the silent-zero-rows outcome, and the
--        reason this proof had to catch the exception to keep going.
--   D  the holder deletes their own compliance record .......... 0 rows
--   E  a DIFFERENT agent in the same tenant rewrites it ........ 0 rows
--   F  that colleague can still READ it ....................... 1 row
--   G  the final row is exactly what the holder legitimately
--      wrote — carrier, policy, certificate URL, still 'pending',
--      still in the original brokerage ........................ 1 row
--   H  residue after cleanup .................................. 0 rows
--
-- G is the one that matters most: the refusals in B and C did not partially
-- apply. The row kept the writes the holder was entitled to make and none of
-- the ones they were not.

do $$
begin
  raise notice 'm459: agent_licenses carries the E&O certificate, is writable only by its own agent or a brokerage admin, deletable only by an admin, and its verification stamp can no longer be set from the licence holder''s own session.';
end $$;
