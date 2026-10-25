# Owner SQL — the statements only the owner runs (wave 143, lane 143H)

Three migration files are held back from the integrator on purpose, and one more is waiting on an owner decision. This page is the exact script for each, **verbatim from the migration file** (the guard `scripts/operations-docs-guard.ts` fails if any statement here differs from its file), with the check to run *before*, the check to run *after*, and what to do in the repository afterwards.

**Nothing on this page has been run.** Project `hrvaqgvukzxfskkcrwbt`. Where: Supabase dashboard → SQL Editor, signed in as the project owner.

## Why these are yours

The Supabase MCP the integrator works through **holds destructive DDL for the owner's confirmation** (`DROP INDEX`, `DROP COLUMN`; `docs/architecture/PRODUCTION-ARCHITECTURE.md` §9 "Migration application"). The integrator's session cannot give that confirmation — the m739 attempt timed out three times with no lock held (2026-10-07). Each statement below is idempotent (`IF EXISTS`), so a re-run is harmless.

## Order and safety

1. Run **A** and **B** in any order; they touch nothing else. **C** is a decision, not a chore (read its box first). **D** is already applied — it is here so the next person does not re-run it.
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

## F. m853 — the `brokerage-forms` storage policies (SQL editor; the MCP role is not the owner of storage.objects)

**Why this is yours:** `storage.objects` is owned by the storage admin role, and the integration role that applied the rest of
m853 through the Supabase MCP was refused with `42501: must be owner of table objects`. Everything else in m853 is live
(the `brokerage_form_library` columns, CHECKs, indexes, trigger, the two path functions and its four table policies).

**What it fixes (P1, security):** today the four live policies on the `brokerage-forms` bucket admit EVERY signed-in user to
read, overwrite and delete ANY object — other tenants' form masters and filled offers included. This block replaces them
with per-folder ownership (`brokerage/{brokerage_id}/…`, `teams/{team_id}/…`, `agents/{user_id}/…`, `filled/{offer}/…`)
through `public.brokerage_forms_path_readable` / `_writable`, which are already live. Run it as-is in the SQL editor
(the `DROP POLICY IF EXISTS` lines are the point: the open policies must go). Safe to re-run.

```sql
DROP POLICY IF EXISTS "auth read brokerage-forms"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth update brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth delete brokerage-forms" ON storage.objects;

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

-- ── 4. m807 is the platform CATALOGUE now (comment only — no row touched) ───────────────────────────────────────────────────
```

**Verify afterwards:**
```sql
SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname ILIKE '%brokerage-forms%' ORDER BY policyname;
-- expect exactly: "brokerage-forms owner delete" DELETE · "brokerage-forms owner read" SELECT · "brokerage-forms owner update" UPDATE · "brokerage-forms owner upload" INSERT
```

## After you run anything on this page

1. In the repository (or ask the integrator): flip the file's first-line status from `WRITTEN, NOT APPLIED` to `APPLIED <date>` and lower `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts` by one per file applied.
2. Regenerate the schema caches — never hand-edit them: `npm run schema:regen` (snapshot, FK map, agent FK, vocabularies). After a dropped column the cached `global_settings` column list must lose `airtable_api_key`.
3. `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` must be green before anything else is pushed.
