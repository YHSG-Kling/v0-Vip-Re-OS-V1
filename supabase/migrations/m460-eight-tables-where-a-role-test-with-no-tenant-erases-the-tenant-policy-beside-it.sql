-- m460 — the m438 shape, still live on EIGHT tables.
--
-- Found by sweeping pg_policies for FOR ALL policies whose USING names a
-- user_type roster and contains no tenant anchor at all. That is the exact shape
-- m438 created, m457 removed from global_settings and teams, and m459 removed
-- from agent_licenses. It was never a one-table problem.
--
-- WHY IT IS SEVERE AND EASY TO MISS: permissive policies OR together. A table can
-- carry a complete, correct set of *_tenant_{select,insert,update,delete}
-- policies and still be wide open, because one tenant-free policy beside them
-- satisfies the check on its own. Reading the correct policy tells you nothing.
-- And on a FOR ALL policy, USING alone governs DELETE — there is no WITH CHECK to
-- stop it — while an ABSENT WITH CHECK means Postgres reuses USING as the check,
-- so nothing constrains what the row may BECOME either.
--
-- MEASURED before this migration (all TO public, all FOR ALL, none naming a
-- tenant):
--
--   integration_credentials  "Admins can manage integration credentials"
--   integration_credentials  "Admins view integration credentials"
--   email_templates          "Admins can manage email templates"
--   email_templates          "Admins and brokers view email templates"
--   notification_rules       "Admins can manage notification rules"
--   notification_rules       "Admins and brokers view notification rules"
--   user_role_assignments    "user_role_assignments_write_admin"
--   vendor_bookings          "vendor_bookings_tenant_all"      (named for a tenant it never tests)
--   closing_notifications    admin / broker / compliance_officer _crud_*
--   document_checklist       admin / broker / compliance_officer _crud_*  + agent_read_update_*
--   vendor_marketplace_profiles "Admins can manage vendor profiles"
--   vendor_plans             "Admins can manage plans"
--
-- The two worst are worth naming plainly. `integration_credentials` means an
-- admin of ANY brokerage could read, rewrite and DELETE every other brokerage's
-- integration credentials. `user_role_assignments` means an admin or broker of
-- any brokerage could write ROLE GRANTS for any user in any brokerage — a
-- privilege-escalation primitive, not merely a data leak.
-- `document_checklist`'s agent policy tests `user_type = 'agent'` alone, so every
-- agent on the platform could read and update every brokerage's checklist.
--
-- ══ PART 1 — three tables that ALREADY have the right policies ═════════════
--
-- email_templates, integration_credentials and notification_rules each carry a
-- complete correct set: *_tenant_select / _insert / _update / _delete, all
-- `TO authenticated` and all anchored on brokerage_id = current_user_brokerage_id().
-- Nothing needs building. The tenant-free policies beside them are simply
-- deleted, and the correct ones become load-bearing for the first time.
drop policy if exists "Admins can manage integration credentials"   on public.integration_credentials;
drop policy if exists "Admins view integration credentials"         on public.integration_credentials;
drop policy if exists "Admins can manage email templates"           on public.email_templates;
drop policy if exists "Admins and brokers view email templates"     on public.email_templates;
drop policy if exists "Admins can manage notification rules"        on public.notification_rules;
drop policy if exists "Admins and brokers view notification rules"  on public.notification_rules;

-- ══ PART 2 — role grants must not cross a tenant boundary ══════════════════
--
-- user_role_assignments keeps its two correct SELECT policies (_select_brokerage,
-- _select_own). Only the write side was tenant-free, and dropping it alone would
-- leave the table unwritable — so the three commands are rebuilt with the tenant
-- anchor the original lacked.
--
-- The anchor is repeated in WITH CHECK on UPDATE (the m448 lesson): a USING that
-- proves only "this row is in my brokerage" does not stop an admin MOVING the
-- grant into another brokerage, which is the escalation this policy exists to
-- prevent.
drop policy if exists user_role_assignments_write_admin on public.user_role_assignments;

create policy user_role_assignments_tenant_insert on public.user_role_assignments
  for insert to authenticated
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy user_role_assignments_tenant_update on public.user_role_assignments
  for update to authenticated
  using      (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin())
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy user_role_assignments_tenant_delete on public.user_role_assignments
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

-- ══ PART 3 — policies named for a tenant they never test ═══════════════════
--
-- vendor_bookings carries `vb_brokerage` (FOR ALL, brokerage_id =
-- current_user_brokerage_id()) — correct — beside `vendor_bookings_tenant_all`,
-- whose name says tenant and whose body is a bare role roster including 'agent'.
-- Dropping it strictly narrows: every role the roster listed is still admitted by
-- vb_brokerage, now only within their own brokerage.
drop policy if exists vendor_bookings_tenant_all on public.vendor_bookings;

-- closing_notifications and document_checklist each carry a correct *_tenant
-- policy beside three or four role-only ones. Same deletion, same reasoning.
drop policy if exists admin_crud_closing_notifications              on public.closing_notifications;
drop policy if exists broker_crud_closing_notifications             on public.closing_notifications;
drop policy if exists compliance_officer_crud_closing_notifications on public.closing_notifications;
drop policy if exists admin_crud_document_checklist                 on public.document_checklist;
drop policy if exists broker_crud_document_checklist                on public.document_checklist;
drop policy if exists compliance_officer_crud_document_checklist    on public.document_checklist;
drop policy if exists agent_read_update_document_checklist          on public.document_checklist;

-- REPORTED, NOT CHANGED HERE: the surviving closing_notifications_tenant and
-- document_checklist_tenant policies read
--   (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
-- which is the severity inversion tracked as #156 — an UNSTAMPED row satisfies
-- the predicate for every tenant, so it is published rather than hidden. Both
-- tables hold 0 rows and 0 unstamped rows today, so nothing is exposed by it
-- right now. It needs #156's method (find the writers, stamp them, then tighten),
-- not a guess bolted onto a policy deletion.
--
-- ══ PART 4 — the marketplace is PLATFORM-level, not tenant-level ═══════════
--
-- vendor_marketplace_profiles and vendor_plans have NO brokerage_id, because a
-- marketplace vendor does not belong to one brokerage. So "admin or broker" was
-- wrong in a second way: not merely un-scoped, but the wrong ROLE CLASS. These
-- rows are administered by PLATFORM staff.
--
-- vendor_marketplace_profiles holds api_key, api_key_encrypted, stripe_account_id,
-- stripe_customer_id and stripe_subscription_id. Under the old policy every
-- broker of every brokerage could read all of them, and rewrite or delete the row.
--
-- SAFE TO NARROW, verified first: every application WRITE to these tables goes
-- through the SERVICE client (app/actions/vendor-billing.ts,
-- app/api/webhooks/stripe/vendor/route.ts, app/actions/vendor-documents.ts),
-- which bypasses RLS entirely. The ONLY session-client read is
-- app/vendor/billing/page.tsx:18, a vendor reading their OWN row by
-- user_id = auth.uid() — which the surviving self-read policy covers.
drop policy if exists "Admins can manage vendor profiles" on public.vendor_marketplace_profiles;
drop policy if exists "Admins can manage plans"           on public.vendor_plans;
drop policy if exists "Everyone can view active plans"    on public.vendor_plans;

create policy vendor_profiles_platform_manage on public.vendor_marketplace_profiles
  for all to authenticated
  using      (public.is_platform_staff())
  with check (public.is_platform_staff());

-- A vendor may edit their own profile. This is NOT a new capability invented
-- here: the self-read policy already establishes that a vendor owns their row,
-- and the app's own billing surface edits exactly this row (through the service
-- client). Stating it in RLS means the service client is a convenience rather
-- than the only thing standing between a vendor and their own record.
create policy vendor_profiles_self_update on public.vendor_marketplace_profiles
  for update to authenticated
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy vendor_plans_platform_manage on public.vendor_plans
  for all to authenticated
  using      (public.is_platform_staff())
  with check (public.is_platform_staff());

-- public.is_current_user_marketplace_vendor(profile_id) already exists in the
-- database and was referenced by NOTHING. It was written for exactly this: a
-- vendor administering their own plans. vendor_plans.vendor_id FKs
-- vendor_marketplace_profiles(id) — verified — so it is the right argument.
create policy vendor_plans_vendor_manage_own on public.vendor_plans
  for all to authenticated
  using      (public.is_current_user_marketplace_vendor(vendor_id))
  with check (public.is_current_user_marketplace_vendor(vendor_id));

-- The catalogue read was `TO public USING (status = 'active')` — readable by
-- anon. NARROWED to authenticated rather than deleted: the plan catalogue is
-- meant to be browsable by anyone signed in who is shopping the marketplace, and
-- narrowing breaks nothing because the table has NO reader anywhere in app/ or
-- lib/ today (measured). If a genuinely public, signed-out marketplace page is
-- ever built, re-widening this ONE policy is the deliberate change to make — and
-- it should be made knowing the row also carries pricing.
create policy vendor_plans_authenticated_browse on public.vendor_plans
  for select to authenticated
  using (status = 'active');

-- NOT addressed here, and named so it is not mistaken for covered:
-- vendor_marketplace_profiles.api_key is a plaintext-named column sitting beside
-- api_key_encrypted. Both are empty (0 rows in the table), so nothing is exposed
-- today, but two columns for one secret is a decision waiting to be made, not a
-- fact. It needs the owner to say which one is canonical before either is dropped.

-- ══ MEASURED AFTER — a live behavioural proof, not a reading of the policy ══
--
-- Run against the live project as admin@vip.demo (an admin of VIP Premier
-- Realty) reaching for rows owned by Your Brokerage. Throwaway rows, deleted in
-- the same transaction. Residue 0.
--
--   A  reads tenant-B integration credentials ................. 0 rows
--   B  rewrites them .......................................... 0 rows
--   C  deletes them ........................................... 0 rows
--   D  reads a tenant-B role grant ............................ 0 rows
--   E  grants THEMSELVES broker in tenant B ................... REFUSED
--        "new row violates row-level security policy"
--   F  the SAME grant inside their OWN tenant ................. ALLOWED
--   G  reads the vendor marketplace (api keys, stripe ids) .... 0 rows
--   H  sees only their own tenant's credentials ............... 0 rows
--   I  residue after cleanup .................................. 0
--
-- F is the control that makes E mean something. `user_role_assignments` carries
-- a UNIQUE on (user_id, role), so a refusal on E could have been the constraint
-- rather than the policy. Running the identical grant inside the caller's own
-- brokerage — same user, same role — and having it SUCCEED proves the tenant
-- boundary is what refused it.
--
-- ── AND ONE THING THIS PROOF FOUND IN THE APP ──────────────────────────────
--
-- That UNIQUE is on (user_id, ROLE), not on user_id. So one user may hold many
-- grants, and MEASURED: one live user holds three (agent + admin + isa) and
-- another holds two. lib/auth/require-brokerage-admin.ts read this table with
-- `.maybeSingle()`, which over more than one row is an ERROR rather than a pick
-- — so its fallback threw for exactly the users it exists to admit. Both copies
-- it was merged from had the same call, and W47 carried it forward unchecked;
-- the error check added at the same time turned a silent null into a hard
-- refusal. Fixed in that file: read every grant, ignore the ones with a NULL
-- brokerage (a `contact` or `lender` grant is not a tenancy), and choose the one
-- that actually administers.

do $$
begin
  raise notice 'm460: eight tables no longer carry a FOR ALL policy that names a role and forgets the tenant. Integration credentials and role grants are tenant-bound; the vendor marketplace is administered by platform staff and by the vendor themselves.';
end $$;
