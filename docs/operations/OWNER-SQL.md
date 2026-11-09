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

## I. The four unlinked portal-contact seed accounts (RELEASE-BLOCKING owner data step; wave 146 §19.2, carried by wave 147, lane 147H)

**Status (measured 2026-10-31, project `hrvaqgvukzxfskkcrwbt`, read-only):** `public.users` holds **4** rows with `user_type = 'contact'` and **all 4** have no `public.contacts` row pointing at them by `contact_user_id`. They are seed rows. Under the m874 / m875 per-party storage rules a portal contact is admitted to a document only through `contacts.contact_user_id = auth.uid()`, so after §G these four accounts can sign in and see **nothing** — and a real client invited later must not inherit a seed identity. This is a data decision only you can make: link each account to the real contact it belongs to, or delete the seed account.

```sql
-- 1. the census (expect 0 rows when this section is done)
SELECT u.id, u.email, u.brokerage_id, u.created_at
FROM public.users u
WHERE u.user_type = 'contact'
  AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.contact_user_id = u.id);

-- 2a. LINK — one statement per account, the contact chosen by you (same brokerage; check the email matches)
-- UPDATE public.contacts SET contact_user_id = '<users.id>' WHERE id = '<contacts.id>' AND brokerage_id = '<users.brokerage_id>' AND contact_user_id IS NULL RETURNING id;

-- 2b. or REMOVE — a seed account with no real client behind it (delete the auth user in Authentication → Users; the
--     public.users row follows its FK). Never delete a contacts row to make the census read zero.
```

### Verify afterwards

```sql
SELECT count(*) AS unlinked_contact_users FROM public.users u
WHERE u.user_type = 'contact' AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.contact_user_id = u.id);  -- expect 0
```

When the census reads 0, record it on the line below (the readiness guard reads it — `scripts/production-readiness-guard.ts` owner obligation O2 stays RELEASE-BLOCKING until this line says RESOLVED with the date and the zero):

- Status: OPEN — 4 unlinked (re-measured 2026-11-01 by lane 148A; each pairs with exactly one same-email contact in its own tenant — the scoped LINK script below is ready)

### Inventory (wave 148, lane 148A — measured 2026-11-01, project `hrvaqgvukzxfskkcrwbt`, READ-ONLY)

All four are rows of the seeded showcase tenant **VIP Premier Realty** (`b0000000-0000-0000-0000-000000000001`, slug `vip-premier-realty-b000`), created together on 2026-03-31 with `@vip.demo` addresses, `status = 'active'`, each with its `auth.users` row (one has signed in once, 2026-04-02). No `user_invitations` row names any of them. For each, exactly **one** `public.contacts` row in the SAME tenant carries the SAME email (case-insensitive) and the SAME name, with `contact_user_id` NULL — and no contact in any other tenant carries those emails. Emails are masked here on purpose.

| users.id (seed account) | who | contacts.id (the pairing) | contact_type | agent |
|---|---|---|---|---|
| `a0000000-0000-0000-0000-000000000013` | Sarah M · `bu***@vip.demo` | `50000000-0000-0000-0000-000000000001` | buyer | `c0000000-0000-0000-0000-000000000005` |
| `a0000000-0000-0000-0000-000000000014` | Robert C · `se***@vip.demo` | `50000000-0000-0000-0000-000000000002` | seller | `c0000000-0000-0000-0000-000000000005` |
| `a0000000-0000-0000-0000-000000000015` | Maria G · `un***@vip.demo` | `50000000-0000-0000-0000-000000000003` | buyer | `c0000000-0000-0000-0000-000000000005` |
| `a0000000-0000-0000-0000-000000000016` | James R · `pa***@vip.demo` | `50000000-0000-0000-0000-000000000004` | lifetime_customer | `c0000000-0000-0000-0000-000000000005` |

What a link changes and does not: `contacts.contact_user_id` only (FK → `auth.users`, ON DELETE SET NULL; plain index, no unique constraint). The one trigger on `contacts` (`trg_contacts_emit_agent_assigned`) fires only when `agent_id` changes, so a link emits nothing. No row is deleted, no account is disabled.

### Remediation A — LINK (recommended: every pairing above is exact). One transaction; scoped to the four ids; refuses to change anything if any pairing has drifted since the inventory; reversible below.

```sql
-- §I REMEDIATION A — LINK THE FOUR SEED ACCOUNTS TO THEIR OWN CONTACT (owner SQL editor or the integrator's MCP, after the owner says "link")
BEGIN;
CREATE TEMP TABLE seed_link (user_id uuid PRIMARY KEY, contact_id uuid NOT NULL UNIQUE) ON COMMIT DROP;
INSERT INTO seed_link (user_id, contact_id) VALUES
  ('a0000000-0000-0000-0000-000000000013', '50000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000014', '50000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000015', '50000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000016', '50000000-0000-0000-0000-000000000004');
DO $$
DECLARE ok_pairs int;
BEGIN
  SELECT count(*) INTO ok_pairs
  FROM seed_link l
  JOIN public.users u    ON u.id = l.user_id AND u.user_type = 'contact'
  JOIN public.contacts c ON c.id = l.contact_id AND c.brokerage_id = u.brokerage_id
                        AND lower(c.email) = lower(u.email) AND c.contact_user_id IS NULL
  WHERE NOT EXISTS (SELECT 1 FROM public.contacts x WHERE x.contact_user_id = u.id);
  IF ok_pairs <> 4 THEN
    RAISE EXCEPTION 'seed link refused: % of 4 pairings still match the 2026-11-01 inventory — re-run the census and re-decide', ok_pairs;
  END IF;
END $$;
UPDATE public.contacts c
   SET contact_user_id = l.user_id, updated_at = now()
  FROM seed_link l
 WHERE c.id = l.contact_id AND c.contact_user_id IS NULL
RETURNING c.id AS contact_id, c.contact_user_id;   -- expect exactly 4 rows
COMMIT;
```

**Rollback of A** (restores exactly what A changed — only where the link is still the seed account):

```sql
-- §I ROLLBACK A
UPDATE public.contacts
   SET contact_user_id = NULL, updated_at = now()
 WHERE (id, contact_user_id) IN (
   ('50000000-0000-0000-0000-000000000001'::uuid, 'a0000000-0000-0000-0000-000000000013'::uuid),
   ('50000000-0000-0000-0000-000000000002'::uuid, 'a0000000-0000-0000-0000-000000000014'::uuid),
   ('50000000-0000-0000-0000-000000000003'::uuid, 'a0000000-0000-0000-0000-000000000015'::uuid),
   ('50000000-0000-0000-0000-000000000004'::uuid, 'a0000000-0000-0000-0000-000000000016'::uuid))
RETURNING id;   -- expect the rows A linked
```

### Remediation B — ARCHIVE (only if you decide these seed identities must never sign in). Same four ids, no deletion: `users.status = 'inactive'` (the deactivation spelling `app/actions/superadmin/platform-staff.ts` already writes). Then, in **Authentication → Users**, ban each of the four auth users so a live session cannot be minted. B removes the exposure but does NOT make the census read zero (the census counts contact users with no contact link), so O2 stays RELEASE-BLOCKING after B by design — prefer A.

```sql
-- §I REMEDIATION B — ARCHIVE (reversible: set status back to 'active' and lift the ban)
UPDATE public.users SET status = 'inactive', updated_at = now()
 WHERE id IN ('a0000000-0000-0000-0000-000000000013','a0000000-0000-0000-0000-000000000014','a0000000-0000-0000-0000-000000000015','a0000000-0000-0000-0000-000000000016')
   AND user_type = 'contact' AND status = 'active'
RETURNING id;   -- expect 4 rows
-- ROLLBACK B: UPDATE public.users SET status = 'active', updated_at = now() WHERE id IN (<the same four ids>) AND status = 'inactive' RETURNING id;
```

Neither remediation deletes anything. Deleting a seed account (Authentication → Users → delete; the `public.users` row follows, `contacts.contact_user_id` would go NULL by its FK) needs your explicit authorization and is not scripted here.

## J. Release-blocker close-out — run in this order once §F, §G and §I are done (wave 148, lane 148A)

Nothing is LIVE or production-safe until every step below reads its expected value. Each one is a READ — run them after the policies are applied (§F route A/B, §G route A/B) and the seed accounts are remediated (§I).

1. **The live storage verdict** (the one answer; a migration header is only a claim):
   ```sql
   SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness() ORDER BY bucket_id;
   -- expect: agent-documents owner_scoped · brokerage-forms owner_scoped · client-documents owner_scoped · documents service_only · offer-documents service_only · transaction-documents owner_scoped — every missing_policies and unscoped_policies EMPTY
   ```
2. **No bucket-wide rule left anywhere on the five buckets** (expect 0 rows):
   ```sql
   SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (qual ~ '^\(bucket_id = ''(brokerage-forms|client-documents|offer-documents|transaction-documents|agent-documents)''::text\)$'
       OR with_check ~ '^\(bucket_id = ''(brokerage-forms|client-documents|offer-documents|transaction-documents|agent-documents)''::text\)$');
   ```
3. **Exactly eleven owner policies** — the four of §F and the seven of §G (expect 11):
   ```sql
   SELECT count(*) AS owner_policies FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname ~ '^(brokerage-forms|client-documents|transaction-documents|agent-documents) owner ';
   ```
4. **The impersonation checks** in §F "Verify afterwards" and §G "Verify afterwards" — every expected `true` / `false` exactly as written there (a contact and a vendor seat refused; the deal's agent and TC admitted).
5. **The seed census** (expect 0 after §I remediation A):
   ```sql
   SELECT count(*) AS unlinked_contact_users FROM public.users u
   WHERE u.user_type = 'contact' AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.contact_user_id = u.id);
   ```
6. **In the repository** (or ask the integrator), in one commit: flip line 1 of `supabase/migrations/m854-…`, `m855-…`, `m874-…` and `m875-…` to `-- ── APPLIED LIVE <date> …`; lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts` by one per file flipped; flip §I's status line to `- Status: RESOLVED <date> — census 0`.
7. **The proofs that read those stamps go green on the rule, not on a waypoint:** `npm run test:release-blockers` (prints `RELEASE BLOCKERS: 0 owner obligation(s) open` for the storage and seed items), `npm run test:production-readiness` (O1 and O2 `discharged`), `npm run test:transfer-classification`, `npm run test:migration-claim`.

## K. O1 / O2 — your order of work, and the integrator's read-only re-measurement (wave 150, lane 150AAF)

**Nothing on this page has been run by a lane.** As of 2026-11-06 O1 and O2 are OPEN in the tree: `m855` and `m875` carry the lane stamp (not applied) and §I's status line reads OPEN; the last live reads were 2026-11-03 (five private buckets `open`, 19 bucket-wide rules, 0 owner policies, 0 objects in any bucket) and 2026-11-01 (four unlinked seed accounts, `ok_pairs = 4`). `npm run test:release-blockers` derives both from the stamps and the status line — never from this paragraph.

### Your order (owner)

1. **Before anything:** ask the integrator to run Q1–Q9 below and paste the results into the release report; if Q5 reads `bucket_wide_on_five` below 19 while Q3 still says `open`, stop — the finder is blind (positive control below).
2. **O1, brokerage-forms:** run §F "Before", then §F route A if Q1 says `can_alter_storage_objects = true`, otherwise §F route B (Dashboard → Storage → Policies). Then §F "Verify afterwards" — every expected value.
3. **O1, the four document buckets + offer row:** the same for §G (Before → route A or B → Verify afterwards).
4. **O2, the four seed accounts:** decide LINK (recommended — every pairing is exact) or ARCHIVE. For LINK, run Q8 alone first: it must read `ok_pairs = 4`, otherwise re-decide. Then run §I REMEDIATION A as one block; it returns exactly 4 rows or refuses. Keep §I ROLLBACK A beside it.
5. **Close out:** run §J top to bottom. Then copy §J step 1's six verdicts, step 2's row count and step 3's count into the evidence ledger row R9 (`docs/operations/ACTIVATION-CHECKLIST.md` §6.7 — as `storage_bucket_policy_readiness(): agent-documents owner_scoped · … ; 0 bucket-wide; 11 owner policies`, dated), and flip §I's status line to `- Status: RESOLVED <date> — census 0`.
6. **The integrator** flips line 1 of m854 / m855 / m874 / m875 to `-- ── APPLIED LIVE <date> …`, lowers `NOT_APPLIED_BASELINE` by one per file, and re-runs `npm run test:release-blockers` until it prints O1 and O2 `discharged` and R9 `OBSERVED` (F6 refuses R9 observed while a stamp still says not applied — fix the stamp, never the ledger).

### Integrator re-measurement — READ-ONLY (Supabase MCP `execute_sql`, project `hrvaqgvukzxfskkcrwbt`)

```sql
-- §K Q1 (O1) can the MCP session alter storage.objects? (expect false → the owner's route B)
SELECT current_user, pg_has_role(current_user, 'supabase_storage_admin', 'member') AS can_alter_storage_objects;

-- §K Q2 (O1) the m854/m874 prerequisite functions exist (expect all non-null)
SELECT to_regprocedure('public.brokerage_forms_path_readable(text)') AS bf_readable,
       to_regprocedure('public.brokerage_forms_path_writable(text)') AS bf_writable,
       to_regprocedure('public.document_bucket_path_readable(text, text)') AS doc_readable,
       to_regprocedure('public.document_bucket_path_writable(text, text)') AS doc_writable,
       to_regprocedure('public.document_bucket_object_deletable(text, text, text, timestamp with time zone)') AS doc_deletable,
       to_regprocedure('public.storage_bucket_policy_readiness()') AS readiness;

-- §K Q3 (O1) the live verdict per bucket (cleared: agent/brokerage-forms/client/transaction owner_scoped; documents + offer-documents service_only; empty arrays)
SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness() ORDER BY bucket_id;

-- §K Q4 (O1) every policy on storage.objects, classified (bucket-wide = the predicate is only bucket_id = '<b>')
SELECT policyname, cmd, roles,
       CASE WHEN coalesce(qual,'') ~ '^\(bucket_id = ''[a-z-]+''::text\)$' OR coalesce(with_check,'') ~ '^\(bucket_id = ''[a-z-]+''::text\)$' THEN 'BUCKET-WIDE'
            WHEN policyname ~ ' owner (read|upload|update|delete)$' THEN 'owner'
            ELSE 'other' END AS class
FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY class, policyname;

-- §K Q5 (O1) the counts §J expects (cleared: bucket_wide_on_five 0, owner_policies 11, agnostic_authenticated 0)
SELECT
  count(*) FILTER (WHERE qual ~ '^\(bucket_id = ''(brokerage-forms|client-documents|offer-documents|transaction-documents|agent-documents)''::text\)$'
                      OR with_check ~ '^\(bucket_id = ''(brokerage-forms|client-documents|offer-documents|transaction-documents|agent-documents)''::text\)$') AS bucket_wide_on_five,
  count(*) FILTER (WHERE policyname ~ '^(brokerage-forms|client-documents|transaction-documents|agent-documents) owner ') AS owner_policies,
  count(*) FILTER (WHERE 'authenticated' = ANY (roles) AND coalesce(qual,'') !~ 'bucket_id' AND coalesce(with_check,'') !~ 'bucket_id') AS agnostic_authenticated
FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';

-- §K Q6 (O1) exposure today: bucket privacy and object counts (0 objects = nothing has leaked yet)
SELECT b.id, b.public, (SELECT count(*) FROM storage.objects o WHERE o.bucket_id = b.id) AS objects
FROM storage.buckets b ORDER BY b.public, b.id;

-- §K Q7 (O2) the census (4 today; 0 after remediation A) — no email selected
SELECT u.id, u.brokerage_id, u.status, u.created_at
FROM public.users u
WHERE u.user_type = 'contact' AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.contact_user_id = u.id)
ORDER BY u.id;

-- §K Q8 (O2) remediation A's drift guard, run alone (expect ok_pairs = 4; anything else → re-decide before LINK)
WITH seed_link(user_id, contact_id) AS (VALUES
  ('a0000000-0000-0000-0000-000000000013'::uuid, '50000000-0000-0000-0000-000000000001'::uuid),
  ('a0000000-0000-0000-0000-000000000014'::uuid, '50000000-0000-0000-0000-000000000002'::uuid),
  ('a0000000-0000-0000-0000-000000000015'::uuid, '50000000-0000-0000-0000-000000000003'::uuid),
  ('a0000000-0000-0000-0000-000000000016'::uuid, '50000000-0000-0000-0000-000000000004'::uuid))
SELECT count(*) AS ok_pairs
FROM seed_link l
JOIN public.users u    ON u.id = l.user_id AND u.user_type = 'contact'
JOIN public.contacts c ON c.id = l.contact_id AND c.brokerage_id = u.brokerage_id
                      AND lower(c.email) = lower(u.email) AND c.contact_user_id IS NULL
WHERE NOT EXISTS (SELECT 1 FROM public.contacts x WHERE x.contact_user_id = u.id);

-- §K Q9 (O2) has any of the four signed in, or been invited, since the 2026-11-01 inventory? (no email selected)
SELECT a.id, a.last_sign_in_at, a.banned_until,
       (SELECT count(*) FROM public.user_invitations i WHERE lower(i.email) = lower(a.email)) AS invitations
FROM auth.users a
WHERE a.id IN ('a0000000-0000-0000-0000-000000000013','a0000000-0000-0000-0000-000000000014','a0000000-0000-0000-0000-000000000015','a0000000-0000-0000-0000-000000000016')
ORDER BY a.id;
```

**Positive control for Q4/Q5:** before §F/§G are run, Q5 must read `bucket_wide_on_five ≥ 19` (the 2026-11-03 live count). Zero while Q3 still says `open` means the regex is blind — re-read Q4 raw before believing any count.

## L. Wave 150 — owner SQL and owner decisions carried by the convergence lane (150Z, 2026-11-07)

Nothing in this section has been run. Project `hrvaqgvukzxfskkcrwbt`. Each item names the lane that found it, the exact step, and the
read-only check that says it is done. None of them blocks the code that already shipped — each says what stays narrowed until it is done.

### L1. O-150C-1 — the legacy one-membership-per-tenant UNIQUE (lane 150C; SQL editor, a constraint drop)

**APPLIED 2026-11-09** by the integrator on the owner's wave-151 ruling ("L1 drop"), via Supabase MCP as
`supabase/migrations/m955-owner-sql-l1-drop-legacy-one-membership-per-tenant-unique.sql`. Pre-check: the scoped unique
`organization_members_active_scope_key` (m958) was present and the table held 0 rows. Read-back: the constraint query below
returned 0 rows; the surviving uniques are `organization_members_active_scope_key` and the primary key. The text below is history.

Until this ran, a person holds ONE `organization_members` row per tenant: an office member who is also on a team keeps only the first
grant, and the second is refused 23505 and reported by name ("O-150C-1 pending"). 0 live rows at the time of writing, so the drop is safe.
```sql
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_brokerage_id_user_id_key;
-- done when this returns 0 rows:
SELECT conname FROM pg_constraint WHERE conname = 'organization_members_brokerage_id_user_id_key';
```

### L2. The global cross-tenant UNIQUE on raw observations (lane 150EFG; SQL editor, an index drop — m961 is applied)

**APPLIED 2026-11-09** by the integrator on the owner's wave-151 ruling ("L2 drop"), via Supabase MCP as
`supabase/migrations/m956-owner-sql-l2-drop-global-cross-tenant-raw-observation-unique.sql`. The object was a CONSTRAINT, not a
bare index: the `DROP INDEX` below was refused 2BP01 ("cannot drop index … because constraint … requires it"), so the applied
statement is `ALTER TABLE public.raw_scraped_leads DROP CONSTRAINT IF EXISTS raw_scraped_leads_source_record_id_key`. Pre-check:
the scoped unique `raw_scraped_leads_idempotency_key_uniq` (m961) was present and the table held 0 rows. Read-back: constraint 0,
index 0; the surviving uniques are `raw_scraped_leads_idempotency_key_uniq` and the primary key. The text below is history.

The C35 producer keys every observation by a tenant-scoped `idempotency_key`; the old GLOBAL `(source_record_id)` UNIQUE lets one
tenant's observation refuse another's. 0 live rows depended on it.
```sql
DROP INDEX IF EXISTS public.raw_scraped_leads_source_record_id_key;
-- done when this returns 0 rows:
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'raw_scraped_leads_source_record_id_key';
```

### L3. `listing-media` storage policies for owner-uploaded listing photos (lane 150XY; Dashboard → Storage → Policies, or SQL editor as `supabase_storage_admin` — `postgres` is refused 42501, as in §F)

RESTRICTIVE policies narrow only paths whose first folder is a UUID (`<brokerageId>/<listingId>/<file>`); other prefixes and the
existing permissive policies are untouched; reads stay public (marketing media).
```sql
BEGIN;
DROP POLICY IF EXISTS "listing-media tenant listing folder insert" ON storage.objects;
DROP POLICY IF EXISTS "listing-media tenant listing folder update" ON storage.objects;
DROP POLICY IF EXISTS "listing-media tenant listing folder delete" ON storage.objects;
CREATE POLICY "listing-media tenant listing folder insert" ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR ((storage.foldername(name))[1] = public.current_user_brokerage_id()::text
        AND EXISTS (SELECT 1 FROM public.listings l
                     WHERE l.id::text = (storage.foldername(name))[2]
                       AND l.brokerage_id = public.current_user_brokerage_id()))
  );
CREATE POLICY "listing-media tenant listing folder update" ON storage.objects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (storage.foldername(name))[1] = public.current_user_brokerage_id()::text
  )
  WITH CHECK (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (storage.foldername(name))[1] = public.current_user_brokerage_id()::text
  );
CREATE POLICY "listing-media tenant listing folder delete" ON storage.objects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (storage.foldername(name))[1] = public.current_user_brokerage_id()::text
  );
COMMIT;
-- done when this lists the three RESTRICTIVE rows (plus the pre-existing permissive ones):
SELECT policyname, permissive, cmd FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
   AND (coalesce(qual,'') ILIKE '%listing-media%' OR coalesce(with_check,'') ILIKE '%listing-media%')
 ORDER BY policyname;
```

### L4. S3 — a team lead's contacts read is brokerage-wide at the database (lane 150BAA; owner decision, then SQL editor)

CLAUDE.md §4 says teams see only their own board; `contacts.team_lead_read_team_contacts` admits the whole tenant. Verify the bodies of
`current_user_led_team_id()` and `is_tenant_principal_team_lead()` first, then:
```sql
ALTER POLICY team_lead_read_team_contacts ON public.contacts
  USING ((brokerage_id = public.current_user_brokerage_id())
    AND EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.user_type = ANY (ARRAY['team_lead'::text, 'team_leader'::text]))
    AND (public.is_tenant_principal_team_lead()
         OR team_id = public.current_user_led_team_id()
         OR agent_id IN (SELECT tm.agent_id FROM public.team_members tm WHERE tm.team_id = public.current_user_led_team_id())));
-- done when, as a seeded non-principal team lead (set_config request.jwt.claims), SELECT count(*) FROM contacts falls from tenant-wide to team-only.
```

### L5. S4 — `users_same_brokerage_select` shows every tenant `users` row to contact and vendor seats (lane 150BAA; owner decision)

Decide first whether any portal page reads another `users` row through the session client (lane 150W added none). If none:
```sql
ALTER POLICY users_same_brokerage_select ON public.users
  USING (public.is_platform_staff() OR (id = auth.uid()) OR ((brokerage_id = public.current_user_brokerage_id()) AND public.is_tenant_staff_seat()));
```

### L6. Owner decisions (no SQL until ruled — nothing is built on a guess)

| # | Decision | Found by | Options / what the code does today |
|---|---|---|---|
| L6.1 | Office isolation at the DATABASE (cross-office RLS) | 150BAA / 150C | Today office scope is code-side (resolveViewerHierarchy → resolveEgressScopeForViewer; the exception center, workflow reports and office CRUD now read it). DB-enforced isolation needs an office column (or a join through the creator's `users.location_id`) on media / QR / mail / events. Rule: DB-narrowed, or code-scoped? |
| L6.2 | Closing attestation for a brokerage WITHOUT a CDA | 150XY (wave-149 §4) | (a) none (today); (b) ask `closing_verification.unrecorded_changes` of the deal agent / TC at the gated close, informational; (c) blocking for brokerages that opt in by setting. |
| L6.3 | A commissioned photographer's delivery — an "owned" upload or a third photo source? | 150XY | `app/actions/photo-management.ts processVendorPhotos` writes `listing_media` rows with `photo_source` NULL (not recorded) until ruled. |
| L6.4 | The AI split coach: may the agent see their own split on the CDA they fill? | 150XY | The coach (explains the waterfall, never proposes a number) is not built (PARTIAL); CLAUDE.md §5 keeps commission off agent-facing display — the CDA flow already shows the agent their own figures. |
| L6.5 | Do BatchData's / PeopleData's existing live doors close under R9? | 150HIAB | Yes → `PROVIDER_ACTIVATION.survivorDoors = "closed"` (lib/providers/provider-scorecard.ts). Today they stay open as dormant survivors. |
| L6.6 | A no-cost sandbox run / a bounded paid pilot (Tracerfy vs DataZapp) | 150HIAB | Not approved; the $1,000 cap is NOT approved; the 2,400-candidate pilot runs only as an offline simulation. |
| L6.7 | **Per-territory paid scraping now needs an approved acquisition plan** | 150Z (150EFG Outside-lane 2) | `app/api/cron/lead-scraping/route.ts` refuses every per-territory PAID source (Apify / Exa / ZenRows / Tavily / Zyte / non-pooled BatchData) without the tenant's approved, unexpired `acquisition_plans` line, and says so in the run's errors. Each tenant's commerce admin approves lines in Settings → Territories → Acquisition plan. Until then those lanes do not spend. Platform-pool territories (no tenant) cannot be approved by rule — decide whether a platform pull may run under a platform approval. |
| L6.8 | The 5 % movement-outreach holdout default | 150JNAD | On wherever a tenant's experiments policy is readable; per-tenant kill switch `brokerage_settings.settings.experiments.disabled ⊇ ["movement_outreach_holdout"]`. |
| L6.9 | `contacts.created_by_user_id` vs `contacts.source_agent_id` (one concept, one column exists) | 150PU | Rename / alias is the owner's call; no second column is written. |
| L6.10 | Alerts on a saved RentCast-listing or pasted-link home (price / status change) | 150W | Approval door BUILT (wave 151, lane 151J; m983 applied 2026-11-09): the saved-home watch diffs each home against its last verified state; a metered RentCast re-read runs only under a tenant-approved acquisition-plan line naming `rentcast_saved_home_recheck` and the platform caps; until a tenant has one, every re-read is HELD and recorded (`saved_home_recheck.decision.do_nothing`, `saved_properties.verification_hold`) — never a silent poll. Owner decision still open: a platform-paid door (needs RentCast in `VENDOR_RIGHTS`, lib/lead-pipeline/source-intent-map.ts). |
| L6.11 | PostcardMania / PCM quotes | 150R | Getting a quote is outreach — the owner's call. |
| L6.12 | The Meta lead-form `legal_content` verification | 150PU | The verifying UPDATE is in m978's header; it runs only after a live Lead Ads Testing Tool check confirms `custom_disclaimer.body.text`. |

## M. Wave 151 — owner decisions applied to §L, and the one piece of owner SQL that remains (lane 151B, 2026-11-09)

The owner ruled on §L items L1–L6 in the wave-151 directive (§151B). What each became:

| §L item | Owner decision | Where it went |
|---|---|---|
| L1 (`organization_members_brokerage_id_user_id_key` drop) | DROP — the integrator applies it live | **APPLIED 2026-11-09** (m955; read-back in §L L1). |
| L2 (`raw_scraped_leads_source_record_id_key` drop) | DROP — the integrator applies it live | **APPLIED 2026-11-09** (m956 — a constraint drop, the `DROP INDEX` was refused 2BP01; read-back in §L L2). |
| L3 (`listing-media` storage policies) | KEEP **only if they match the code's ownership / access contracts** | Verified below: **AMEND** — corrected SQL in M.1. Still owner SQL (storage.objects). |
| L4 (S3, team lead contacts) | Team leaders see the Contacts of the teams they lead, never brokerage-wide | A MIGRATION now, not owner SQL: `supabase/migrations/m963-team-lead-reads-contacts-of-the-teams-they-lead.sql` (the integrator applies via MCP). The §L L4 draft is superseded: it used `current_user_led_team_id()`, which is `LIMIT 1` — one team, not "the teams they lead". |
| L5 (S4, `users_same_brokerage_select`) | Contacts see only their own; vendors only their assigned work | A MIGRATION: `supabase/migrations/m964-users-rows-stay-with-staff-seats-own-row-and-the-assigned-agent.sql` — the §L L5 draft plus the lawful narrow read the portal needs (the assigned agent's row for a contact; the booking / assigning agent's row for a vendor), measured from every `.from("users")` under app/portal, app/vendor, lib/portal, lib/vendors. The vendor-side tenant-wide reads S4 also names are `m965-vendor-seats-read-only-their-assigned-work.sql`. |
| L6.3 (photographer deliveries) | An assigned photographer uploads for exactly its booked listing; review, never auto-publish | A MIGRATION: `supabase/migrations/m966-photographer-delivery-is-a-third-photo-source.sql` + code (`lib/listings/owner-photo-upload.ts recordPhotographerDelivery`, `app/actions/photo-management.ts submitPhotographerDelivery`, the vendor jobs page). |

#### L6.2 / L6.4 — closing without a CDA (lane 151K, 2026-11-09; owner: "if the brokerage doesn't use CDAs (their settings), then it can close without a CDA")

- **L6.2 — BUILT as option (b):** at the gated close of a brokerage whose settings say it does NOT use a CDA, the closing question is asked of the deal's agent / TC as an INFORMATIONAL compliance row (`is_blocking false`; the close is never held; a "yes" tells the admins exactly as today) — `lib/commission/closing-verification.ts ensureClosingAttestationAsked({ informational })`, hooked at `lib/transactions/stage-progression.ts`'s close step. The deal closes on the smallest honest proof (`lib/transactions/cda-closing-policy.ts noCdaClosingProof`: final settlement record + recorded receipt who/when + compliance status + the payout holds; funds are never asserted from a date; `CLOSED / PAYOUT PENDING`, `payoutFundsGate` and the once-only payment stay intact).
- **L6.2 option (c) — YOUR decision, not chosen:** *"Should a brokerage that does not use a CDA be able to OPT IN (a brokerage setting) to a BLOCKING closing question — the gated close refused until the agent attests that no executed change is unrecorded?"* It changes who may hold a closing (legal/financial approval authority). Code ready to take it: `ensureClosingAttestationAsked({ informational: false })` at the same hook, behind a `brokerage_settings` key.
- **L6.4 — the AI split coach and the agent's own split:** the coach (`lib/commission/cda-coach-rule.ts`, `app/actions/transactions/cda-coach.ts`) explains the waterfall and never states a figure beyond the agent's own entered CDA figures and the contract's stated terms (both already on the agent's CDA page); engine amounts never reach the model and it never writes the CDA. *"Do you accept that the coach may repeat the agent's own entered CDA figures and the contract's price / commission percentage (and nothing computed by the engine)?"* If not, the allowed set collapses to the contract terms alone (`allowedFigureSet`).
- **Addendum evidence — refuse or flag (your call later):** the recorder refuses only a verified / high-confidence extraction that contradicts the typed term; a term with no extraction and no stated page / field is recorded and flagged `person_reading_unlocated`, because the addendum door collects page / field only as of wave 151 (the integrator added the fields). *"Now that the door collects page / field, should the recorder refuse an executed addendum term with no located evidence?"*

### M.1. L3 verdict — AMEND the `listing-media` `storage.objects` policies (owner SQL; Dashboard → Storage → Policies, or SQL editor as `supabase_storage_admin` — `postgres` is refused 42501, as in §F)

**What is live today (measured 2026-11-09, `pg_policies` on `storage.objects`):** four PERMISSIVE policies — `Agents can upload listing media` (INSERT, `authenticated`, `bucket_id = 'listing-media'`), `Agents can update listing media` (UPDATE), `Agents can delete listing media` (DELETE), `Public can read listing media` (SELECT, `public`). Any signed-in seat of ANY tenant — a contact, a vendor, a stranger with an account — may PUT, overwrite or delete any object in the bucket. The bucket is `public`, 50 MB, image + video mime list.

**The code's contracts, censused (every path that writes or reads the bucket):**

1. `app/dashboard/listings/[id]/media/components/media-grid.tsx uploadFile` → a TENANT STAFF seat PUTs `<brokerageId>/<listingId>/<file>` with the browser session, then `app/actions/listing-media.ts uploadListingMedia` → `lib/listings/owner-photo-upload.ts recordOwnerUploadedListingPhoto` records the row (refuses a URL outside `listing-media/<tenant>/<listing>/`; m993 attestation). `listing_media_tenant_insert` admits `is_tenant_staff_seat()` only, so a contact or vendor seat can never RECORD such a file — but the storage policy still lets them WRITE it.
2. **NEW (wave 151, L6.3):** `app/vendor/jobs/jobs-client.tsx` → the ASSIGNED PHOTOGRAPHER (a `vendor` seat whose `vendors.category = 'photographer'` holds a `vendor_bookings` row for the listing, status `confirmed` / `completed`, approval not pending / declined) PUTs into exactly `<brokerageId>/<listingId>/` of its booking, then `app/actions/photo-management.ts submitPhotographerDelivery` records it for review.
3. Deletes / overwrites: `app/actions/listing-media.ts deleteListingMedia` and the Media Manager act on ROWS through the staff seat; no vendor or contact path overwrites or deletes an object.
4. Reads: public (the listing page, portals, producers read public URLs) — unchanged.
5. Other prefixes (`stock-clips/…`, `video-backgrounds/…`, rendered videos) are written by server routes with the service role; untouched.

**Why §L L3 as written does NOT match:** its RESTRICTIVE INSERT admits `(storage.foldername(name))[1] = current_user_brokerage_id()::text` for EVERY authenticated seat of the tenant — a contact seat and ANY vendor seat (the stager, a vendor assigned to a different listing) may write into ANY listing folder of the tenant, which is wider than contract 1 (staff) and contract 2 (the photographer's ONE booked listing). Its UPDATE / DELETE arms admit every tenant seat to overwrite or delete any listing object (no code path needs that for a non-staff seat). So: AMEND. The corrected policies below keep §L's shape (RESTRICTIVE, UUID-first-folder paths only, other prefixes untouched, reads public) and add the seat rule.

```sql
BEGIN;
DROP POLICY IF EXISTS "listing-media tenant listing folder insert" ON storage.objects;
DROP POLICY IF EXISTS "listing-media tenant listing folder update" ON storage.objects;
DROP POLICY IF EXISTS "listing-media tenant listing folder delete" ON storage.objects;

-- INSERT: a tenant STAFF seat into any listing folder of its tenant; an ASSIGNED PHOTOGRAPHER vendor seat into exactly the
-- folder of the listing its deliverable booking names (the same rule lib/listings/owner-photo-upload.ts recordPhotographerDelivery
-- applies to the row). Paths whose first folder is not a UUID (stock-clips, video-backgrounds, renders) are not touched.
CREATE POLICY "listing-media tenant listing folder insert" ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (
      (storage.foldername(name))[1] = public.current_user_brokerage_id()::text
      AND EXISTS (SELECT 1 FROM public.listings l
                   WHERE l.id::text = (storage.foldername(name))[2]
                     AND l.brokerage_id = public.current_user_brokerage_id())
      AND (
        public.is_tenant_staff_seat()
        OR EXISTS (
          SELECT 1
            FROM public.vendor_bookings vb
            JOIN public.vendors v ON v.id = vb.vendor_id
            JOIN public.user_role_assignments ura ON ura.vendor_id = vb.vendor_id
           WHERE ura.user_id = auth.uid()
             AND vb.brokerage_id = public.current_user_brokerage_id()
             AND vb.listing_id::text = (storage.foldername(name))[2]
             AND vb.status IN ('confirmed', 'completed')
             AND (vb.approval_status IS NULL OR vb.approval_status IN ('approved', 'auto_approved'))
             AND v.category = 'photographer'
        )
      )
    )
  );

-- UPDATE / DELETE: tenant STAFF seats, inside their own tenant's listing folders. No non-staff path overwrites or deletes.
CREATE POLICY "listing-media tenant listing folder update" ON storage.objects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR ((storage.foldername(name))[1] = public.current_user_brokerage_id()::text AND public.is_tenant_staff_seat())
  )
  WITH CHECK (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR ((storage.foldername(name))[1] = public.current_user_brokerage_id()::text AND public.is_tenant_staff_seat())
  );

CREATE POLICY "listing-media tenant listing folder delete" ON storage.objects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    bucket_id <> 'listing-media'
    OR (storage.foldername(name))[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR ((storage.foldername(name))[1] = public.current_user_brokerage_id()::text AND public.is_tenant_staff_seat())
  );
COMMIT;
```

Pre-check and verification (read-only) — §L L3's queries still apply; add:
```sql
-- the helpers the policy names exist
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND proname IN ('current_user_brokerage_id', 'is_tenant_staff_seat');
-- done when this lists the three RESTRICTIVE rows (plus the four pre-existing permissive ones):
SELECT policyname, permissive, cmd FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
   AND (coalesce(qual,'') ILIKE '%listing-media%' OR coalesce(with_check,'') ILIKE '%listing-media%')
 ORDER BY policyname;
```
Negative tests (owner, in a browser session): a tenant-A agent → `listing-media/<tenant-B id>/<tenant-B listing>/x.jpg` → 403; the same agent → its own listing folder → 200; a tenant-A CONTACT seat → any listing folder → 403; a tenant-A photographer vendor with a `confirmed` booking for listing L → `listing-media/<A>/<L>/x.jpg` → 200, and → another listing's folder → 403; the same vendor with only a `booked` (unaccepted) booking → 403; a stager vendor → 403.

**Ordering:** apply m963–m966 (integrator, MCP) in any order; this owner SQL is independent of them. Until it is applied, the photographer's upload still SUCCEEDS at storage under the live permissive policy (as does anyone's), and only the RECORD is gated — the release-gate reading "overbroad storage access BLOCKED" stays true until the three RESTRICTIVE rows exist.

## After you run anything on this page

1. In the repository (or ask the integrator): flip the file's first-line status from `WRITTEN, NOT APPLIED` to `APPLIED <date>` and lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts` by one per file applied.
2. Regenerate the schema caches — never hand-edit them: `npm run schema:regen` (snapshot, FK map, agent FK, vocabularies). After a dropped column the cached `global_settings` column list must lose `airtable_api_key`.
3. `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` must be green before anything else is pushed.
