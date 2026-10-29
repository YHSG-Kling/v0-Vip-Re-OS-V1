# Owner SQL — the statements only the owner runs (wave 143, lane 143H)

Three migration files are held back from the integrator on purpose, and one more is waiting on an owner decision. This page is the exact script for each, **verbatim from the migration file** (the guard `scripts/operations-docs-guard.ts` fails if any statement here differs from its file), with the check to run *before*, the check to run *after*, and what to do in the repository afterwards.

**Nothing on this page has been run.** Project `hrvaqgvukzxfskkcrwbt`. Where: Supabase dashboard → SQL Editor, signed in as the project owner.

## Why these are yours

The Supabase MCP the integrator works through **holds destructive DDL for the owner's confirmation** (`DROP INDEX`, `DROP COLUMN`; `docs/architecture/PRODUCTION-ARCHITECTURE.md` §9 "Migration application"). The integrator's session cannot give that confirmation — the m739 attempt timed out three times with no lock held (2026-10-07). Each statement below is idempotent (`IF EXISTS`), so a re-run is harmless.

## Order and safety

1. Run **A** and **B** in any order; they touch nothing else. **C** is a decision, not a chore (read its box first). **D** is already applied — it is here so the next person does not re-run it. **F** is RELEASE-BLOCKING (owner ruling 23, wave 145): m854 is already live, so you apply m855 and run its verification. **G** is RELEASE-BLOCKING too (owner ruling 20, wave 146 — the same exposure on the four sibling document buckets): the integrator applies m874 first, then you apply m875 and run its verification. F and G are independent of each other; run each in its own transaction.
2. Run the *before* check first, read the number, then run the script, then the *after* check.
3. Do not run anything on this page in parallel with the integrator applying migrations (CLAUDE.md §7: one statement per call, never in parallel).

## A. m739 — retire the three superseded skill-listing indexes

`supabase/migrations/m739-drop-retired-skill-listing-indexes.sql`. m738 (the one extension lifecycle) re-keyed these by `extension_kind` and its replacements are live (`uq_extension_listings_global_version`, `uq_extension_listings_tenant_version`, `idx_extension_listings_kind_status`). Until the old indexes are dropped, the retired global index is *stricter* than its replacement: a platform strategy and a platform skill cannot share a `skill_id` + `version` (an insert of the second is refused 23505 and surfaced as a refusal, never a silent loss). Live rows: 0.

**Before** (expect the three old names AND the three new names):

```sql
select indexname from pg_indexes where schemaname = 'public' and (indexname like '%skill_marketplace_listings%' or indexname like '%extension_listings%') order by 1;
```

**Run:**

```sql
DROP INDEX IF EXISTS public.uq_skill_marketplace_listings_global_version;
DROP INDEX IF EXISTS public.uq_skill_marketplace_listings_tenant_version;
DROP INDEX IF EXISTS public.idx_skill_marketplace_listings_status;
```

**After** (expect only the `extension_listings` names):

```sql
select indexname from pg_indexes where schemaname = 'public' and (indexname like '%skill_marketplace_listings%' or indexname like '%extension_listings%') order by 1;
```

## B. m771 — drop the Airtable remnant column

`supabase/migrations/m771-airtable-retired-drop-global-settings-airtable-api-key.sql`. Airtable is retired (owner, wave 141). `global_settings.airtable_api_key` has no reader and no writer (the row type no longer names it), 0 rows hold a value, and the SMTP columns and `ghl_api_key` are **deliberately not touched** (owner: both are configured paths). A retired vendor's API key is a credential, not history — so read the *before* number first.

**Before — must print `0`.** If it prints anything else, stop: do not drop a column that holds a value; read the row, decide, then continue.

```sql
select count(*) as non_null_airtable_keys from public.global_settings where airtable_api_key is not null;
```

**Run:**

```sql
ALTER TABLE public.global_settings DROP COLUMN IF EXISTS airtable_api_key;

COMMENT ON TABLE public.global_settings IS
  'Per-brokerage app settings. airtable_api_key dropped by m771 (Airtable retired, wave 141); zapier_api_key dropped by m678. SMTP + ghl_api_key columns stay (configured paths).';
```

**After — must print no row:**

```sql
select column_name from information_schema.columns where table_schema = 'public' and table_name = 'global_settings' and column_name = 'airtable_api_key';
```

**Rollback:** `ALTER TABLE public.global_settings ADD COLUMN airtable_api_key text;` (the data was empty, so nothing is lost).

## C. m795 — `tenant_safety_findings` becomes platform-staff only (DECISION-GATED)

`supabase/migrations/m795-tenant-safety-findings-platform-only.sql`. This is **not** destructive DDL — an integrator can apply it through the MCP — but it is parked here because **it changes what tenant admins see**: `app/dashboard/admin/tenant-safety/page.tsx` and two sibling session-client readers would read `[]` after it, and their un-counted UPDATE would report success on 0 rows.

**The decision (yours):** are tenant safety findings a *tenant* surface or a *platform* surface? If platform → apply this **together with** the app change that re-homes those three readers to the platform console. If tenant → do not apply; the file should instead be rewritten to keep a brokerage-confined policy. Until decided, the two policies keep their tenant roster arrays and the dead `'superadmin'` arm is unreachable on this database (0 rows can match).

```sql
ALTER POLICY tenant_safety_findings_admin_select ON public.tenant_safety_findings
  USING (public.is_platform_staff());

ALTER POLICY tenant_safety_findings_admin_update ON public.tenant_safety_findings
  USING (public.is_platform_staff())
  WITH CHECK (public.is_platform_staff());
```

**After:**

```sql
select policyname, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'tenant_safety_findings' order by 1;
```

## D. Already applied — do not re-run

- **m782** (`users_user_type_check` without `'superadmin'`) was **applied live on 2026-10-19** through the MCP (a `DROP CONSTRAINT` inside one `ALTER TABLE` is accepted; only standalone `DROP INDEX` / `DROP COLUMN` are held). Confirm any time with:

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'users_user_type_check';
```

## E. Written in wave 143, applied by the integrator (not owner SQL)

| File | What | Why it is not yours | Coupled change |
|---|---|---|---|
| `m840-preliminary-statement-has-one-doc-type-spelling.sql` | One `UPDATE`: `transaction_documents.doc_type 'settlement_statement'` → `'preliminary_closing_disclosure'` (the title portal's spelling joins the survivor `cda-portal.ts` already writes). 0 rows today. | A guarded `UPDATE` — the MCP accepts it. Owner approval requested because it renames a vocabulary value. | Four code sites in lanes B/C/G (file:line in the lane notes) ship in the same release. Safe before or after the code: the family reader accepts both spellings. |
| `m841-global-settings-timezone-null-means-derive-from-state.sql` | `ALTER COLUMN timezone DROP NOT NULL` + `DROP DEFAULT` on `global_settings`: NULL = "the tenant has not chosen", so the CDA deadline can use the tenant's zone *when chosen* and the brokerage's state otherwise. 0 rows today. | `ALTER COLUMN` — the MCP accepts it. | The reaper, the milestone bridge and the settings form (file:line in the lane notes). Useless but harmless without them. |

## F. m854 + m855 — the `brokerage-forms` storage policies (RELEASE-BLOCKING P1; wave 145, lane 145A — supersedes wave 144's m853 block)

**Status (re-measured 2026-10-29 by lane 146A, project `hrvaqgvukzxfskkcrwbt`, read-only): STILL OPEN.** m854 is live — `to_regprocedure` finds all four `brokerage_forms_*` functions and `brokerage_forms_path_readable` calls `brokerage_forms_seat_active()` — but m855 is not: `pg_policies` still lists the four bucket-wide names below and none of the `brokerage-forms owner *` names, and `public.storage_bucket_policy_readiness()` (m874's live read, run inline) reports `brokerage-forms` as `open`. The MCP session is still `postgres` with `pg_has_role(current_user, 'supabase_storage_admin', 'member') = false`. (First measured 2026-10-27:) The four live policies on `storage.objects` for this bucket are `"auth read / upload / update / delete brokerage-forms"`, each `bucket_id = 'brokerage-forms'` and nothing else, `TO authenticated`: every signed-in user — a portal **contact** or a **vendor** seat of any tenant included — can read, overwrite and delete every object (every tenant's licensed packet masters and every filled offer: a buyer's name, price and terms). The bucket is private and holds 0 objects today, which is the only reason nothing has leaked.

**Wave 144's block (m853) must NOT be run as it was written.** Its path functions admit every `users` row of the brokerage, and contacts and vendors carry `brokerage_id` (4 + 4 live). Measured with a contact's JWT claims: the live `public.brokerage_forms_path_readable('brokerage/<their brokerage>/x.pdf')` returns **true**. m854 replaces those functions; m855 is the policy block below.

**Why this is yours.** `storage.objects` is owned by `supabase_storage_admin`. The integration session runs as `postgres`, which is neither that owner, nor a member of it, nor a superuser (measured), so `CREATE / DROP POLICY ON storage.objects` is refused `42501: must be owner of table objects`. The dashboard SQL editor runs as `postgres` by default, so it may be refused the same way. Use route A, and fall back to route B if A is refused.

### Order

1. The **integrator** applies `supabase/migrations/m854-brokerage-forms-seat-scoped-path-rules.sql` through the MCP. It is public schema only: four functions, the library `SELECT` policy, and a `pdf_url` clean-up of 0 rows. **Done** — its line 1 reads applied, and the database agrees (measured 2026-10-29).
2. **You** apply m855 (route A or B).
3. Run the verification below and read every expected value. Once m874 (§G) is applied, `SELECT * FROM public.storage_bucket_policy_readiness() WHERE bucket_id = 'brokerage-forms';` must read `owner_scoped` with empty `missing_policies` and `unscoped_policies` — that is the live answer; a migration header is only a claim.

### Before — every line must hold

```sql
-- m854 is applied: all four must be non-null
SELECT to_regprocedure('public.brokerage_forms_seat_active()') AS seat, to_regprocedure('public.brokerage_forms_registered_packet_readable(text)') AS packet, to_regprocedure('public.brokerage_forms_path_readable(text)') AS readable, to_regprocedure('public.brokerage_forms_path_writable(text)') AS writable;
-- what is live now (expect the four "auth … brokerage-forms" names)
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND (policyname ILIKE '%brokerage-forms%' OR qual ILIKE '%brokerage-forms%' OR with_check ILIKE '%brokerage-forms%') ORDER BY policyname;
-- can THIS session run route A? (true = yes; false = expect 42501, use route B)
SELECT current_user, pg_has_role(current_user, 'supabase_storage_admin', 'member') AS can_alter_storage_objects;
```

### Route A — SQL editor (only if `can_alter_storage_objects` is true)

Run the file as it is. It is one transaction: it refuses to start without m854, and if any statement is refused nothing changes. It can be re-run safely, because every `DROP` is `IF EXISTS`, including the m853 names.

```sql
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.brokerage_forms_seat_active()') IS NULL
     OR to_regprocedure('public.brokerage_forms_registered_packet_readable(text)') IS NULL
     OR to_regprocedure('public.brokerage_forms_path_readable(text)') IS NULL
     OR to_regprocedure('public.brokerage_forms_path_writable(text)') IS NULL THEN
    RAISE EXCEPTION 'm855 needs m854 first: the brokerage_forms_* path functions are missing — apply supabase/migrations/m854-brokerage-forms-seat-scoped-path-rules.sql';
  END IF;
END $$;

DROP POLICY IF EXISTS "auth read brokerage-forms"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth update brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth delete brokerage-forms" ON storage.objects;

DROP POLICY IF EXISTS "brokerage-forms owner read"   ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner upload" ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner update" ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner delete" ON storage.objects;

CREATE POLICY "brokerage-forms owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_readable(name));

CREATE POLICY "brokerage-forms owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

CREATE POLICY "brokerage-forms owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name))
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

CREATE POLICY "brokerage-forms owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

COMMIT;
```

### Route B — Dashboard → Storage → Policies (when route A is refused 42501)

Go to **Storage → Policies**, find the bucket `brokerage-forms`, and follow the steps in this order:

1. **Delete** the four policies `auth read brokerage-forms`, `auth upload brokerage-forms`, `auth update brokerage-forms` and `auth delete brokerage-forms`. Deleting first is safe: a bucket with no policy refuses every session (fail closed). The server's own reads and writes use the service role, which bypasses RLS, so they keep working.
2. **New policy → "For full customization"**, four times. For each one, set the target role to `authenticated` and use exactly the name, operation and definition below:

| Name | Operation | USING | WITH CHECK |
|---|---|---|---|
| `brokerage-forms owner read` | SELECT | `bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_readable(name)` | — |
| `brokerage-forms owner upload` | INSERT | — | `bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name)` |
| `brokerage-forms owner update` | UPDATE | `bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name)` | `bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name)` |
| `brokerage-forms owner delete` | DELETE | `bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name)` | — |

### What the policies admit

- **Who.** An **active tenant staff seat**: users.user_type in admin · broker · broker_admin · broker_owner · team_lead · compliance_officer · agent · tc. The account must be not removed, with status active, and not an agent deactivated in that brokerage. A platform **superadmin** may also read. Contacts, vendors, system rows and support rows are never admitted.
  - Measured with this predicate: 13 of 13 staff seats admitted; 0 of 4 contacts, 0 of 4 vendors and 0 of 2 system rows admitted.
- **Read.**
  - Your own `agents/{you}/…`.
  - Your brokerage's loose files in `brokerage/{yours}/…`.
  - A **registered packet** at `…/packets/{row}/…`, but only through its library row, and only when you either:
    - manage it (the oversight class, or that team's lead); or
    - may use it (it is active, its licence has not expired, and it is brokerage-wide or your own live team's).
  - A team's loose files, if you are a member of that live team or in the brokerage's oversight class.
  - `filled/{you or an offer of your brokerage}/…`.
- **Write, update and delete.** Only your own `agents/{you}/…` folder. Every other root is written by the server after its own gate. The only browser writer in the code is the FormWizard upload into `agents/{id}/uploads/`; `scripts/transfer-classification-guard.ts` holds that census.

### Verify afterwards — every expected value must match

```sql
-- exactly four, these names and commands
SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname ILIKE '%brokerage-forms%' ORDER BY policyname;
-- expect: "brokerage-forms owner delete" DELETE · "brokerage-forms owner read" SELECT · "brokerage-forms owner update" UPDATE · "brokerage-forms owner upload" INSERT
-- no bucket-wide rule is left (expect 0 rows)
SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND (qual = '(bucket_id = ''brokerage-forms''::text)' OR with_check = '(bucket_id = ''brokerage-forms''::text)');
-- a CONTACT of a brokerage is refused its brokerage's forms (expect false, false)
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM public.users WHERE user_type = 'contact' AND brokerage_id IS NOT NULL ORDER BY id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.brokerage_forms_seat_active() AS contact_is_seat, public.brokerage_forms_path_readable('brokerage/' || public.current_user_brokerage_id()::text || '/x.pdf') AS contact_reads_brokerage_forms;
ROLLBACK;
-- an AGENT reads their brokerage's loose files and own folder, writes only their own folder (expect true, true, true, false)
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM public.users WHERE user_type = 'agent' AND brokerage_id IS NOT NULL ORDER BY id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.brokerage_forms_path_readable('brokerage/' || public.current_user_brokerage_id()::text || '/x.pdf') AS agent_reads_brokerage, public.brokerage_forms_path_readable('agents/' || auth.uid()::text || '/uploads/x.pdf') AS agent_reads_own, public.brokerage_forms_path_writable('agents/' || auth.uid()::text || '/uploads/x.pdf') AS agent_writes_own, public.brokerage_forms_path_writable('brokerage/' || public.current_user_brokerage_id()::text || '/x.pdf') AS agent_writes_brokerage;
ROLLBACK;
```

Then, in the repository (or ask the integrator):
- flip line 1 of m854 and m855 to `-- ── APPLIED LIVE <date> …`;
- lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts`;
- regenerate the caches with `npm run schema:regen`.

`scripts/transfer-classification-guard.ts` accepts either status line on both files, and holds this section's statements verbatim to m855.

## G. m874 + m875 — the four private document buckets and the offer row (RELEASE-BLOCKING; wave 146, lane 146A — owner ruling 20, priority 1)

**Status (measured 2026-10-29, project `hrvaqgvukzxfskkcrwbt`, read-only): OPEN.** `storage.objects` carries **15 bucket-wide policies** on the four sibling buckets — `auth read / upload / update / delete` on `client-documents`, `offer-documents` and `transaction-documents`, and `auth read / upload / update` on `agent-documents` — each `bucket_id = '<bucket>'` and nothing else, `TO authenticated`. Every signed-in user of any tenant (a portal **contact** and a **vendor** seat included) can list, read, overwrite and delete every client's bank statement, W-9 and pre-approval, every offer PDF, every deal file (wire instructions included) and every agent's licence. All four buckets are private (`public = false`) and the storage schema holds **0 objects**, the only reason nothing has leaked. m874's readiness read, run inline, reports all four as `open`.

The **offer row** has the same shape in the public schema: `offers_tenant_select / _update / _delete` are `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, so a portal contact or a vendor seat reads (and may change) every offer of their brokerage, and every user of every tenant reads an offer whose `brokerage_id` is NULL. Measured with a contact's JWT claims: their `current_user_brokerage_id()` is set, so the live rule admits them. Live offers: 0.

**Why the storage half is yours** — the same reason as §F: the MCP session is `postgres`, not a member of `supabase_storage_admin` (`pg_has_role` = false, re-measured 2026-10-29), so `CREATE / DROP POLICY ON storage.objects` is refused `42501`.

### Order

1. The **integrator** applies `supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql` through the MCP. Public schema only: the path-rule functions, the two offer visibility functions and the three `ALTER POLICY` statements on `public.offers`, and the readiness read `public.storage_bucket_policy_readiness()` (service role only). It adds no table, column, CHECK or FK.
2. **You** apply m875 (route A or B).
3. Run the verification below and read every expected value.

### Before — every line must hold

```sql
-- m874 is applied: all four must be non-null
SELECT to_regprocedure('public.document_bucket_path_access(text, text, text)') AS access, to_regprocedure('public.document_bucket_path_readable(text, text)') AS readable, to_regprocedure('public.document_bucket_path_writable(text, text)') AS writable, to_regprocedure('public.document_bucket_object_deletable(text, text, text, timestamp with time zone)') AS deletable;
-- what is live now (expect the 15 "auth … <bucket>" names)
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND (qual ~ '(client|offer|transaction|agent)-documents' OR with_check ~ '(client|offer|transaction|agent)-documents') ORDER BY policyname;
-- the live verdict per bucket (expect 'open' for the four before m875; 'documents' already reads service_only)
SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness();
-- can THIS session run route A? (true = yes; false = expect 42501, use route B)
SELECT current_user, pg_has_role(current_user, 'supabase_storage_admin', 'member') AS can_alter_storage_objects;
```

### Route A — SQL editor (only if `can_alter_storage_objects` is true)

Run the file as it is. It is one transaction: it refuses to start without m874, and if any statement is refused nothing changes. It can be re-run safely, because every `DROP` is `IF EXISTS`, including the new names.

```sql
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.document_bucket_path_access(text, text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_path_readable(text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_path_writable(text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_object_deletable(text, text, text, timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'm875 needs m874 first: the document_bucket_* path functions are missing — apply supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql';
  END IF;
END $$;

DROP POLICY IF EXISTS "auth read client-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload client-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update client-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete client-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read offer-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload offer-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update offer-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete offer-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read transaction-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload transaction-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update transaction-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete transaction-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read agent-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload agent-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update agent-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete agent-documents" ON storage.objects;

DROP POLICY IF EXISTS "client-documents owner read"        ON storage.objects;
DROP POLICY IF EXISTS "client-documents owner upload"      ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner read"   ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner upload" ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner delete" ON storage.objects;
DROP POLICY IF EXISTS "agent-documents owner read"         ON storage.objects;
DROP POLICY IF EXISTS "agent-documents owner upload"       ON storage.objects;

CREATE POLICY "client-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'client-documents' AND public.document_bucket_path_readable('client-documents', name));

CREATE POLICY "client-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'client-documents' AND public.document_bucket_path_writable('client-documents', name));

CREATE POLICY "transaction-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'transaction-documents' AND public.document_bucket_path_readable('transaction-documents', name));

CREATE POLICY "transaction-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'transaction-documents' AND public.document_bucket_path_writable('transaction-documents', name));

CREATE POLICY "transaction-documents owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'transaction-documents' AND public.document_bucket_object_deletable('transaction-documents', name, owner_id, created_at));

CREATE POLICY "agent-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'agent-documents' AND public.document_bucket_path_readable('agent-documents', name));

CREATE POLICY "agent-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-documents' AND public.document_bucket_path_writable('agent-documents', name));

COMMIT;
```

### Route B — Dashboard → Storage → Policies (when route A is refused 42501)

1. For each of the buckets `client-documents`, `offer-documents`, `transaction-documents` and `agent-documents`, **delete** every `auth read / upload / update / delete <bucket>` policy (15 in all — `agent-documents` has no delete policy today). Deleting first is safe: a private bucket with no policy refuses every session (fail closed), and the server's reads and writes use the service role, which bypasses RLS.
2. **New policy → "For full customization"**, seven times, target role `authenticated`, exactly:

| Name | Operation | USING | WITH CHECK |
|---|---|---|---|
| `client-documents owner read` | SELECT | `bucket_id = 'client-documents' AND public.document_bucket_path_readable('client-documents', name)` | — |
| `client-documents owner upload` | INSERT | — | `bucket_id = 'client-documents' AND public.document_bucket_path_writable('client-documents', name)` |
| `transaction-documents owner read` | SELECT | `bucket_id = 'transaction-documents' AND public.document_bucket_path_readable('transaction-documents', name)` | — |
| `transaction-documents owner upload` | INSERT | — | `bucket_id = 'transaction-documents' AND public.document_bucket_path_writable('transaction-documents', name)` |
| `transaction-documents owner delete` | DELETE | `bucket_id = 'transaction-documents' AND public.document_bucket_object_deletable('transaction-documents', name, owner_id, created_at)` | — |
| `agent-documents owner read` | SELECT | `bucket_id = 'agent-documents' AND public.document_bucket_path_readable('agent-documents', name)` | — |
| `agent-documents owner upload` | INSERT | — | `bucket_id = 'agent-documents' AND public.document_bucket_path_writable('agent-documents', name)` |

`offer-documents` gets **no** policy: every reader and writer of that bucket is the server.

### What the policies admit (the audit behind them is m874's header and `scripts/transfer-classification-guard.ts` section C)

| Bucket · path | Read | Write | Delete |
|---|---|---|---|
| transaction-documents · `transactions/{tx}/{folder}/…` | the deal team: an active staff seat of the deal's brokerage who is its oversight (admin roster minus team_lead), its TC, one of its agents, or the lead of one of those agents' team; **plus** the title party in `title/` and the lender party in `lender/` only | same | the deal team; a title / lender party only its own upload within 15 minutes (the compensating delete) |
| transaction-documents · `vendor-jobs/{brokerage}/{tx}/…` | the deal team; a vendor assigned to the deal (assignment not cancelled, vendor not archived / inactive); the path's brokerage must be the deal's | same | the deal team; the vendor only its own upload within 15 minutes |
| client-documents · `contacts/{contact}/…` | staff on that contact (oversight, TC, its agent, its agent's team lead); the contact themselves | same | — (server only) |
| client-documents · `transactions/{tx}/…` | the deal team; a contact who is a party to the deal | same | — |
| client-documents · `avatars/{contact}-…` | staff on that contact; the contact themselves | same | — |
| client-documents · `vendors/{vendor}/…` | the vendor's own seat; the vendor's brokerage books readers | the vendor's own seat | — |
| client-documents · `{brokerage}/…`, `buyer-intake/…` | server only | server only | server only |
| agent-documents · `{user}/license|eo-insurance/…` | the agent themselves; the oversight class of their **current** brokerage | the agent themselves | — (licence evidence is kept) |
| offer-documents · everything | server only | server only | server only |

A transferred deal's file is **held**: while any `transaction_documents` row of the deal sits in a brokerage other than the transaction's (the adoption rail keeps those rows — `explicit_transfer` — in the archived source), no session reads, writes or deletes that deal's objects. Every rule reads current membership, so suspension, removal, agent deactivation, leaving a team or a cancelled vendor assignment revokes at once. A **signed URL already minted stays valid until it expires** — RLS cannot revoke a bearer token.

### Verify afterwards — every expected value must match

```sql
-- exactly seven, these names and commands
SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname ~ '^(client|transaction|agent)-documents owner ' ORDER BY policyname;
-- expect: agent-documents owner read SELECT · agent-documents owner upload INSERT · client-documents owner read SELECT · client-documents owner upload INSERT · transaction-documents owner delete DELETE · transaction-documents owner read SELECT · transaction-documents owner upload INSERT
-- no bucket-wide rule is left on the four buckets (expect 0 rows)
SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND (qual ~ '^\(bucket_id = ''(client|offer|transaction|agent)-documents''::text\)$' OR with_check ~ '^\(bucket_id = ''(client|offer|transaction|agent)-documents''::text\)$');
-- the live verdict (expect agent-documents, client-documents, transaction-documents = owner_scoped; offer-documents and documents = service_only; brokerage-forms = owner_scoped once §F is done; every missing_policies / unscoped_policies empty)
SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness();
-- a CONTACT is refused a deal file and another contact's folder (expect false, false)
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM public.users WHERE user_type = 'contact' AND brokerage_id IS NOT NULL ORDER BY id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.document_bucket_path_writable('transaction-documents', 'transactions/' || (SELECT id FROM public.transactions WHERE brokerage_id = public.current_user_brokerage_id() ORDER BY id LIMIT 1)::text || '/documents/x.pdf') AS contact_writes_deal_file, public.document_bucket_path_readable('client-documents', 'contacts/' || (SELECT id FROM public.contacts WHERE brokerage_id = public.current_user_brokerage_id() AND contact_user_id IS DISTINCT FROM auth.uid() ORDER BY id LIMIT 1)::text || '/x.pdf') AS contact_reads_other_contact;
ROLLBACK;
-- a VENDOR seat is refused the client's paperwork and an unassigned deal (expect false, false)
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM public.users WHERE user_type = 'vendor' AND brokerage_id IS NOT NULL ORDER BY id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.document_bucket_path_readable('client-documents', 'contacts/' || (SELECT id FROM public.contacts WHERE brokerage_id = public.current_user_brokerage_id() ORDER BY id LIMIT 1)::text || '/x.pdf') AS vendor_reads_client_docs, public.document_bucket_path_readable('transaction-documents', 'transactions/' || (SELECT id FROM public.transactions WHERE brokerage_id = public.current_user_brokerage_id() ORDER BY id LIMIT 1)::text || '/lender/x.pdf') AS vendor_reads_unassigned_deal;
ROLLBACK;
-- the deal's own AGENT reads and writes the deal file; the TC reads it (expect true, true, true)
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT a.user_id FROM public.transactions t JOIN public.agents a ON a.id = t.agent_id ORDER BY t.id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.document_bucket_path_readable('transaction-documents', 'transactions/' || (SELECT t.id FROM public.transactions t ORDER BY t.id LIMIT 1)::text || '/documents/x.pdf') AS agent_reads, public.document_bucket_path_writable('transaction-documents', 'transactions/' || (SELECT t.id FROM public.transactions t ORDER BY t.id LIMIT 1)::text || '/documents/x.pdf') AS agent_writes;
ROLLBACK;
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT u.id FROM public.users u JOIN public.transactions t ON t.brokerage_id = u.brokerage_id WHERE u.user_type = 'tc' ORDER BY t.id, u.id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT public.document_bucket_path_readable('transaction-documents', 'transactions/' || (SELECT t.id FROM public.transactions t WHERE t.brokerage_id = public.current_user_brokerage_id() ORDER BY t.id LIMIT 1)::text || '/documents/x.pdf') AS tc_reads;
ROLLBACK;
-- the OFFER row: a contact sees only offers they are a party to (expect the count of their own offers — 0 today), through real RLS
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT id FROM public.users WHERE user_type = 'contact' AND brokerage_id IS NOT NULL ORDER BY id LIMIT 1), 'role', 'authenticated')::text, true);
SELECT count(*) AS offers_visible_to_contact FROM public.offers;
ROLLBACK;
```

(Measured before m874/m875 with these predicates inlined, 2026-10-29, deal `f0000000-…0001`: the deal's agent, the broker and the TC are admitted to the deal file; another agent of the same brokerage, a contact, a vendor seat and another tenant's admin are refused; the broker reads an agent's licence folder, the TC and another agent do not; a `..` segment is refused while a file named `Smith..v2.pdf` is admitted.)

### Rollback (re-opens the exposure — only to undo a broken apply, and say so)

```sql
-- storage (owner): restore the 15 bucket-wide policies exactly as they were measured live on 2026-10-29
BEGIN;
DROP POLICY IF EXISTS "client-documents owner read" ON storage.objects;  DROP POLICY IF EXISTS "client-documents owner upload" ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner read" ON storage.objects;  DROP POLICY IF EXISTS "transaction-documents owner upload" ON storage.objects;  DROP POLICY IF EXISTS "transaction-documents owner delete" ON storage.objects;
DROP POLICY IF EXISTS "agent-documents owner read" ON storage.objects;  DROP POLICY IF EXISTS "agent-documents owner upload" ON storage.objects;
CREATE POLICY "auth read client-documents" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'client-documents');
CREATE POLICY "auth upload client-documents" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'client-documents');
CREATE POLICY "auth update client-documents" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'client-documents');
CREATE POLICY "auth delete client-documents" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'client-documents');
CREATE POLICY "auth read offer-documents" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'offer-documents');
CREATE POLICY "auth upload offer-documents" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'offer-documents');
CREATE POLICY "auth update offer-documents" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'offer-documents');
CREATE POLICY "auth delete offer-documents" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'offer-documents');
CREATE POLICY "auth read transaction-documents" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'transaction-documents');
CREATE POLICY "auth upload transaction-documents" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'transaction-documents');
CREATE POLICY "auth update transaction-documents" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'transaction-documents');
CREATE POLICY "auth delete transaction-documents" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'transaction-documents');
CREATE POLICY "auth read agent-documents" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'agent-documents');
CREATE POLICY "auth upload agent-documents" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'agent-documents');
CREATE POLICY "auth update agent-documents" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'agent-documents');
COMMIT;
-- the offer row (integrator, MCP): restore the three policies as measured
ALTER POLICY offers_tenant_select ON public.offers USING ((brokerage_id IS NULL) OR (brokerage_id = public.current_user_brokerage_id()));
ALTER POLICY offers_tenant_update ON public.offers USING ((brokerage_id IS NULL) OR (brokerage_id = public.current_user_brokerage_id())) WITH CHECK ((brokerage_id IS NULL) OR (brokerage_id = public.current_user_brokerage_id()));
ALTER POLICY offers_tenant_delete ON public.offers USING ((brokerage_id IS NULL) OR (brokerage_id = public.current_user_brokerage_id()));
```

The m874 functions can stay after a rollback (nothing calls them once the policies are gone).

Then, in the repository (or ask the integrator): flip line 1 of m874 and m875 to `-- ── APPLIED LIVE <date> …`; lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts`. m874 / m875 add no table, column, CHECK or FK, so no cache regeneration is needed. `scripts/transfer-classification-guard.ts` (section C) holds this section verbatim to m875 and accepts either status line.

## H. `personal-videos` — the private bucket for videos addressed to one contact (wave 146, lane 146Z — owner ruling 6; NOT applied)

**Status (measured 2026-10-29, project `hrvaqgvukzxfskkcrwbt`, read-only): the bucket does not exist yet.** Lane 146C found that the agent's personal welcome video was hosted in the PUBLIC `video-assets` bucket, so its URL played for anyone who held it — against ruling 6 ("the asset is visible only to that contact and the relevant agent/tenant"). Since wave 146 every render addressed to one contact (`ai_video_projects.contact_id` set) is hosted in the PRIVATE `personal-videos` bucket (`lib/remotion/media-host.ts` `renderHostBucketFor`; the D-ID poller, the composition coordinator, the card pass and the D-ID re-host sweep), and the contact's portal receives a **one-hour signed URL minted on every read after its session gate** (`lib/portal/welcome-video.ts` `servePortalVideoUrl`). Live at measurement: 0 contact-addressed video projects, 0 welcome renders, 0 objects in `video-assets` — nothing to move.

The bucket is **SERVICE-ONLY**: no `storage.objects` policy may admit `authenticated` or `anon` on it. The server reads and signs with the service role; a signed URL needs no policy. So there is **no policy to create** — this section exists so the bucket is born private on purpose and stays that way.

The first personal render creates it private through the one helper (`lib/storage/buckets.ts` `ensureBucket`, `public: false`). Run step 1 yourself if you would rather it exist before the first render (it is a `storage.buckets` write, so it is owner SQL like §F/§G):

```sql
-- 1. (optional — the first render does the same) create the bucket PRIVATE; re-runnable
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('personal-videos', 'personal-videos', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false;
```

### Verify afterwards — every expected value must match

```sql
-- the bucket is private (expect exactly one row, public = false)
SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'personal-videos';
-- NO policy names it (expect 0 rows) — a bucket-wide "auth read personal-videos" would re-open what this section closes
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND (coalesce(qual, '') ~ 'personal-videos' OR coalesce(with_check, '') ~ 'personal-videos');
-- and no policy is bucket-agnostic for authenticated (expect 0 rows: a policy with no bucket_id predicate admits every bucket, this one included)
SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND 'authenticated' = ANY (roles) AND coalesce(qual, '') !~ 'bucket_id' AND coalesce(with_check, '') !~ 'bucket_id';
```

### After it exists live

1. Regenerate `lib/storage/bucket-limits.ts` from `storage.buckets` (the generator header carries the SQL) — it will gain `"personal-videos": { isPublic: false, … }`.
2. Then `scripts/transfer-classification-guard.ts` section C3 will demand that `public.storage_bucket_policy_readiness()` (m874) covers it, because the read must cover EVERY live, private, document-class bucket: the integrator adds `('personal-videos'::text, NULL::text, ARRAY[]::text[])` to the function's expected list (service-only, like `documents` and `offer-documents`) in a public-schema migration it can apply.

### Rollback

None needed: deleting the bucket is the only undo, and it would delete every personal video in it. A wrong policy is undone with `DROP POLICY IF EXISTS "<name>" ON storage.objects;`.

## After you run anything on this page

1. In the repository (or ask the integrator): flip the file's first-line status from `WRITTEN, NOT APPLIED` to `APPLIED <date>` and lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts` by one per file applied.
2. Regenerate the schema caches — never hand-edit them: `npm run schema:regen` (snapshot, FK map, agent FK, vocabularies). After a dropped column the cached `global_settings` column list must lose `airtable_api_key`.
3. `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` must be green before anything else is pushed.
