# Spelling migration plan — the British "licence" family in identifiers and database vocabulary

Written by wave 151, lane 151L (2026-11-10), under the owner's rule **American English — LICENSE, never licence**.

This document is a PLAN. It renames nothing. It records exactly which database-facing names and code
identifiers still carry the British spelling after lane 151L Americanized every comment, prose string,
JSX text node and hand-written Markdown line, and it states the migration that would retire them with a
compatibility window. Every `DROP COLUMN` in it is owner SQL (CLAUDE.md §3: files are not the database).

## 1. What lane 151L changed now, and what it proved

| Pass | What was rewritten | How the position was classified | Files |
|---|---|---|---|
| Round 1 | comments, prose string literals (any literal containing whitespace), hand-written Markdown | `blankComments` for comments; `stringLiterals` for literals | 141 |
| Round 2 | JSX text nodes (`<Label>Licence number</Label>`) | `ts.isJsxText` from the TypeScript parser | 12 |
| Regenerated | `OPEN-LOOP-LEDGER.md`, `ENVIRONMENT-INVENTORY.md`, `PROVIDER-CERTIFICATION.md`, `PRODUCTION-ARCHITECTURE.md [hosting-facts]` | their own generators (`open-loop-ledger.ts --write`, `operations-docs-guard.ts --write`) | 4 |

Not rewritten, by rule: any literal with no whitespace (a vocabulary word, a column name, a reason code),
any identifier, any `.sql` file, any `.json` file, the generated caches (`schema-snapshot.ts`,
`check-vocabularies.ts`, `live-tables.ts`, `schema-fk-map.ts`), and the planted positive controls of the
guards that hunt the British spelling (`scripts/legal-packets-guard.ts` section D and its P4 specimen —
that file was restored to HEAD after round 1 touched it, because its strings ARE the defect it hunts).

Round 1 taught one lesson worth recording: `stringLiterals` reports a template literal as ONE span that
includes its `${…}` interpolations, so five interpolated identifiers (`src.licence.terms` ×2,
`rights.licence` ×2, `disclosurePlainText(licence)`) were rewritten and broke at runtime
(`ReferenceError: license is not defined` in `test:video-timeline-integrity`). The fix is the one
CLAUDE.md §2 already names: decide "inside a string" from `blankStrings`, whose interpolation interiors
stay code. The proof that the two passes changed NO code is a stripped-source comparison of every changed
TS file against HEAD (comments, string contents and JSX text blanked on both sides): 147 changed source
files — 131 prose-only, 16 intended lane edits, 0 unintended drift.

## 2. Database-facing carriers (the live schema, read from the generated caches)

Read from `scripts/schema-snapshot.ts` (generated 2026-11-09 after m986), `scripts/check-vocabularies.ts`,
`scripts/live-tables.ts` and `scripts/schema-fk-map.ts`:

| Carrier | Table.column | Type | Defined by | Written by | Read by |
|---|---|---|---|---|---|
| column | `market_dataset_verifications.licence` | `jsonb` (`{ class, text }` — `DatasetLicence`) | `supabase/migrations/m918-market-dataset-verifications-c19.sql:36` (APPLIED) | `lib/intent/dataset-verification.ts:267` (`licence: c.licence` in the upsert row) | `lib/intent/dataset-verification.ts:105–109` (`statusOf` — an unread license is a reason the dataset is not usable), `app/actions/movement-signals.ts:57` → `app/dashboard/intelligence/movement-signals/movement-signals-client.tsx:50,128` (`v.licence`) |
| column | `raw_scraped_leads.source_licence` | `text` — the NAME of the governing terms | `supabase/migrations/m961-rawdata-producer-contract-c35.sql:33` (APPLIED) | `lib/lead-pipeline/raw-record-types.ts:296` (`source_licence: ctx.rights.licence`) → `lib/kernel/scraping.ts:172,180` (column list + insert mapping) | no production reader — it is evidence on the row; `scripts/rawdata-ingress-guard.ts:83` asserts it is set |
| jsonb KEY (added wave 152, lane 152K — the 151L census read columns only) | `marketing_assets.rights` → key `licence` (and the legacy pre-m719 shape `marketing_assets.metadata.media.rights.licence`) | key inside `jsonb` | `lib/kernel/media-intelligence.ts:86` `MediaRights.licence` | the media-intelligence writer (rights object as given) | `lib/kernel/media-intelligence.ts:167–168` `rightsVerdict` (a stock / external asset needs it) |
| CHECK value | — | — | — | — | **none**: no `CHECK_VOCABULARIES` value, no `live-tables` entry and no FK-map entry carries the spelling |
| migration filename | `m459-a-licence-record-anyone-in-the-tenant-can-rewrite-is-not-a-compliance-record.sql` | — | history | — | filenames are immutable history; never renamed |

Every other `licen…` column in the live schema is already American (`license_number`, `license_state`,
`license_expires_at`, `license_note`, `license_id`, `license_status`, `license_type`, `license_expiry`,
`buyer_agent_license`, `license`, `license_attribution`, `license_url`).

## 3. Code identifiers that carry the spelling (not database-facing, not renamed now)

These are the names the compiler sees. Renaming any of them is a code refactor that the proofs below must
re-certify; none of them is a storable value, so none needs a migration.

| Identifier | Where | Guards that drive it |
|---|---|---|
| `SourceRights.licence` / `rights: { rights, licence }` | `lib/lead-pipeline/raw-record-types.ts:272`, `lib/lead-pipeline/source-discovery-planner.ts:463,482` | `test:rawdata-ingress`, `test:acquisition-door`, `test:provider-waterfall` |
| `MovementLicence`, registry rows `licence:` (47) | `lib/intent/movement-source-registry.ts` | `test:movement-signals`, `test:wave148-canaries` |
| `src.licence.collection` / `.terms` (10) | `lib/intent/movement-signals.ts:210–212` | `test:movement-signals` |
| `DatasetLicence`, `licence` field (9 + 15) | `lib/intent/dataset-verification.ts`, `lib/external/socrata-market-registry.ts` | `test:movement-signals`, `test:readiness-dimensions` |
| `source-intent-map` rows `licence:` (11) | `lib/lead-pipeline/source-intent-map.ts` | `test:identity-dedup`, `test:readiness-dimensions` |
| reason codes `licence_missing`, `licence_expired`, `per_state_licence_verification_is_a_real_cost`; fields `licenceRequired`, `licenceIsCurrent` | `lib/vendors/vendor-service-area.ts:301–302,436–437,472,520` | `test:vendor-service-area`, `test:appraiser-bench` — these codes are returned to the UI, never stored |
| `music_licence` (staging asset key) | `lib/video/video-staging.ts:240,243` | `test:video-timeline-integrity`, `test:media-intelligence` |
| `unbreakableLicence` | `lib/video/cinema-finish.ts` | `test:video-timeline-integrity` |
| `licence_handoff`, `spouse_licence` (PCS task keys) | `lib/relocation/pcs-planner.ts:131–132` | `test:readiness-dimensions` (row 61 of the convergence table) |
| `licence` on media rights | `lib/kernel/media-intelligence.ts`, `lib/kernel/ai-sentinel.ts`, `lib/offers/outside-agent-record.ts` | `test:media-intelligence`, `test:inbound-offer-lane` |
| UI state `licenceNo`, `licenceExpiry`, `setLicenceNo`, `setLicenceExpiry`, helper `licenced()` | `app/portal/vendor/vendor-coverage-panel.tsx` | `test:vendor-service-area` |
| DOM ids `form-licence`, `form-licence-exp` | `app/dashboard/admin/transaction-forms/transaction-forms-client.tsx:436–441` (`id` + `htmlFor` pairs) | `test:legal-packets` (form packets) |
| `licenceState` | `app/actions/settings/brokerage-identity.ts` | `test:hidden-wires`, `test:use-server-exports` |
| `transaction-forms-client` field `licence` (4) | `app/dashboard/admin/transaction-forms/transaction-forms-client.tsx` | `test:legal-packets` |

## 4. The migration that retires the two columns — with a compatibility window

Ordering follows the orphan doctrine: extend first, move the readers, then delete with a tombstone.
Nothing below is written as a `.sql` file yet; writing it is a lane's job, applying it is the integrator's,
and the two `DROP COLUMN`s are owner SQL.

### Step 1 — additive migration (lane-written, integrator-applied)

```sql
-- mNNN-american-spelling-columns-open-the-window.sql   (plan only — not written, not applied)
ALTER TABLE public.market_dataset_verifications ADD COLUMN IF NOT EXISTS license jsonb;
ALTER TABLE public.raw_scraped_leads            ADD COLUMN IF NOT EXISTS source_license text;

UPDATE public.market_dataset_verifications SET license = licence
 WHERE license IS NULL AND licence IS NOT NULL;
UPDATE public.raw_scraped_leads SET source_license = source_licence
 WHERE source_license IS NULL AND source_licence IS NOT NULL;

-- the window: whichever spelling a writer uses, the other column follows it
CREATE OR REPLACE FUNCTION public.mirror_license_spelling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'market_dataset_verifications' THEN
    IF NEW.license IS NULL THEN NEW.license := NEW.licence; END IF;
    IF NEW.licence IS NULL THEN NEW.licence := NEW.license; END IF;
  ELSE
    IF NEW.source_license IS NULL THEN NEW.source_license := NEW.source_licence; END IF;
    IF NEW.source_licence IS NULL THEN NEW.source_licence := NEW.source_license; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mirror_license_spelling BEFORE INSERT OR UPDATE ON public.market_dataset_verifications
  FOR EACH ROW EXECUTE FUNCTION public.mirror_license_spelling();
CREATE TRIGGER mirror_license_spelling BEFORE INSERT OR UPDATE ON public.raw_scraped_leads
  FOR EACH ROW EXECUTE FUNCTION public.mirror_license_spelling();
```

After it is applied: regenerate `scripts/schema-snapshot.ts` (both spellings must appear), and
`test:check-vocabulary` stays untouched (no CHECK is involved).

### Step 2 — code moves to the American column (same wave, after step 1 is applied)

1. `lib/lead-pipeline/raw-record-types.ts:296` writes `source_license` (and keeps writing
   `source_licence` for the window — or relies on the trigger; the trigger is the survivor so the code
   writes ONE name). `lib/kernel/scraping.ts:172,180` carries the new column name.
2. `lib/intent/dataset-verification.ts:267` writes `license`; `:73,105–109,126,143` rename the field;
   `app/actions/movement-signals.ts:57` and the movement-signals client read `license`.
3. `SourceRights.licence` → `license`, `MovementLicence` → `MovementLicense`, the 47 registry rows, the
   11 source-intent-map rows, the vendor-service-area reason codes (UI-returned, never stored), the PCS
   task keys, the video staging key, the vendor portal state names and the two DOM-id pairs — one rename
   each, with every proof in §3 re-run. `scripts/rawdata-ingress-guard.ts:83` reads the new column.
4. Regenerate the generated docs (`open-loop-ledger.ts --write`, `operations-docs-guard.ts --write`,
   `ui-capability-surface-audit.ts --write-doc` if a portal row moved).

### Step 3 — close the window (OWNER SQL — never a lane, never the integrator on a lane's word)

```sql
-- OWNER-SQL §(next) — run only after step 2 is deployed and one full acquisition cycle has written
-- source_license, and after a read-back shows no row where the two spellings disagree:
SELECT count(*) FROM public.market_dataset_verifications WHERE license IS DISTINCT FROM licence;   -- expect 0
SELECT count(*) FROM public.raw_scraped_leads WHERE source_license IS DISTINCT FROM source_licence; -- expect 0
DROP TRIGGER mirror_license_spelling ON public.market_dataset_verifications;
DROP TRIGGER mirror_license_spelling ON public.raw_scraped_leads;
DROP FUNCTION public.mirror_license_spelling();
ALTER TABLE public.market_dataset_verifications DROP COLUMN licence;
ALTER TABLE public.raw_scraped_leads            DROP COLUMN source_licence;
```

Then regenerate `schema-snapshot.ts` again and add the two dropped names to the retired-table/column
checks the way m955/m956 were recorded (`scripts/release-blockers-guard.ts` C′ derives an obligation
from the applied stamps; this one would be derived the same way, never pinned to a count).

## 5. What must NOT happen

- No `ALTER … RENAME COLUMN` in one step: a deploy that renames under a running writer loses every row
  written between the migration and the deploy (PGRST204 refuses the whole insert, not part of it).
- No hand edit of a generated cache or a generated doc to make a guard go green.
- No rewrite of a guard's positive control: the finder that proves it still recognises the British
  spelling must keep its specimen (`scripts/legal-packets-guard.ts` P4).
- No rename of the m459 migration filename.

## 6. `rights.licence` — the compatibility strategy (wave 152, lane 152K; renames NOTHING this wave)

The directive (152K): *"explicitly inspect the existing `rights.licence` legacy field/vocabulary and document a safe compatibility
strategy; avoid breaking provider rights records or conflating language cleanup with licensing logic."* No DB-facing name changes
in wave 152 — this section is the plan the lane that executes it follows.

### 6.1 What `licence` means here — three DATA-RIGHTS carriers, and one thing it is not

| Carrier | Meaning | Is it an input to licensing logic? | Stored rows (live, read-only, 2026-11-12) |
|---|---|---|---|
| `SourceRights.licence` (`lib/lead-pipeline/raw-record-types.ts:272`) → `raw_scraped_leads.source_licence` (written at `:296`, column list `lib/kernel/scraping.ts:172,180`) | the NAME of the terms that govern a data source — evidence on the row | **no** — nothing branches on it; `source-discovery-planner.ts:506,525` only prints it in a door's reason | 0 of 0 raw rows |
| `market_dataset_verifications.licence` (jsonb `{ class, text, readOn }`, `lib/intent/dataset-verification.ts`) | a public dataset's license CLASS | **yes** — `statusOf` (`dataset-verification.ts:109`) refuses a dataset whose class is missing / `unknown`; the decision reads the `class` VALUE, never the key's spelling | 0 rows |
| `marketing_assets.rights.licence` (jsonb key; `MediaRights.licence`) | the license of a stock / externally sourced media asset | **yes** — `rightsVerdict` (`media-intelligence.ts:167–168`) refuses a stock / external asset without it | 0 of 0 asset rows |
| NOT a data-rights carrier: professional licensing — `license_number`, `license_state`, … (already American) and the vendor-service-area reason codes `licence_missing` / `licence_expired` (`lib/vendors/vendor-service-area.ts`, returned to the UI, never stored) | a PERSON's / vendor's professional license | a different domain entirely | — |

The rule this plan keeps: **the spelling of a key is never a licensing decision.** Every value a license gate reads — the
`class` vocabulary (`public_domain`, `portal_terms`, `unknown`, …), the presence of a stock asset's license, a source's rights
basis — is carried across the rename unchanged, and no gate may read "the key is missing" as "the right is missing" while both
spellings can exist.

### 6.2 Read both, write one, a window, a rollback — per carrier

1. **ONE accessor per carrier, reading BOTH spellings** (written first, in the module that owns the type, before any writer
   changes): `sourceLicenseOf(rights) = rights.license ?? rights.licence ?? null` beside `SourceRights`; the dataset reader takes
   `row.license ?? row.licence`; `mediaLicenseOf(rights) = rights.license ?? rights.licence ?? null` beside `MediaRights`, and
   `rightsVerdict` calls it (so a stock asset stored under either key passes, and one stored under neither still refuses). Every
   reader in §3 moves onto its accessor; a census (stripped source) then finds no direct `.licence` read outside the accessors.
2. **WRITE ONE (American)** — only after the database accepts it: the two COLUMNS need §4 step 1 applied first (the additive
   columns + the mirror trigger keep both spellings filled whichever one a writer uses, so a writer deployed before or after the
   migration never loses a row — PGRST204 refuses a whole insert that names an absent column). The jsonb KEY needs no DDL: the
   writer writes `license`; old rows keep `licence` and the accessor reads them.
3. **THE WINDOW** opens when step 1's migration is applied and closes only when all of: step 2 is deployed; one full acquisition
   cycle has written `source_license`; the §4 step-3 disagreement read-backs return 0; and a backfill of the jsonb key
   (`UPDATE public.marketing_assets SET rights = (rights - 'licence') || jsonb_build_object('license', rights -> 'licence') WHERE rights ? 'licence' AND NOT rights ? 'license';`
   — a no-op on today's 0 rows; an ordinary data migration, not owner SQL) leaves `SELECT count(*) FROM public.marketing_assets WHERE rights ? 'licence'` at 0.
4. **CLOSE** — §4 step 3 (owner SQL: drop the trigger, the function and the two old columns), then delete the accessors' old-key arm
   with a tombstone naming the American key as the survivor.
5. **ROLLBACK** — inside the window: redeploy the previous code (it writes the old names; the trigger keeps the new columns in step
   and the accessors still read both) — nothing is dropped. After step 3: `ADD COLUMN` the old name back, backfill it from the new
   one, re-create the mirror trigger, then redeploy — the data never left the new column.

### 6.3 What proves it when it runs (no guard pinned to a waypoint)

`test:rawdata-ingress` (`source_license` set on every raw row), `test:movement-signals` + `test:readiness-dimensions` (the dataset
class still gates — an `unknown` class still refuses, under either key), `test:media-intelligence` (a stock asset under `licence`,
under `license`, and under neither — pass / pass / refuse: the positive control), `test:acquisition-door` / `test:provider-waterfall`
(door reasons still name the terms), plus a spelling-window census that asserts the RULE — every reader goes through an accessor,
every writer writes one name — with a planted direct `.licence` read as its positive control.

## 7. Blind spots of the census behind this plan

- The census regex is `\b(licen)(c)(e|ed|es|ing|ure)\b`, case-insensitive: it does not see `licencee`
  or a hyphenated `licence-holder` (none were found by a wider `licenc` grep: the §3 table is from that grep).
- "Prose string" means "a literal containing whitespace": a one-word UI label held in a string literal
  (`"Licence"` alone) would have been kept as a token. The round-2 JSX pass covered the labels that are
  JSX text; a one-word quoted label would still read British. The repo-wide grep after both passes found
  none in `app/`.
- `.json` files were classified and left alone (0 hits after the passes).
- (wave 152, 152K) The 151L census read COLUMNS, not keys inside `jsonb`: `marketing_assets.rights.licence` was missing
  from §2 and is added there. Other stored jsonb keys spelled the British way would be missed the same way — a key census
  over every `jsonb` writer's object literal is the step-1 lane's first task.
