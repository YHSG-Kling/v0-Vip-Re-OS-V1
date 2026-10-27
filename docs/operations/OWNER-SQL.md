# Owner SQL — the statements only the owner runs (wave 143, lane 143H)

Three migration files are held back from the integrator on purpose, and one more is waiting on an owner decision. This page is the exact script for each, **verbatim from the migration file** (the guard `scripts/operations-docs-guard.ts` fails if any statement here differs from its file), with the check to run *before*, the check to run *after*, and what to do in the repository afterwards.

**Nothing on this page has been run.** Project `hrvaqgvukzxfskkcrwbt`. Where: Supabase dashboard → SQL Editor, signed in as the project owner.

## Why these are yours

The Supabase MCP the integrator works through **holds destructive DDL for the owner's confirmation** (`DROP INDEX`, `DROP COLUMN`; `docs/architecture/PRODUCTION-ARCHITECTURE.md` §9 "Migration application"). The integrator's session cannot give that confirmation — the m739 attempt timed out three times with no lock held (2026-10-07). Each statement below is idempotent (`IF EXISTS`), so a re-run is harmless.

## Order and safety

1. Run **A** and **B** in any order; they touch nothing else. **C** is a decision, not a chore (read its box first). **D** is already applied — it is here so the next person does not re-run it. **F** is RELEASE-BLOCKING (owner ruling 23, wave 145): the integrator applies m854 first, then you apply m855 and run its verification.
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

**Status (measured 2026-10-27, project `hrvaqgvukzxfskkcrwbt`): STILL OPEN.** The four live policies on `storage.objects` for this bucket are `"auth read / upload / update / delete brokerage-forms"`, each `bucket_id = 'brokerage-forms'` and nothing else, `TO authenticated`: every signed-in user — a portal **contact** or a **vendor** seat of any tenant included — can read, overwrite and delete every object (every tenant's licensed packet masters and every filled offer: a buyer's name, price and terms). The bucket is private and holds 0 objects today, which is the only reason nothing has leaked.

**Wave 144's block (m853) must NOT be run as it was written.** Its path functions admit every `users` row of the brokerage, and contacts and vendors carry `brokerage_id` (4 + 4 live). Measured with a contact's JWT claims: the live `public.brokerage_forms_path_readable('brokerage/<their brokerage>/x.pdf')` returns **true**. m854 replaces those functions; m855 is the policy block below.

**Why this is yours.** `storage.objects` is owned by `supabase_storage_admin`. The integration session runs as `postgres`, which is neither that owner, nor a member of it, nor a superuser (measured), so `CREATE / DROP POLICY ON storage.objects` is refused `42501: must be owner of table objects`. The dashboard SQL editor runs as `postgres` by default, so it may be refused the same way. Use route A, and fall back to route B if A is refused.

### Order

1. The **integrator** applies `supabase/migrations/m854-brokerage-forms-seat-scoped-path-rules.sql` through the MCP. It is public schema only: four functions, the library `SELECT` policy, and a `pdf_url` clean-up of 0 rows.
2. **You** apply m855 (route A or B).
3. Run the verification below and read every expected value.

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

## After you run anything on this page

1. In the repository (or ask the integrator): flip the file's first-line status from `WRITTEN, NOT APPLIED` to `APPLIED <date>` and lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts` by one per file applied.
2. Regenerate the schema caches — never hand-edit them: `npm run schema:regen` (snapshot, FK map, agent FK, vocabularies). After a dropped column the cached `global_settings` column list must lose `airtable_api_key`.
3. `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` must be green before anything else is pushed.
