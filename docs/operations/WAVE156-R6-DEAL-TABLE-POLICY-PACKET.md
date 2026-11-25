# Wave 156 — §R.6 owner packet: who may INSERT into the five deal tables

**For:** the owner (runs privileged SQL on the live database). **Prepared by:** wave 156, lane 156E, 2026-11-25.
**Status:** NOT APPLIED. Nothing in this packet has been run on the live database. A measurement on a local PostgreSQL is not
proof that production is fixed: production is fixed only when the AFTER readback (step 4) and the two-tenant check (step 5)
below come back as written, on the live project.

The exact statements are the ones in `docs/operations/OWNER-SQL.md` §R.6, copied byte-for-byte (fingerprint below). This
packet adds what that section leaves short: the before state as read today, what changes for each seat in plain words, the
evidence and its limits, the apply steps, the after readback, a two-tenant check that ends in ROLLBACK, and a rollback that
does not casually reopen cross-tenant writes.

---

## 1. What is wrong today, in one paragraph

Five tables hold a deal's working details: `transaction_participants`, `transaction_deadlines`, `transaction_title_escrow`,
`transaction_repair_negotiations`, `transaction_timeline`. Each has two row-security policies. The agent policy's INSERT
check asks only "does the new row carry your own tenant?" — it never asks about the deal or the seat. Because the two
policies are permissive (either one is enough), **any signed-in seat that has a tenant — a vendor seat or a client seat
included — can insert a row on any deal id, another brokerage's deal included**, through the database API, as long as the row
carries its own tenant. The deal's agents then see that row. The application itself no longer writes these tables through a
signed-in user's client (all writes go through gated server code), so the hole is reachable only by someone calling the
database API directly with their own login.

## 2. BEFORE — the live policy, re-read today (read-only)

Read on project `hrvaqgvukzxfskkcrwbt`, 2026-11-25, with `pg_policies` / `pg_class` / `information_schema` (catalog reads and
row COUNTS only):

| Table | Row security | Policies | Rows live | `authenticated` may INSERT |
|---|---|---|---|---|
| transaction_participants | on (not forced) | 2 | 0 | yes |
| transaction_deadlines | on (not forced) | 2 | 0 | yes |
| transaction_title_escrow | on (not forced) | 2 | 0 | yes |
| transaction_repair_negotiations | on (not forced) | 2 | 0 | yes |
| transaction_timeline | on (not forced) | 2 | 0 | yes |

The policy text on every table (identical apart from the table name):

- `trx_agent_<table>` — ALL, PERMISSIVE, role `public`.
  USING: the row's `transaction_id` is a deal whose `agent_id` / `buyer_agent_id` / `seller_agent_id` is an `agents.id` with
  `agents.user_id = auth.uid()`. **WITH CHECK: `(brokerage_id = current_user_brokerage_id())`.**
- `trx_broker_<table>` — ALL, PERMISSIVE, role `public`. USING and WITH CHECK:
  `((brokerage_id = current_user_brokerage_id()) AND (current_user_type() = ANY (ARRAY['broker','admin','super_admin','tc'])))`.

**Changed since 2026-11-20?** No. The text above is exactly what `OWNER-SQL.md` §R.6 and `scripts/deal-desk-guard.ts`
(`pg_policies, read 2026-11-20`) record: two policies per table, the same USING and WITH CHECK, the same four-seat roster
(`super_admin` is not a storable `users.user_type`). All five tables are still empty. (Today's per-table policy fingerprints, md5
over name + command + USING + CHECK, for comparing at apply time: participants `4535fb79…`, deadlines `41572844…`, title_escrow
`d7cb08cd…`, repair_negotiations `20dcad0b…`, timeline `8fe2167b…`.)

## 3. The exact statements (verbatim from OWNER-SQL.md §R.6)

Fingerprint (sha256 of the `begin; … commit;` block, whitespace-collapsed): `41350c1715b02ece98c084a0deda6248420a4311e7b7b39a399fa521c99c47ad`. `test:deal-desk` §F fails if this text is
edited without a new measurement. Do not edit it here either; if it must change, measure again with
`scripts/deal-table-policy-measure.py` and update OWNER-SQL.md.

```sql
-- Before: expect 10 rows (2 per table); every trx_agent_* with_check reads "(brokerage_id = current_user_brokerage_id())"
select tablename, policyname, cmd, with_check from pg_policies
 where schemaname = 'public' and tablename in ('transaction_participants', 'transaction_deadlines', 'transaction_title_escrow', 'transaction_repair_negotiations', 'transaction_timeline') order by 1, 2;
-- Do (one transaction; ALTER POLICY keeps each policy's name, command and roles):
begin;
alter policy trx_agent_transaction_participants on public.transaction_participants
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id() and (t.agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.buyer_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.seller_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))));
alter policy trx_broker_transaction_participants on public.transaction_participants
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
alter policy trx_agent_transaction_deadlines on public.transaction_deadlines
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id() and (t.agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.buyer_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.seller_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))));
alter policy trx_broker_transaction_deadlines on public.transaction_deadlines
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
alter policy trx_agent_transaction_title_escrow on public.transaction_title_escrow
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id() and (t.agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.buyer_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.seller_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))));
alter policy trx_broker_transaction_title_escrow on public.transaction_title_escrow
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
alter policy trx_agent_transaction_repair_negotiations on public.transaction_repair_negotiations
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id() and (t.agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.buyer_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.seller_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))));
alter policy trx_broker_transaction_repair_negotiations on public.transaction_repair_negotiations
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
alter policy trx_agent_transaction_timeline on public.transaction_timeline
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id() and (t.agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.buyer_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()) or t.seller_agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))));
alter policy trx_broker_transaction_timeline on public.transaction_timeline
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc']) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
commit;
-- After: the same SELECT — every trx_agent_* with_check names the deal; every trx_broker_* names the six desk seats and the deal.
-- Then, signed in as a vendor seat and as a contact seat of a test tenant, an INSERT into each table must be refused (42501).
-- Rollback: re-run ALTER POLICY with the with_check / using text the Before read returned.
```

### What it changes, in plain words

- **Agent policy:** inserting (and changing) a row now also requires that you are an agent ON that row's deal, and that the deal
  belongs to your own brokerage. Reading is unchanged.
- **Broker policy:** the seats it names become the deal desk's brokerage tier — `broker`, `broker_owner`, `broker_admin`,
  `admin`, `compliance_officer`, `tc` (adds broker owner, broker admin and compliance officer; drops the dead name
  `super_admin`); inserting also requires the deal to belong to your own brokerage.
- **Nothing anyone can read today disappears.** No table is dropped, no grant changes, no row is touched.
- **The team lead route is deliberately not in SQL.** A team lead on a team member's deal is served by the application's gated
  server doors (the deal desk, `lib/transactions/role-guard.ts`), not by the database API — expressing "the team you lead" in
  the policy would need a team function. No access is hidden or widened by this.

## 4. Effect per seat (measured — PostgreSQL 16.15, 16 seats × 8 operations, identical on all five tables)

The deal is tenant A's. Every seat is a seat of tenant A except "Tenant B's broker" and "Not signed in"; each seat stamps its OWN tenant on the row.
Columns: insert on tenant A's deal · insert on tenant B's deal · update a row · delete a row · rows visible on the deal.

| Seat | BEFORE (live today) | AFTER (this block) | What changes |
|---|---|---|---|
| Broker | allowed · allowed · allowed · allowed · 1 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant B's deal |
| Broker owner | allowed · allowed · no effect · no effect · 0 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant A's deal and read it back; insert on tenant B's deal; update a row; delete a row; rows visible on the deal |
| Broker admin | allowed · allowed · no effect · no effect · 0 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant A's deal and read it back; insert on tenant B's deal; update a row; delete a row; rows visible on the deal |
| Admin | allowed · allowed · allowed · allowed · 1 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant B's deal |
| Compliance officer | allowed · allowed · no effect · no effect · 0 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant A's deal and read it back; insert on tenant B's deal; update a row; delete a row; rows visible on the deal |
| Transaction coordinator (tc) | allowed · allowed · allowed · allowed · 1 row(s) | allowed · refused · allowed · allowed · 1 row(s) | insert on tenant B's deal |
| Agent on the deal (listing side) | allowed · allowed · allowed · allowed · 2 row(s) | allowed · refused · allowed · allowed · 2 row(s) | insert on tenant B's deal |
| Agent on the deal (buyer side) | allowed · allowed · allowed · allowed · 2 row(s) | allowed · refused · allowed · allowed · 2 row(s) | insert on tenant B's deal |
| Team lead (not an agent on the deal) | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| Agent NOT on the deal | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| Vendor seat (lender / title / inspector) | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| Client (contact) seat | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| ISA seat | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| Seat with no user_type | allowed · allowed · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant B's deal |
| Tenant B's broker | allowed · allowed · no effect · no effect · 0 row(s) | refused · allowed · no effect · no effect · 0 row(s) | insert on tenant A's deal; insert on tenant A's deal and read it back |
| Not signed in | refused · refused · no effect · no effect · 0 row(s) | refused · refused · no effect · no effect · 0 row(s) | no change |

The full cells (eight operations, in order: insert on tenant A's deal · the same and read it back · insert with no tenant ·
insert on tenant B's deal · update a row · update a never-stamped row · delete a row · rows visible; `42501` = refused by row
security, a number = rows affected / visible):

| Seat | BEFORE | AFTER |
|---|---|---|
| Broker | `1 1 42501 1 1 0 1 1` | `1 1 42501 42501 1 0 1 1` |
| Broker owner | `1 42501 42501 1 0 0 0 0` | `1 1 42501 42501 1 0 1 1` |
| Broker admin | `1 42501 42501 1 0 0 0 0` | `1 1 42501 42501 1 0 1 1` |
| Admin | `1 1 42501 1 1 0 1 1` | `1 1 42501 42501 1 0 1 1` |
| Compliance officer | `1 42501 42501 1 0 0 0 0` | `1 1 42501 42501 1 0 1 1` |
| Transaction coordinator (tc) | `1 1 42501 1 1 0 1 1` | `1 1 42501 42501 1 0 1 1` |
| Agent on the deal (listing side) | `1 1 42501 1 1 42501 1 2` | `1 1 42501 42501 1 42501 1 2` |
| Agent on the deal (buyer side) | `1 1 42501 1 1 42501 1 2` | `1 1 42501 42501 1 42501 1 2` |
| Team lead (not an agent on the deal) | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| Agent NOT on the deal | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| Vendor seat (lender / title / inspector) | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| Client (contact) seat | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| ISA seat | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| Seat with no user_type | `1 42501 42501 1 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |
| Tenant B's broker | `1 1 42501 1 0 0 0 0` | `42501 42501 42501 1 0 0 0 0` |
| Not signed in | `42501 42501 42501 42501 0 0 0 0` | `42501 42501 42501 42501 0 0 0 0` |

Read it this way: before, every seat with a tenant could insert on tenant A's deal AND on tenant B's deal. After, only an
agent on the deal and the six desk seats insert, and only on a deal of their own tenant; a vendor, a client, an ISA, an agent
off the deal, a team lead (through the database API), a seat with no type and an anonymous caller are refused. Tenant B's
broker loses inserting on tenant A's deal and keeps inserting on its own tenant's deal. Broker owner, broker admin and the
compliance officer GAIN update / delete / visibility of these rows in their own tenant (they are desk seats the old roster
omitted). "Update a never-stamped row" stays refused for the agents — an older row with no tenant still fails the tenant check, as
today; the application edits such rows through its gated server doors.

## 5. The evidence, and its limits

- `scripts/deal-table-policy-measure.py` loaded the verbatim live policy and helper-function text into a local PostgreSQL
  16.15, ran every seat × operation, applied the block above unchanged, and ran them again. All five tables answered the same.
  The two 16 × 8 tables are pinned in `scripts/deal-desk-guard.ts` (`PG_MEASURED`), and that guard's policy model reproduces
  every cell (`test:deal-desk` §F, green 2026-11-25: 281 passed, 0 failed).
- The application does not depend on the old hole: the census in `test:deal-desk` §F finds every write statement on the five
  tables in `app/` and `lib/` on the service client behind a gate — none on a signed-in user's client.
- **Limits.** The local database had no row security on `public.transactions` / `public.agents`; live, those tables have their
  own policies, which the new CHECKs read as the caller — they can only refuse MORE (fail closed), never admit more. The local
  run used the live function text, not the live function owners / `SECURITY DEFINER` settings. No live seat signed in. That is
  why steps 4 and 5 below are required: **a local measurement is not proof that production is fixed.**

## 6. Apply — step by step (owner, Supabase SQL editor, project `hrvaqgvukzxfskkcrwbt`)

1. **Window.** Any time; the tables are empty and the application does not write them through a user client. Takes seconds.
2. **BEFORE readback.** Run the `select … from pg_policies …` at the top of the block in §3. Expect 10 rows; every
   `trx_agent_*` `with_check` reads `(brokerage_id = current_user_brokerage_id())`; every `trx_broker_*` names
   `broker, admin, super_admin, tc`. **Save this output** — it is your exact rollback text. If it differs from §2, STOP: the
   policy changed since this packet; do not apply.
3. **Apply.** Run the `begin; … commit;` block exactly as written. It is one transaction: either all ten statements land or
   none do.
4. **AFTER readback** (expected results):

   ```sql
   select tablename, policyname, cmd, permissive, roles::text,
          (with_check like '%auth.uid()%' and with_check like '%t.brokerage_id = current_user_brokerage_id()%') as check_names_the_deal,
          (coalesce(qual,'') like '%compliance_officer%' and coalesce(qual,'') not like '%super_admin%') as roster_is_desk_tier
     from pg_policies
    where schemaname = 'public'
      and tablename in ('transaction_participants','transaction_deadlines','transaction_title_escrow','transaction_repair_negotiations','transaction_timeline')
    order by 1, 2;
   ```

   Expect exactly 10 rows, all `ALL` / `PERMISSIVE` / `{public}`. Every `trx_agent_*` row: `check_names_the_deal = true`.
   Every `trx_broker_*` row: `roster_is_desk_tier = true` (its CHECK names the deal through `t.brokerage_id`, not `auth.uid()`,
   so its `check_names_the_deal` reads false — that is expected). Also confirm nothing else moved:

   ```sql
   select c.relname, c.relrowsecurity, count(p.policyname) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
    where n.nspname = 'public'
      and c.relname in ('transaction_participants','transaction_deadlines','transaction_title_escrow','transaction_repair_negotiations','transaction_timeline')
    group by 1, 2 order by 1;
   ```

   Expect five rows, `relrowsecurity = true`, `policies = 2` each.
5. **Two-tenant check (ends in ROLLBACK — leaves nothing behind).** Pick, from your own data, these ids (do not paste them
   anywhere else): tenant A's deal `DEAL_A` (with an assigned agent), tenant B's deal `DEAL_B`; in tenant A a broker user
   `A_BROKER`, the user behind `DEAL_A`'s agent `A_AGENT_ON_DEAL`, an agent user NOT on `DEAL_A` `A_AGENT_OFF`, a vendor user
   `A_VENDOR`, a client user `A_CONTACT`; and tenant B's broker user `B_BROKER`. Replace the placeholders, then run the whole
   script at once:

   ```sql
   begin;
   create or replace function pg_temp.try_as(p_user uuid, p_deal uuid, p_label text) returns text language plpgsql as $f$
   declare v_tenant uuid;
   begin
     perform set_config('request.jwt.claim.sub', p_user::text, true);
     perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
     select brokerage_id into v_tenant from public.users where id = p_user;
     begin
       set local role authenticated;
       insert into public.transaction_participants (transaction_id, brokerage_id, role, name) values (p_deal, v_tenant, 'inspector', 'R6 CHECK — rolled back');
       reset role;
       return p_label || ': ALLOWED';
     exception when insufficient_privilege then
       reset role;
       return p_label || ': REFUSED (42501)';
     end;
   end $f$;
   select pg_temp.try_as('A_BROKER'::uuid,        'DEAL_A'::uuid, 'A broker, own deal');            -- expect ALLOWED
   select pg_temp.try_as('A_AGENT_ON_DEAL'::uuid, 'DEAL_A'::uuid, 'A agent on the deal');           -- expect ALLOWED
   select pg_temp.try_as('A_AGENT_OFF'::uuid,     'DEAL_A'::uuid, 'A agent off the deal');          -- expect REFUSED
   select pg_temp.try_as('A_VENDOR'::uuid,        'DEAL_A'::uuid, 'A vendor seat');                 -- expect REFUSED
   select pg_temp.try_as('A_CONTACT'::uuid,       'DEAL_A'::uuid, 'A client seat');                 -- expect REFUSED
   select pg_temp.try_as('A_BROKER'::uuid,        'DEAL_B'::uuid, 'A broker, tenant B deal');       -- expect REFUSED
   select pg_temp.try_as('B_BROKER'::uuid,        'DEAL_A'::uuid, 'B broker, tenant A deal');       -- expect REFUSED
   rollback;
   ```

   Run the same script BEFORE step 3 too if you want to see the hole for yourself: before, all seven lines read ALLOWED (the
   off-deal agent, the vendor, the client and both cross-tenant attempts insert — each row stamped with the caller's own
   tenant). After step 3 the five "expect REFUSED" lines must read REFUSED. **If any "expect REFUSED" line reads ALLOWED after step 3, production is NOT fixed — stop and report.**
   The script ends in `rollback`: no row, no function and no setting survives it. (Only `transaction_participants` is
   exercised; the five tables carry the same two policies, which step 4 confirms.)
6. **Record** the step-4 and step-5 output in `OWNER-SQL.md` §R.6 (status → APPLIED, with the date) — the integrator edits that
   file, not this packet.

## 7. Rollback — narrowest first; never a casual reopening of cross-tenant writes

Rollback should rarely be needed: the application writes none of these tables through a user client. If something breaks,
use the narrowest step that fixes it.

**R-1 — a desk seat is refused through the database API and you need it back today.** Keep the deal-in-your-tenant CHECK and
widen only the roster of the broker policy for the table concerned (example: participants; add the seat to both lists):

```sql
-- Not measured on PostgreSQL; it widens WHO among this tenant's seats, never WHICH tenant's deal.
alter policy trx_broker_transaction_participants on public.transaction_participants
  using (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc' /*, '<seat>' */]))
  with check (brokerage_id = current_user_brokerage_id() and current_user_type() = any (array['broker','broker_owner','broker_admin','admin','compliance_officer','tc' /*, '<seat>' */]) and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
```

**R-2 — an agent's own insert is refused and you need it back today.** Relax the agent CHECK to "a deal of your own tenant"
(drops "you are on the deal", keeps the tenant fence — cross-tenant inserts stay closed). Example for one table:

```sql
-- Not measured on PostgreSQL. Re-opens: any seat of the SAME tenant may insert on its tenant's deals. Cross-tenant stays closed.
alter policy trx_agent_transaction_participants on public.transaction_participants
  with check (brokerage_id = current_user_brokerage_id() and transaction_id in (select t.id from public.transactions t where t.brokerage_id = current_user_brokerage_id()));
```

**R-3 — the full revert (restores the measured hole: any seat with a tenant inserts on ANY deal, another tenant's included).**
Only on an explicit owner decision, recorded with the reason, and re-applied as soon as the cause is fixed. The text is the
Before read of step 2 (shown here for participants; repeat per table with that table's names):

```sql
begin;
alter policy trx_agent_transaction_participants on public.transaction_participants
  with check (brokerage_id = current_user_brokerage_id());
alter policy trx_broker_transaction_participants on public.transaction_participants
  using ((brokerage_id = current_user_brokerage_id()) and (current_user_type() = any (array['broker'::text, 'admin'::text, 'super_admin'::text, 'tc'::text])))
  with check ((brokerage_id = current_user_brokerage_id()) and (current_user_type() = any (array['broker'::text, 'admin'::text, 'super_admin'::text, 'tc'::text])));
-- … the same two statements for transaction_deadlines, transaction_title_escrow, transaction_repair_negotiations, transaction_timeline
commit;
```

After any rollback, re-run step 4's readback and say which state each table is in.

## 8. What this packet does NOT claim

- It does not claim production is fixed. Only steps 4 and 5 on the live project can say that.
- It does not cover other tables' row security (`public.transactions`, `transaction_milestones`, `deposits`, …), nor reads:
  read permission (USING) is unchanged by design; work authority is the application's deal desk.
- R-1 and R-2 were not measured on PostgreSQL; the AFTER block was.
