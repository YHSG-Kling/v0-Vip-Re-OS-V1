#!/usr/bin/env tsx
/**
 * scripts/rls-anon-tenant-escape-guard.ts  (tsx scripts/rls-anon-tenant-escape-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1,025 POLICIES ACROSS 320 TABLES LET `anon` READ, WRITE AND DELETE UNTENANTED
 * ROWS — BECAUSE NOBODY WROTE A `TO` CLAUSE.
 *
 * Migrations 029 and 030 added `brokerage_id` to a large slice of the schema and
 * installed the tenant policy in this shape:
 *
 *     CREATE POLICY "<t>_tenant" ON public.<t> FOR ALL
 *       USING      (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
 *       WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());
 *
 *   · The `brokerage_id IS NULL` branch was written as a grandfather clause for
 *     rows believed not to exist ("all target tables were empty or near-empty at
 *     apply time" — 029's own header). It is not a grandfather clause. It is a
 *     standing rule that any row WITHOUT a tenant belongs to everyone.
 *   · And there is no `TO` clause, so "everyone" is Postgres PUBLIC — which
 *     includes **`anon`**, the key that ships in the browser bundle.
 *
 * Measured live, then EXECUTED as `anon` inside a transaction that was rolled
 * back and verified rolled back: SELECT 270 rows, UPDATE 125, DELETE 3, INSERT 1.
 * 523 of the 1,025 carry the escape in WITH CHECK, so an anonymous caller can
 * *manufacture* untenanted rows, each then readable and deletable by everyone
 * under the same policy. See docs/wave20-audit.md § W20-1.
 *
 * SECOND, INDEPENDENT ANONYMOUS PATH ONTO THE SAME TABLES: 74 policies are
 * `FOR INSERT WITH CHECK (true)` granted to PUBLIC, and 16 of them sit on tables
 * that ALSO carry the escape — tables that have declared themselves tenant-scoped
 * and simultaneously accept anonymous writes. Two of the sixteen name the
 * principal they fail to grant anything to (`"System can insert insights"`,
 * `"Service role can insert vendor usage"`); `service_role` holds BYPASSRLS and
 * never needed a policy, so those exist only as an anon grant.
 *
 * m394 narrows both sets with `ALTER POLICY … TO authenticated` — a STRICT
 * narrowing, expressions untouched, the only thing removed is `anon`. m395
 * asserts it (separate file: a `raise` rolls back its own transaction, so
 * asserting inside m394 would undo the narrowings it just made).
 *
 * ── WHAT THIS GUARD STANDS OVER: THE SOURCE SIDE ─────────────────────────────
 *
 * m394/m395 fix and hold the DATABASE. They cannot stop a 321st arriving in the
 * next migration by somebody copying the neighbour above it — which is exactly
 * how the 320 got there. This guard holds the SOURCE.
 *
 * THREE CORPORA, established by reading rather than assumed:
 *
 *   APPLIED   — `supabase/migrations/*.sql`. What actually reaches the database.
 *               ZERO BASELINE for new files: after m394 there is no acceptable
 *               first one. The historical migrations that installed the 320 are
 *               applied history and must NOT be edited, so they are carried as an
 *               EXPLICIT, NAMED, FROZEN allow-list plus a ratchet that may fall
 *               and never rise. Frozen counts: **43** escape statements across 16
 *               files, **78** INSERT-true statements across 12 files.
 *   LEGACY    — `scripts/*.sql`. 437 files, no runner in package.json, invoked by
 *               nothing. Ratchet only: **11** escape, **17** INSERT-true.
 *   HAND-RUN  — `supabase/rls-governance/*.sql`. 16 files applied by hand through
 *               `011-apply-all-policies.sql`, which is a psql `\i` script with no
 *               runner either. It DOES install policies (13 of the files declare
 *               them), which is why it is scanned and not assumed clean.
 *               Ratchet: **0** escape, **11** INSERT-true.
 *
 * ── THE TWO RULES ARE DELIBERATELY DIFFERENT, AND HERE IS WHY ────────────────
 *
 * ESCAPE policies are flagged when they have NO `TO` clause **or** a `TO` naming
 * `public`/`anon`. An anonymous caller reaching untenanted rows is never right,
 * however explicitly it is spelled.
 *
 * INSERT-true policies are flagged only for IMPLICITNESS — no `TO` clause, or
 * `TO public`. An explicit `TO anon` passes, because a deliberate logged-out
 * write surface is a real thing this product has (`listing_inquiries`, the public
 * inquiry form, is exactly this shape and is correct) and the defect in all 74 is
 * that nobody said who they meant. That is also why this rule is BROADER than
 * what m394 actually changes: m394 narrows only the 16 on tenant tables, because
 * touching the other 58 is an unreviewed behaviour change on live public
 * surfaces; the guard only demands that a new one name its roles, which is free.
 *
 * ── HOW THIS PROOF IS BUILT ──────────────────────────────────────────────────
 *   · Detection is STATEMENT-LEVEL, not line-level. SQL wraps freely and a
 *     `CREATE POLICY … \n FOR ALL \n USING (…)` split across three lines is one
 *     statement; a line scan misses whichever ones somebody formatted
 *     differently. Comments are stripped first, so a guard cannot be satisfied —
 *     or tripped — by prose.
 *   · It also un-splices DYNAMIC policy creation. 030 installs 44 of these
 *     through `EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL ' ||
 *     'USING (brokerage_id IS NULL …)')`, where the statement is a chain of
 *     concatenated string literals. Adjacent literals are glued before scanning,
 *     so the highest-volume shape in this codebase is the one that is hardest to
 *     hide from.
 *   · The migrations must keep keying on the CONSTRUCT. If m394 or m395 is ever
 *     rewritten to match a policy NAME, it would find whatever happens to be
 *     spelled `%_tenant` and miss every differently-named one — the original
 *     mistake (believing a policy's name over its text) in a new coat.
 *   · m394 must stay a NARROWING. Removing the `brokerage_id IS NULL` branch is
 *     the cross-tenant half, it is recorded in the audit as needing an owner
 *     ruling with three different correct resolutions, and it is asserted here so
 *     it cannot arrive as a quiet edit to a file that already exists.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into a
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre, not a control), the check is
 *     required to flip RED, and the file is restored and re-verified by sha256.
 *     Two SPECIFICITY controls run the other way — a correctly-spelled policy is
 *     patched in and the assertion is required to STAY GREEN, because a guard
 *     that flags everything proves nothing either.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, join, basename } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const APPLIED_DIR = "supabase/migrations"
const LEGACY_DIR = "scripts"
const HANDRUN_DIR = "supabase/rls-governance"

const M394 = "supabase/migrations/m394-narrow-tenant-escape-policies-to-authenticated.sql"
const M395 = "supabase/migrations/m395-assert-no-tenant-escape-granted-to-public.sql"

/**
 * FROZEN. These are the applied migrations that already carry the construct, as
 * measured. They are applied history and are not editable; every OTHER file in
 * the applied corpus is held at zero. The counts are ratchets: they may fall
 * (deliberately, as a record that the statements went away), never rise.
 */
const APPLIED_ESCAPE_FILES = [
  "029-add-brokerage-id-to-intelligence-and-orphan-tables.sql",
  "030-add-brokerage-id-to-remaining-44-tenant-tables.sql",
  "031-add-brokerage-id-to-content-ideas.sql",
  "035-raw-scraped-leads-platform-only.sql",
  "051-data-health-prohibited-phrases.sql",
  "052-emails-drips-automation.sql",
  "053-notes-photos-ai-usage.sql",
  "056-workflow-cma-video-listing-inquiries.sql",
  "057-content-agent-ops-batch.sql",
  "058-lead-temp-ai-predictions-push-queue.sql",
  "059-prospects-content-tools-disclosures.sql",
  "060-long-tail-batch.sql",
  "061-long-tail-batch-2.sql",
  "062-long-tail-batch-3.sql",
  "m098-raw-recruit-prospects.sql",
  "m179-presentation-sections.sql",
]
const APPLIED_ESCAPE_BASELINE = 43

const APPLIED_INSERT_FILES = [
  "052-emails-drips-automation.sql",
  "053-notes-photos-ai-usage.sql",
  "055-showings-seller-portal.sql",
  "056-workflow-cma-video-listing-inquiries.sql",
  "057-content-agent-ops-batch.sql",
  "058-lead-temp-ai-predictions-push-queue.sql",
  "059-prospects-content-tools-disclosures.sql",
  "060-long-tail-batch.sql",
  "061-long-tail-batch-2.sql",
  "062-long-tail-batch-3.sql",
  "063-rpcs-and-rls-fixes.sql",
  "m179-presentation-sections.sql",
]
const APPLIED_INSERT_BASELINE = 78

const LEGACY_ESCAPE_BASELINE = 11
const LEGACY_INSERT_BASELINE = 17
const HANDRUN_ESCAPE_BASELINE = 0
const HANDRUN_INSERT_BASELINE = 11

/** The one policy m394 deliberately leaves reachable by `anon`, and why. */
const NAMED_ANON_INSERT_CARVE_OUT = "tool_usage_sessions.tool_usage_sessions_insert"

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    failures.push(label)
  }
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

/** Strip `--` line comments and block comments. Prose is never evidence. */
function stripSqlComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
}

/**
 * Every `CREATE POLICY` statement in a SQL file, as a whitespace-normalised
 * slice — including the ones assembled at runtime by `EXECUTE format(…)`.
 *
 * Adjacent string literals are glued (`'… FOR ALL ' || 'USING (…)'` is ONE
 * statement) before the scan, because that is how 030 installs 44 policies and a
 * scanner that reads each literal separately sees neither half of the construct.
 * Each slice runs from `CREATE POLICY` to the first `;` or to the next
 * `CREATE POLICY`, whichever comes first — bounded, so one statement can never
 * borrow a `TO` clause from the statement after it.
 */
function policyStatements(src: string): string[] {
  const clean = stripSqlComments(src)
    .replace(/'\s*\|\|\s*'/g, "")
    .replace(/\s+/g, " ")
  const starts: number[] = []
  const re = /\bCREATE\s+POLICY\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) starts.push(m.index)

  const out: string[] = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    let end = clean.length
    const semi = clean.indexOf(";", from)
    if (semi !== -1) end = Math.min(end, semi)
    if (i + 1 < starts.length) end = Math.min(end, starts[i + 1])
    out.push(clean.slice(from, end))
  }
  return out
}

/**
 * The roles named in a statement's `TO` clause, lower-cased, or null when there
 * is no `TO` clause at all — which in Postgres means PUBLIC, which includes
 * `anon`. Postgres syntax puts `TO` before `USING` / `WITH CHECK` always.
 */
function toClauseRoles(stmt: string): string | null {
  const m = /\bTO\s+([A-Za-z_%"', ]+?)\s+(?:USING|WITH)\b/i.exec(stmt)
  return m ? m[1].toLowerCase() : null
}

/** A tenant-escape policy that `anon` can reach. */
function isAnonReachableEscape(stmt: string): boolean {
  // RESTRICTIVE policies AND together and cannot widen anything — out of scope.
  if (/\bAS\s+RESTRICTIVE\b/i.test(stmt)) return false
  if (!/\bbrokerage_id\s+IS\s+NULL\b/i.test(stmt)) return false
  const roles = toClauseRoles(stmt)
  if (roles === null) return true // no TO clause ⇒ PUBLIC ⊇ anon
  return /\b(public|anon)\b/.test(roles)
}

/** An INSERT-true policy that reaches `anon` without saying so. */
function isImplicitAnonInsert(stmt: string): boolean {
  if (/\bAS\s+RESTRICTIVE\b/i.test(stmt)) return false
  if (!/\bFOR\s+INSERT\b/i.test(stmt)) return false
  if (!/\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(stmt)) return false
  const roles = toClauseRoles(stmt)
  if (roles === null) return true // no TO clause ⇒ PUBLIC ⊇ anon
  // An explicit `TO anon` is the honest spelling of a deliberate logged-out
  // surface. `TO public` is the same silence with extra words.
  return /\bpublic\b/.test(roles)
}

function sqlFiles(dir: string): string[] {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f))
}

interface Tally {
  total: number
  perFile: Map<string, number>
}
function tally(dir: string, match: (s: string) => boolean): Tally {
  const perFile = new Map<string, number>()
  let total = 0
  for (const f of sqlFiles(dir)) {
    const n = policyStatements(raw(f)).filter(match).length
    if (n > 0) {
      perFile.set(basename(f), n)
      total += n
    }
  }
  return { total, perFile }
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 / A3 — nothing outside the frozen allow-list, in the corpus that applies
// ─────────────────────────────────────────────────────────────────────────────
function assertAppliedOutsideAllowList(
  label: string,
  match: (s: string) => boolean,
  frozen: string[],
): boolean {
  const { perFile } = tally(APPLIED_DIR, match)
  const strangers = [...perFile.entries()]
    .filter(([f]) => !frozen.includes(f))
    .map(([f, n]) => `${f} (${n})`)
  return check(label, strangers.length === 0, strangers.length === 0 ? "" : strangers.join(", "))
}

// ─────────────────────────────────────────────────────────────────────────────
// A2 / A4 / A5–A8 — the ratchets: may fall, never rise
// ─────────────────────────────────────────────────────────────────────────────
function assertRatchet(
  label: string,
  dir: string,
  match: (s: string) => boolean,
  baseline: number,
  constantName: string,
): boolean {
  const { total } = tally(dir, match)
  const ok = check(
    `${label} ${total} <= baseline ${baseline}`,
    total <= baseline,
    total <= baseline ? "" : `grew by ${total - baseline}`,
  )
  if (total < baseline) {
    console.log(
      `    ↓ count fell to ${total}. Lower ${constantName} to ${total} in this file — deliberately, as a record that they went away.`,
    )
  }
  return ok
}

// ─────────────────────────────────────────────────────────────────────────────
// A9 / A10 — the migrations key on the CONSTRUCT, never on a policy name
// ─────────────────────────────────────────────────────────────────────────────
function assertKeysOnConstruct(path: string, label: string): boolean {
  if (!existsSync(resolve(ROOT, path))) return check(label, false, `${path} is missing`)
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")

  // The facts that MAKE it the defect. All must appear in the selection, or the
  // migration is matching on something weaker than the thing.
  const toPublic = /0\s*=\s*any\s*\(\s*p\.polroles\s*\)/.test(body)
  const escapeInQual =
    /pg_get_expr\s*\(\s*p\.polqual[\s\S]{0,120}?'brokerage_id IS NULL'/.test(body)
  const escapeInCheck =
    /pg_get_expr\s*\(\s*p\.polwithcheck[\s\S]{0,120}?'brokerage_id IS NULL'/.test(body)
  // The INSERT half: FOR INSERT, WITH CHECK exactly true, permissive.
  const insertHalf =
    /p\.polcmd\s*=\s*'a'/.test(body) &&
    /p\.polpermissive/.test(body) &&
    /pg_get_expr\s*\(\s*p\.polwithcheck[\s\S]{0,120}?=\s*'true'/.test(body)

  // And it must NOT be selecting by policy name.
  const keysOnName = /\bp\.polname\s+(?:i?like|=|~)/i.test(body)

  const ok = toPublic && escapeInQual && escapeInCheck && insertHalf && !keysOnName
  return check(
    label,
    ok,
    ok
      ? ""
      : `toPublic=${toPublic} escapeInQual=${escapeInQual} escapeInCheck=${escapeInCheck} insertHalf=${insertHalf} keysOnName=${keysOnName}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A11 — m394 is a NARROWING, not a rewrite
// ─────────────────────────────────────────────────────────────────────────────
function assertM394IsNarrowingOnly(): boolean {
  const body = stripSqlComments(raw(M394)).replace(/\s+/g, " ")
  const altersToAuthenticated = /alter policy %I on public\.%I to authenticated/i.test(body)
  // Removing the `brokerage_id IS NULL` branch is the CROSS-TENANT half. The
  // audit records it as needing an owner ruling — three different correct
  // resolutions depending on the table — so it must not arrive here as an edit.
  const rewritesExpression = /alter policy[^;]*\b(using|with check)\b/i.test(body)
  const drops = /\bdrop\s+policy\b/i.test(body)
  const creates = /\bcreate\s+policy\b/i.test(body)
  const ok = altersToAuthenticated && !rewritesExpression && !drops && !creates
  return check(
    "A11 m394 only ALTERs … TO authenticated (no DROP, no CREATE, no expression rewrite)",
    ok,
    ok
      ? ""
      : `altersToAuthenticated=${altersToAuthenticated} rewritesExpression=${rewritesExpression} drops=${drops} creates=${creates}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A12 — the one anon-INSERT carve-out is NAMED, and m394 and m395 agree on it
// ─────────────────────────────────────────────────────────────────────────────
function carveOutSet(path: string): string[] {
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")
  const m = /keep_anon_insert[^=]*:=\s*(array\s*\[[^\]]*\]|'\{\}')/i.exec(body)
  if (!m) return []
  if (/^'\{\s*\}'$/.test(m[1].trim())) return [] // an empty `'{}'` array literal
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

function assertCarveOutNamedAndAgreed(): boolean {
  const inM394 = carveOutSet(M394)
  const inM395 = carveOutSet(M395)
  const named = inM394.includes(NAMED_ANON_INSERT_CARVE_OUT)
  const agreed =
    inM394.length === inM395.length && inM394.every((x) => inM395.includes(x))
  const ok = named && agreed
  return check(
    "A12 the anon-INSERT carve-out is NAMED in m394 and m395 names the same set",
    ok,
    ok ? "" : `m394=[${inM394.join(", ")}] m395=[${inM395.join(", ")}]`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control {
  file: string
  find: string
  replace: string
}

let negativeControls = 0
let specificityControls = 0

/**
 * Apply a patch, VERIFY IT CHANGED THE FILE, run `fn`, require the stated
 * outcome, restore, verify the restore by sha256.
 *
 * The applied-check is the part that matters. A control whose find-string no
 * longer matches leaves the file untouched, the assertion stays green, and a
 * green run gets read as "the control passed" when nothing was ever tested.
 */
function runControl(
  kind: "NEGATIVE" | "SPECIFICITY",
  label: string,
  c: Control,
  fn: () => boolean,
  wantGreen: boolean,
): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)

  if (after === before) {
    console.log(
      `  ✗ ${kind} CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`,
    )
    failures.push(`${kind.toLowerCase()} control did not apply: ${label}`)
    return
  }

  writeFileSync(resolve(ROOT, c.file), after)
  let observedGreen = false
  try {
    const marker = failures.length
    observedGreen = fn()
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }

  if (observedGreen === wantGreen) {
    console.log(
      `  ✓ ${kind} CONTROL ${label} — ${wantGreen ? "STAYED GREEN as required" : "went RED as required"}`,
    )
  } else {
    console.log(
      `  ✗ ${kind} CONTROL ${label} — ${wantGreen ? "went RED on a correctly-spelled policy" : "STAYED GREEN with the defect present"}`,
    )
    failures.push(`${kind.toLowerCase()} control wrong outcome: ${label}`)
  }
}

function negative(label: string, c: Control, fn: () => boolean): void {
  negativeControls++
  runControl("NEGATIVE", label, c, fn, false)
}
function specificity(label: string, c: Control, fn: () => boolean): void {
  specificityControls++
  runControl("SPECIFICITY", label, c, fn, true)
}

// ─────────────────────────────────────────────────────────────────────────────
const A1 = () =>
  assertAppliedOutsideAllowList(
    `A1  ${APPLIED_DIR}/ declares NO anon-reachable tenant escape outside the frozen allow-list`,
    isAnonReachableEscape,
    APPLIED_ESCAPE_FILES,
  )
const A2 = () =>
  assertRatchet(
    `A2  ${APPLIED_DIR}/ tenant-escape count`,
    APPLIED_DIR,
    isAnonReachableEscape,
    APPLIED_ESCAPE_BASELINE,
    "APPLIED_ESCAPE_BASELINE",
  )
const A3 = () =>
  assertAppliedOutsideAllowList(
    `A3  ${APPLIED_DIR}/ declares NO implicit-anon INSERT policy outside the frozen allow-list`,
    isImplicitAnonInsert,
    APPLIED_INSERT_FILES,
  )
const A4 = () =>
  assertRatchet(
    `A4  ${APPLIED_DIR}/ INSERT-true-to-PUBLIC count`,
    APPLIED_DIR,
    isImplicitAnonInsert,
    APPLIED_INSERT_BASELINE,
    "APPLIED_INSERT_BASELINE",
  )
const A5 = () =>
  assertRatchet(
    `A5  ${LEGACY_DIR}/ tenant-escape count`,
    LEGACY_DIR,
    isAnonReachableEscape,
    LEGACY_ESCAPE_BASELINE,
    "LEGACY_ESCAPE_BASELINE",
  )
const A6 = () =>
  assertRatchet(
    `A6  ${LEGACY_DIR}/ INSERT-true-to-PUBLIC count`,
    LEGACY_DIR,
    isImplicitAnonInsert,
    LEGACY_INSERT_BASELINE,
    "LEGACY_INSERT_BASELINE",
  )
const A7 = () =>
  assertRatchet(
    `A7  ${HANDRUN_DIR}/ tenant-escape count`,
    HANDRUN_DIR,
    isAnonReachableEscape,
    HANDRUN_ESCAPE_BASELINE,
    "HANDRUN_ESCAPE_BASELINE",
  )
const A8 = () =>
  assertRatchet(
    `A8  ${HANDRUN_DIR}/ INSERT-true-to-PUBLIC count`,
    HANDRUN_DIR,
    isImplicitAnonInsert,
    HANDRUN_INSERT_BASELINE,
    "HANDRUN_INSERT_BASELINE",
  )
const A9 = () => assertKeysOnConstruct(M394, "A9  m394 selects on the CONSTRUCT, not on polname")
const A10 = () => assertKeysOnConstruct(M395, "A10 m395 selects on the CONSTRUCT, not on polname")

// The probe statements the negative controls splice in.
const ESCAPE_PROBE =
  `create policy "nc probe escape" on public.contacts for all\n` +
  `  using (brokerage_id is null or brokerage_id = current_user_brokerage_id());\n`
const ESCAPE_PROBE_WRAPPED =
  `create policy "nc probe wrapped"\n  on public.contacts\n  for all\n` +
  `  using (\n    brokerage_id is null\n    or brokerage_id = current_user_brokerage_id()\n  );\n`
const ESCAPE_PROBE_DYNAMIC =
  `do $probe$ begin\n  execute format(\n    'CREATE POLICY %I ON public.%I FOR ALL ' ||\n` +
  `    'USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',\n` +
  `    'nc_probe_dynamic', 'contacts'\n  );\nend $probe$;\n`
const INSERT_PROBE = `create policy "nc probe insert" on public.contacts for insert with check (true);\n`

function main(): void {
  console.log("RLS ANON TENANT-ESCAPE GUARD\n")

  console.log("ASSERTIONS")
  A1()
  A2()
  A3()
  A4()
  A5()
  A6()
  A7()
  A8()
  A9()
  A10()
  assertM394IsNarrowingOnly()
  assertCarveOutNamedAndAgreed()

  console.log(
    `\n  escape      applied ${tally(APPLIED_DIR, isAnonReachableEscape).total}` +
      `  legacy ${tally(LEGACY_DIR, isAnonReachableEscape).total}` +
      `  hand-run ${tally(HANDRUN_DIR, isAnonReachableEscape).total}`,
  )
  console.log(
    `  insert-true applied ${tally(APPLIED_DIR, isImplicitAnonInsert).total}` +
      `  legacy ${tally(LEGACY_DIR, isImplicitAnonInsert).total}` +
      `  hand-run ${tally(HANDRUN_DIR, isImplicitAnonInsert).total}`,
  )

  if (RUN_NEGATIVE) {
    console.log("\nCONTROLS")

    // A1 — a new escape policy in the applied corpus. Zero baseline must catch
    // it. Patched into m395 so the statement is real SQL in a real migration
    // rather than an appended stub.
    negative(
      "a tenant-escape policy added to a migration outside the allow-list",
      { file: M395, find: "do $$", replace: `${ESCAPE_PROBE}do $$` },
      A1,
    )

    // A1 — the same statement WRAPPED across six lines. A line-oriented scan
    // sails straight past this one.
    negative(
      "the same escape policy wrapped across six lines (statement-level scan)",
      { file: M395, find: "do $$", replace: `${ESCAPE_PROBE_WRAPPED}do $$` },
      A1,
    )

    // A1 — and the same statement assembled by EXECUTE format() from
    // concatenated string literals, which is how 030 installs 44 of them.
    negative(
      "the same escape policy assembled by EXECUTE format() (literal gluing)",
      { file: M395, find: "do $$", replace: `${ESCAPE_PROBE_DYNAMIC}do $$` },
      A1,
    )

    // A2 — one more inside an ALLOW-LISTED file. The file is forgiven; the count
    // is not.
    negative(
      "one more escape policy added to allow-listed 029 (ratchet)",
      {
        file: "supabase/migrations/029-add-brokerage-id-to-intelligence-and-orphan-tables.sql",
        find: `DROP POLICY IF EXISTS "batchdata_motivated_sellers_auth_only"`,
        replace: `${ESCAPE_PROBE}DROP POLICY IF EXISTS "batchdata_motivated_sellers_auth_only"`,
      },
      A2,
    )

    // A3 — a new implicit-anon INSERT policy in the applied corpus.
    negative(
      "an INSERT-true policy with no TO clause added to a migration outside the allow-list",
      { file: M395, find: "do $$", replace: `${INSERT_PROBE}do $$` },
      A3,
    )

    // A4 — one more inside an allow-listed file.
    negative(
      "one more INSERT-true policy added to allow-listed 052 (ratchet)",
      {
        file: "supabase/migrations/052-emails-drips-automation.sql",
        find: "CREATE TABLE IF NOT EXISTS public.email_sends (",
        replace: `${INSERT_PROBE}CREATE TABLE IF NOT EXISTS public.email_sends (`,
      },
      A4,
    )

    // A5 / A6 — the legacy corpus notices growth in either construct.
    negative(
      "one more escape policy added to the legacy scripts/ corpus",
      {
        file: "scripts/1032-tenant-safety-hardening.sql",
        find: "-- The migration is idempotent",
        replace: `${ESCAPE_PROBE}-- The migration is idempotent`,
      },
      A5,
    )
    negative(
      "one more INSERT-true policy added to the legacy scripts/ corpus",
      {
        file: "scripts/010-create-contacts-schema.sql",
        find: "CREATE TABLE IF NOT EXISTS contacts (",
        replace: `${INSERT_PROBE}CREATE TABLE IF NOT EXISTS contacts (`,
      },
      A6,
    )

    // A7 / A8 — the hand-run rls-governance corpus, which installs policies too.
    negative(
      "an escape policy added to the hand-run rls-governance corpus",
      {
        file: "supabase/rls-governance/012-deal-team-members-brokerage.sql",
        find: `DROP POLICY IF EXISTS "dtm_brokerage_isolation" ON deal_team_members;`,
        replace: `${ESCAPE_PROBE}DROP POLICY IF EXISTS "dtm_brokerage_isolation" ON deal_team_members;`,
      },
      A7,
    )
    negative(
      "one more INSERT-true policy added to the hand-run rls-governance corpus",
      {
        file: "supabase/rls-governance/001-users-policies.sql",
        find: `DROP POLICY IF EXISTS "Users can view own data" ON users;`,
        replace: `${INSERT_PROBE}DROP POLICY IF EXISTS "Users can view own data" ON users;`,
      },
      A8,
    )

    // A9 / A10 — the migrations rewritten to select on the policy NAME. They
    // would find whatever is spelled `%_tenant` and miss every other one: the
    // original mistake, believing a policy's name over its text.
    negative(
      "m394 rewritten to select on polname instead of the construct",
      {
        file: M394,
        find: "n.nspname = 'public'",
        replace: "p.polname like '%_tenant' and n.nspname = 'public'",
      },
      A9,
    )
    negative(
      "m395 rewritten to select on polname instead of the construct",
      {
        file: M395,
        find: "n.nspname = 'public'",
        replace: "p.polname like '%_tenant' and n.nspname = 'public'",
      },
      A10,
    )

    // A11 — m394 turned from a narrowing into a drop. Dropping the escape
    // policies would deny every authenticated tenant caller on 320 tables; and
    // rewriting the expression is the owner ruling this migration must not
    // pre-empt.
    negative(
      "m394's ALTER … TO authenticated turned into a DROP POLICY",
      {
        file: M394,
        find: "alter policy %I on public.%I to authenticated",
        replace: "drop policy %I on public.%I",
      },
      assertM394IsNarrowingOnly,
    )

    // A12 — the carve-out emptied on one side only. A carve-out the assertion
    // does not know about is a migration that reopens `anon` every time it runs
    // and an assertion that demands it be closed.
    negative(
      "m394's named carve-out emptied while m395 still exempts it",
      {
        file: M394,
        find: "array['tool_usage_sessions.tool_usage_sessions_insert']",
        replace: "'{}'",
      },
      assertCarveOutNamedAndAgreed,
    )

    // ── SPECIFICITY: the guard must not flag a correctly-spelled policy ──────
    specificity(
      "an escape policy that DOES say TO authenticated is not flagged",
      {
        file: M395,
        find: "do $$",
        replace:
          `create policy "sc probe escape" on public.contacts for all to authenticated\n` +
          `  using (brokerage_id is null or brokerage_id = current_user_brokerage_id());\n` +
          `do $$`,
      },
      A1,
    )
    specificity(
      "an INSERT-true policy that DOES name TO anon is not flagged",
      {
        file: M395,
        find: "do $$",
        replace:
          `create policy "sc probe insert" on public.contacts for insert to anon, authenticated\n` +
          `  with check (true);\ndo $$`,
      },
      A3,
    )

    console.log(
      `\n  ${negativeControls} negative controls, ${specificityControls} specificity controls; ` +
        `each patch verified applied and each file restored by sha256.`,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED")
}

main()
