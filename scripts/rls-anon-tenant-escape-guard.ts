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
 * ── AND THEN m396/m397, WHERE THE QUALIFIER MOVED OFF THE PROXY ──────────────
 *
 * m394's INSERT half fired only where the table ALSO carried the escape. That
 * qualifier was correct — it is what kept m394 away from `listing_inquiries`,
 * the real public inquiry form — but the escape is a PROXY for "tenant table",
 * carried by whichever tables 029/030 happened to reach, and it is lossy. Of
 * the 58 INSERT-true-to-PUBLIC policies m394 left standing, **38 sit on tables
 * that carry a `brokerage_id` COLUMN**, which is what this schema actually means
 * by a tenant table. `agent_monthly_earnings`, `agent_points_log`,
 * `communications`, `automation_logs`, `push_notification_queue`,
 * `transaction_pending_actions`: an anonymous caller could insert into an
 * earnings ledger. See docs/wave21-audit.md § W21-5 and docs/wave22-audit.md
 * § W22-2 for the two-axis census (browser client, AND session client on a
 * logged-out route — the second is why `tool_usage_sessions` is a carve-out).
 *
 * m396 narrows 37 of the 38 on the column qualifier; m397 asserts it. TWO named
 * carve-outs, and the second one matters structurally: `listing_inquiries`
 * (genuine logged-out browser writer) AND `tool_usage_sessions` (m394's
 * carve-out, whose table satisfies the wider qualifier too — unnamed in m396 it
 * would be narrowed, silently reversing m394). m396's keep set must therefore
 * stay a SUPERSET of m394's, and A16 below is what holds that.
 *
 * Applied state after m394 + m396: of the 74, 52 are narrowed (15 + 37) and 22
 * remain granted to PUBLIC — 20 on tables with NO `brokerage_id` column (not
 * tenant tables; a separate question) plus the 2 named carve-outs.
 *
 * ── WHAT THIS GUARD STANDS OVER: THE SOURCE SIDE ─────────────────────────────
 *
 * m394/m395 and m396/m397 fix and hold the DATABASE. They cannot stop a 321st
 * arriving in the next migration by somebody copying the neighbour above it —
 * which is exactly how the 320 got there. This guard holds the SOURCE.
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
 * what the migrations actually change, and it STAYS broader after m396: the
 * migrations narrow 52 of the 74 — the ones on tenant tables, where the census
 * cleared them — and leave 22 alone, because narrowing an uncensused public
 * surface is a behaviour change and demanding that a NEW policy name its roles
 * is free. The asymmetry is deliberate and it shrank on purpose; it did not go
 * away. It never should: naming the roles is the cheap half.
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
 *   · The migrations must keep keying on the CONSTRUCT. If m394, m395, m396 or
 *     m397 is ever rewritten to match a policy NAME, it would find whatever
 *     happens to be spelled `%_tenant` / `%_insert` and miss every
 *     differently-named one — the original mistake (believing a policy's name
 *     over its text) in a new coat.
 *   · m394 and m396 must stay NARROWINGS. Removing the `brokerage_id IS NULL`
 *     branch is the cross-tenant half, it is recorded in the audit as needing an
 *     owner ruling with three different correct resolutions (task #156), and it
 *     is asserted here so it cannot arrive as a quiet edit to a file that
 *     already exists.
 *   · m396's carve-out set must stay a SUPERSET of m394's. m396 widens the
 *     qualifier from "table carries the escape" to "table carries a
 *     `brokerage_id` column", which swallows m394's own carve-out; if
 *     `tool_usage_sessions` ever falls out of m396's keep array, a migration
 *     written to close one hole silently reverses an earlier ruling on another.
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
const M396 =
  "supabase/migrations/m396-narrow-anonymous-insert-on-tenant-tables-to-authenticated.sql"
const M397 = "supabase/migrations/m397-assert-no-anonymous-insert-on-tenant-tables.sql"
const M398 =
  "supabase/migrations/m398-offer-strategy-templates-active-means-published-to-the-tenant.sql"
const M399 = "supabase/migrations/m399-assert-no-tenant-table-publishes-on-is-active-alone.sql"

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

/**
 * The one policy m394 deliberately leaves reachable by `anon`:
 * `app/actions/calculators.ts:607 trackToolUsage`, a session client on a
 * logged-out route, so it really does run as `anon`.
 */
const NAMED_ANON_INSERT_CARVE_OUT = "tool_usage_sessions.tool_usage_sessions_insert"

/**
 * The policies m396 deliberately leaves reachable by `anon`. TWO, and the second
 * is not optional: m396's qualifier ("table carries a `brokerage_id` column") is
 * WIDER than m394's ("table carries the escape") and `tool_usage_sessions`
 * satisfies both, so m396 must re-name m394's carve-out or it narrows it.
 *
 *   listing_inquiries   — the public inquiry form.
 *                         app/listings/[listingId]/public-info-form.tsx, a
 *                         browser client on a logged-out listing page.
 *   tool_usage_sessions — carried forward from m394. Same call site as above.
 */
const M396_ANON_INSERT_CARVE_OUTS = [
  "listing_inquiries.listing_inquiries_insert",
  NAMED_ANON_INSERT_CARVE_OUT,
]

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
// A11 / A15 — the narrowing migrations are NARROWINGS, not rewrites
// ─────────────────────────────────────────────────────────────────────────────
function assertNarrowingOnly(path: string, label: string): boolean {
  if (!existsSync(resolve(ROOT, path))) return check(label, false, `${path} is missing`)
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")
  const altersToAuthenticated = /alter policy %I on public\.%I to authenticated/i.test(body)
  // Removing the `brokerage_id IS NULL` branch is the CROSS-TENANT half. The
  // audit records it as needing an owner ruling (task #156) — three different
  // correct resolutions depending on the table — so it must not arrive here as
  // an edit to a file that already exists.
  const rewritesExpression = /alter policy[^;]*\b(using|with check)\b/i.test(body)
  const drops = /\bdrop\s+policy\b/i.test(body)
  const creates = /\bcreate\s+policy\b/i.test(body)
  const ok = altersToAuthenticated && !rewritesExpression && !drops && !creates
  return check(
    label,
    ok,
    ok
      ? ""
      : `altersToAuthenticated=${altersToAuthenticated} rewritesExpression=${rewritesExpression} drops=${drops} creates=${creates}`,
  )
}

const assertM394IsNarrowingOnly = () =>
  assertNarrowingOnly(
    M394,
    "A11 m394 only ALTERs … TO authenticated (no DROP, no CREATE, no expression rewrite)",
  )

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
// A13 / A14 — m396 and m397 key on the CONSTRUCT, and on the RIGHT construct
//
// Their qualifier is NOT m394's. It is: a PERMISSIVE `FOR INSERT WITH CHECK
// (true)` policy granted to PUBLIC, on a table carrying a live `brokerage_id`
// COLUMN. Two ways to get this wrong, and both are checked:
//   · selecting by policy NAME (`%_insert`), which is the original mistake —
//     believing a policy's name over its text — in a new coat; and
//   · dropping the tenant-column qualifier, which turns a reviewed 37-policy
//     narrowing into a blanket narrowing of all 74 and takes the uncensused
//     public surfaces with it.
// ─────────────────────────────────────────────────────────────────────────────
function assertKeysOnTenantColumnConstruct(path: string, label: string): boolean {
  if (!existsSync(resolve(ROOT, path))) return check(label, false, `${path} is missing`)
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")

  const toPublic = /0\s*=\s*any\s*\(\s*p\.polroles\s*\)/.test(body)
  const insertHalf =
    /p\.polcmd\s*=\s*'a'/.test(body) &&
    /p\.polpermissive/.test(body) &&
    /pg_get_expr\s*\(\s*p\.polwithcheck[\s\S]{0,120}?=\s*'true'/.test(body)
  // The qualifier that makes it a TENANT table: the column, read off the
  // catalogue, excluding dropped attributes (a dropped column still occupies a
  // pg_attribute row, and `attisdropped` is the difference between "has a
  // brokerage_id" and "used to").
  const tenantColumn =
    /pg_attribute/.test(body) &&
    /a\.attname\s*=\s*'brokerage_id'/.test(body) &&
    /a\.attisdropped/.test(body)

  const keysOnName = /\bp\.polname\s+(?:i?like|=|~)/i.test(body)

  const ok = toPublic && insertHalf && tenantColumn && !keysOnName
  return check(
    label,
    ok,
    ok
      ? ""
      : `toPublic=${toPublic} insertHalf=${insertHalf} tenantColumn=${tenantColumn} keysOnName=${keysOnName}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A16 — m396's carve-outs are NAMED, m397 agrees, and the set is a SUPERSET of
//       m394's. The superset half is the load-bearing one: m396 widens the
//       qualifier onto a table m394 deliberately spared, so a keep array that
//       forgets `tool_usage_sessions` reverses an earlier ruling by accident —
//       silently, with a green migration.
// ─────────────────────────────────────────────────────────────────────────────
function assertM396CarveOutsNamedAgreedAndSuperset(): boolean {
  const inM394 = carveOutSet(M394)
  const inM396 = carveOutSet(M396)
  const inM397 = carveOutSet(M397)

  const named = M396_ANON_INSERT_CARVE_OUTS.every((x) => inM396.includes(x))
  const agreed = inM396.length === inM397.length && inM396.every((x) => inM397.includes(x))
  const supersetOfM394 = inM394.every((x) => inM396.includes(x))

  const ok = named && agreed && supersetOfM394
  return check(
    "A16 m396's anon-INSERT carve-outs are NAMED, m397 names the same set, and it is a SUPERSET of m394's",
    ok,
    ok
      ? ""
      : `named=${named} agreed=${agreed} supersetOfM394=${supersetOfM394} ` +
          `m394=[${inM394.join(", ")}] m396=[${inM396.join(", ")}] m397=[${inM397.join(", ")}]`,
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// m398 / m399 — A FLAG IS NOT A TENANT
// ═════════════════════════════════════════════════════════════════════════════
//
// A THIRD anonymous-read path onto a tenant table, and it is not the escape and
// not an INSERT. `public.offer_strategy_templates` carries:
//
//     CREATE POLICY "Read active templates" ON public.offer_strategy_templates
//       FOR SELECT USING (is_active = true);
//
// No `TO` clause ⇒ PUBLIC ⊇ `anon`. An offer strategy template is a brokerage's
// NEGOTIATION PLAYBOOK — price guidance, earnest-money guidance, contingency
// recommendations and win rates per market condition. The table is empty today,
// which is the only reason nothing has leaked; the moment a brokerage marks one
// active it is world-readable. Proven live, RLS on, in a rolled-back transaction:
// one active row inserted, `anon` reads 1 and ANOTHER BROKERAGE'S authenticated
// user reads 1.
//
// ── WHY THIS ONE IS NOT AN m394-SHAPED FIX ──────────────────────────────────
//
// `is_active = true` says nothing about a tenant, so the leak survives a role
// narrowing: `TO authenticated` closes `anon` and leaves every other brokerage
// reading, which is most of the defect wearing the fix's clothes. m398 therefore
// REWRITES THE PREDICATE as well as the role — the only migration in this family
// that does, and the reason it gets its own narrowing assertion (A19) instead of
// `assertNarrowingOnly`, which requires m394/m396 NOT to touch an expression.
//
// The replacement predicate was read off this schema rather than invented, from
// the four comparable template tables — `brokerage_form_library`,
// `content_templates`, `chat_templates`, `thank_you_note_templates`. None gates
// SELECT on `is_active`; all four scope on `brokerage_id` with a NULL branch for
// platform-seeded rows. m398 uses the spelling this table's own sibling policies
// already use, and `is_active` is KEPT as a conjunct: the ruling is that active
// means published TO THIS TENANT'S PEOPLE, not that active stops meaning
// anything. Same before/after, rolled back and verified rolled back: `anon` 1→0,
// other brokerage 1→0, OWNING brokerage 1→1, policy count 5→5.
//
// ── AND THE PUBLIC-READER CHECK WAS RUN FIRST ───────────────────────────────
//
// wave 22 § W22-2's two axes. No browser-client file touches the table at all,
// and its ONE reader (`app/actions/buyer-offers.ts:411`) is inside a `"use
// server"` export that builds `createServiceClient()` — BYPASSRLS, so no policy
// is consulted for it. The table also has no runtime writer
// (`scripts/writerless-read-sweep.ts:33` lists it as seeded reference data).
// There is no legitimate public reader, so m398's carve-out array is empty.
//
//   A17 m398 selects on the CONSTRUCT (SELECT-to-PUBLIC, USING exactly
//       `(is_active = true)`, on a `brokerage_id` table), never on polname.
//   A18 m399 asserts the RULING rather than m398's spelling — `is_active`
//       consulted, `brokerage_id` never consulted — so `is_active IS TRUE` and
//       `is_active AND published` are caught too, and it is deliberately NOT
//       scoped to PUBLIC, because the cross-tenant half survives a role fix.
//   A19 m398 CONJOINS the tenant predicate and keeps `is_active`. Two ways to
//       get this wrong and both are checked: dropping to a role-only narrowing
//       (leaves every other brokerage reading), and replacing `is_active`
//       instead of ANDing it (a widening, publishing inactive drafts).
//   A20 m398's world-readable carve-out array is EMPTY, and m399 names the same
//       set — the m394/m396 discipline: a carve-out that is not named is not a
//       carve-out.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A17 — m398 keys on its construct: PERMISSIVE, `polcmd = 'r'`, PUBLIC in
 * `polroles`, USING exactly `(is_active = true)`, and a live `brokerage_id`
 * attribute on the table.
 *
 * The `brokerage_id` column qualifier is load-bearing for m396's reason: it is
 * what keeps m398 off `video_templates."Anyone can view active templates"`, the
 * one other policy on this database with the identical shape, whose table has no
 * `brokerage_id` and is a platform catalogue rather than a tenant's playbook.
 */
function assertKeysOnActiveFlagConstruct(path: string, label: string): boolean {
  if (!existsSync(resolve(ROOT, path))) return check(label, false, `${path} is missing`)
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")

  const toPublic = /0\s*=\s*any\s*\(\s*p\.polroles\s*\)/.test(body)
  const selectHalf = /p\.polcmd\s*=\s*'r'/.test(body) && /p\.polpermissive/.test(body)
  const exactFlagPredicate =
    /pg_get_expr\s*\(\s*p\.polqual[\s\S]{0,140}?=\s*'\(is_active = true\)'/.test(body)
  const tenantColumn =
    /pg_attribute/.test(body) &&
    /a\.attname\s*=\s*'brokerage_id'/.test(body) &&
    /a\.attisdropped/.test(body)
  const keysOnName = /\bp\.polname\s+(?:i?like|=|~)/i.test(body)

  const ok = toPublic && selectHalf && exactFlagPredicate && tenantColumn && !keysOnName
  return check(
    label,
    ok,
    ok
      ? ""
      : `toPublic=${toPublic} selectHalf=${selectHalf} exactFlagPredicate=${exactFlagPredicate} tenantColumn=${tenantColumn} keysOnName=${keysOnName}`,
  )
}

/**
 * A18 — m399 asserts the RULING, not m398's exact spelling.
 *
 * It must key on "consults `is_active`, never consults `brokerage_id`", so that
 * `is_active IS TRUE`, a bare `is_active`, and `is_active AND <anything but the
 * tenant>` are all caught. And it must NOT be scoped to PUBLIC: a policy
 * narrowed to `authenticated` while still deciding on the flag alone has closed
 * `anon` and left every other brokerage reading, which is the half that matters
 * most and the half a PUBLIC-scoped assertion would bless.
 */
function assertM399AssertsTheRuling(): boolean {
  if (!existsSync(resolve(ROOT, M399))) return check("A18", false, `${M399} is missing`)
  const body = stripSqlComments(raw(M399)).replace(/\s+/g, " ")

  // `[^)]*` cannot cross the `)` of the nested `pg_get_expr(…)` these calls wrap,
  // so both of these read FALSE against the real file — which is how the A18
  // controls came back red for the wrong reason. Bounded `[\s\S]` spans instead.
  const consultsFlag = /strpos\(\s*[\s\S]{0,120}?p\.polqual[\s\S]{0,80}?'is_active'\s*\)\s*>\s*0/.test(body)
  const neverTenant = /strpos\(\s*[\s\S]{0,120}?p\.polqual[\s\S]{0,80}?'brokerage_id'\s*\)\s*=\s*0/.test(body)
  const tenantColumn =
    /a\.attname\s*=\s*'brokerage_id'/.test(body) && /a\.attisdropped/.test(body)
  // The load-bearing negative: it must NOT restrict itself to PUBLIC.
  const roleScoped = /0\s*=\s*any\s*\(\s*p\.polroles\s*\)/.test(body)
  const raises = /\braise\s+exception\b/i.test(body)
  const keysOnName = /\bp\.polname\s+(?:i?like|=|~)/i.test(body)

  const ok = consultsFlag && neverTenant && tenantColumn && !roleScoped && raises && !keysOnName
  return check(
    "A18 m399 asserts the RULING (consults `is_active`, never consults `brokerage_id`) and is NOT scoped to PUBLIC",
    ok,
    ok
      ? ""
      : `consultsFlag=${consultsFlag} neverTenant=${neverTenant} tenantColumn=${tenantColumn} ` +
          `roleScoped=${roleScoped} raises=${raises} keysOnName=${keysOnName}`,
  )
}

/**
 * A19 — m398 CONJOINS. Unlike m394/m396 it is allowed — required — to rewrite
 * the USING expression, so `assertNarrowingOnly` is the wrong assertion for it.
 * What must hold instead:
 *   · it narrows the ROLE too (`to authenticated`), or every other brokerage
 *     keeps reading;
 *   · it AND-joins the tenant predicate this schema already uses;
 *   · it KEEPS `is_active` rather than replacing it — replacing it would publish
 *     inactive drafts to the tenant, which is a WIDENING dressed as a fix;
 *   · and it still does not DROP or CREATE a policy.
 */
function assertM398ConjoinsTenantPredicate(): boolean {
  if (!existsSync(resolve(ROOT, M398))) return check("A19", false, `${M398} is missing`)
  // Adjacent string literals are GLUED first, the way `policyStatements` glues
  // `'…' || '…'`. The ALTER m398 builds is already spelled as two adjacent
  // literals, and re-wrapping the predicate across a different pair of them must
  // not read as "the tenant predicate is gone" — that is a whitespace test, not
  // a security assertion, and the specificity control below is what caught it.
  // `''` (the empty-string literal, no whitespace between the quotes) is left
  // alone on purpose: it is an argument, not a continuation.
  const body = stripSqlComments(raw(M398))
    .replace(/\s+/g, " ")
    .replace(/'\s+'/g, "")

  const alter = /alter policy %I on public\.%I to authenticated/i.test(body)
  const keepsFlag = /using\s*\(\s*is_active\s*=\s*true\s+and\b/i.test(body)
  const conjoinsTenant =
    /brokerage_id is null or brokerage_id = current_user_brokerage_id\(\)/i.test(body)
  const drops = /\bdrop\s+policy\b/i.test(body)
  const creates = /\bcreate\s+policy\b/i.test(body)

  const ok = alter && keepsFlag && conjoinsTenant && !drops && !creates
  return check(
    "A19 m398 narrows the ROLE and AND-joins the tenant predicate while KEEPING `is_active` (no DROP, no CREATE)",
    ok,
    ok
      ? ""
      : `altersToAuthenticated=${alter} keepsIsActiveConjunct=${keepsFlag} conjoinsTenant=${conjoinsTenant} drops=${drops} creates=${creates}`,
  )
}

/** The `keep_world_readable` array of m398 / m399, read the way `carveOutSet` reads m394's. */
function worldReadableCarveOutSet(path: string): string[] {
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")
  const m = /keep_world_readable[^=]*:=\s*(array\s*\[[^\]]*\]|'\{\}')/i.exec(body)
  if (!m) return ["<no keep_world_readable array found>"]
  if (/^'\{\s*\}'$/.test(m[1].trim())) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/**
 * A20 — the carve-out array exists on BOTH files and names the same set.
 *
 * It is empty today, and the reading behind that is recorded in m398's header:
 * no browser client touches the table, its one reader is a service client, and
 * the table has no runtime writer. If it is ever non-empty the two files must
 * still agree, or m398 reopens a policy every time it runs and m399 demands it
 * be closed — m394/m395's A12 failure mode, on a different pair.
 */
function assertWorldReadableCarveOutsAgree(): boolean {
  if (!existsSync(resolve(ROOT, M398)) || !existsSync(resolve(ROOT, M399))) {
    return check("A20", false, "m398 or m399 is missing")
  }
  const inM398 = worldReadableCarveOutSet(M398)
  const inM399 = worldReadableCarveOutSet(M399)
  const declared = !inM398.includes("<no keep_world_readable array found>") &&
    !inM399.includes("<no keep_world_readable array found>")
  const agreed = inM398.length === inM399.length && inM398.every((x) => inM399.includes(x))
  const ok = declared && agreed
  return check(
    "A20 m398 and m399 declare a `keep_world_readable` carve-out array and name the SAME set",
    ok,
    ok ? "" : `declared=${declared} m398=[${inM398.join(", ")}] m399=[${inM399.join(", ")}]`,
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
const A13 = () =>
  assertKeysOnTenantColumnConstruct(
    M396,
    "A13 m396 selects on the CONSTRUCT (INSERT-true-to-PUBLIC on a `brokerage_id` table), not on polname",
  )
const A14 = () =>
  assertKeysOnTenantColumnConstruct(
    M397,
    "A14 m397 selects on the CONSTRUCT (INSERT-true-to-PUBLIC on a `brokerage_id` table), not on polname",
  )
const A15 = () =>
  assertNarrowingOnly(
    M396,
    "A15 m396 only ALTERs … TO authenticated (no DROP, no CREATE, no expression rewrite)",
  )
const A17 = () =>
  assertKeysOnActiveFlagConstruct(
    M398,
    "A17 m398 selects on the CONSTRUCT (SELECT-to-PUBLIC, USING exactly `(is_active = true)`, on a `brokerage_id` table), not on polname",
  )

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
  A13()
  A14()
  A15()
  assertM396CarveOutsNamedAgreedAndSuperset()
  A17()
  assertM399AssertsTheRuling()
  assertM398ConjoinsTenantPredicate()
  assertWorldReadableCarveOutsAgree()

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

    // A13 / A14 — m396 and m397 rewritten to select on the policy NAME. Same
    // mistake as A9/A10 in a different spelling: they would find whatever is
    // called `%_insert` and miss every differently-named one.
    negative(
      "m396 rewritten to select on polname instead of the construct",
      {
        file: M396,
        find: "n.nspname = 'public'",
        replace: "p.polname like '%_insert' and n.nspname = 'public'",
      },
      A13,
    )
    negative(
      "m397 rewritten to select on polname instead of the construct",
      {
        file: M397,
        find: "n.nspname = 'public'",
        replace: "p.polname like '%_insert' and n.nspname = 'public'",
      },
      A14,
    )

    // A13 — the TENANT-COLUMN qualifier dropped. Without it m396 stops being a
    // reviewed 37-policy narrowing and becomes a blanket narrowing of all 74,
    // taking the 20 uncensused public surfaces with it.
    negative(
      "m396's `brokerage_id` column qualifier removed (blanket narrowing of all 74)",
      {
        file: M396,
        find: "and  a.attname  = 'brokerage_id'",
        replace: "and  a.attname  = a.attname",
      },
      A13,
    )

    // A15 — m396 turned from a narrowing into a drop. Dropping these policies
    // would deny every authenticated tenant writer on 37 tables, which is the
    // opposite failure and just as real.
    negative(
      "m396's ALTER … TO authenticated turned into a DROP POLICY",
      {
        file: M396,
        find: "alter policy %I on public.%I to authenticated",
        replace: "drop policy %I on public.%I",
      },
      A15,
    )

    // A16 — m396's carve-outs emptied while m397 still exempts them. A migration
    // that reopens `anon` on the inquiry form every time it runs, and an
    // assertion that demands it be closed.
    negative(
      "m396's named carve-outs emptied while m397 still exempts them",
      {
        file: M396,
        find:
          `array[\n    'listing_inquiries.listing_inquiries_insert',\n` +
          `    'tool_usage_sessions.tool_usage_sessions_insert'\n  ]`,
        replace: "'{}'",
      },
      assertM396CarveOutsNamedAgreedAndSuperset,
    )

    // A16 — THE ONE THIS ASSERTION EXISTS FOR. `tool_usage_sessions` dropped
    // from m396's keep array: m396's qualifier is wider than m394's and covers
    // that table, so m396 would narrow the one policy m394 deliberately kept and
    // reverse an earlier ruling silently, with both migrations green.
    negative(
      "m394's carve-out dropped from m396's keep array (m394's ruling reversed)",
      {
        file: M396,
        find:
          `'listing_inquiries.listing_inquiries_insert',\n` +
          `    'tool_usage_sessions.tool_usage_sessions_insert'`,
        replace: "'listing_inquiries.listing_inquiries_insert'",
      },
      assertM396CarveOutsNamedAgreedAndSuperset,
    )

    // A16 — and the superset property ON ITS OWN, isolated from `agreed`: m394
    // grows a carve-out that m396 does not carry forward. m396 and m397 still
    // agree with each other and still name the inquiry form, so only the
    // superset half can be what goes red.
    negative(
      "m394 gains a carve-out m396 does not carry forward (superset property alone)",
      {
        file: M394,
        find: "array['tool_usage_sessions.tool_usage_sessions_insert']",
        replace:
          "array['tool_usage_sessions.tool_usage_sessions_insert', " +
          "'saved_calculations.saved_calculations_insert']",
      },
      assertM396CarveOutsNamedAgreedAndSuperset,
    )

    // ── m398 / m399: A FLAG IS NOT A TENANT ──────────────────────────────────

    // A17 — m398 rewritten to select on the policy NAME. Same mistake as A9/A13
    // in a third spelling: it would find whatever is called `Read active %` and
    // miss every differently-named one.
    negative(
      "m398 rewritten to select on polname instead of the construct",
      {
        file: M398,
        find: "n.nspname = 'public'",
        replace: "p.polname like 'Read active%' and n.nspname = 'public'",
      },
      A17,
    )

    // A17 — the TENANT-COLUMN qualifier dropped. Without it m398 also rewrites
    // `video_templates."Anyone can view active templates"`, whose table has no
    // `brokerage_id` at all — so the ALTER would install a predicate naming a
    // column that does not exist, on a platform catalogue nobody censused.
    negative(
      "m398's `brokerage_id` column qualifier removed (it would reach video_templates)",
      {
        file: M398,
        find: "and  a.attname  = 'brokerage_id'",
        replace: "and  a.attname  = a.attname",
      },
      A17,
    )

    // A18 — THE ONE m399 EXISTS FOR. Scope the assertion to PUBLIC, the way m395
    // and m397 legitimately do, and it starts blessing the half-fix: a policy
    // narrowed to `authenticated` that still decides on the flag alone has shut
    // `anon` out and left every OTHER BROKERAGE reading the playbook.
    negative(
      "m399 scoped to PUBLIC (it would bless a role-only fix that leaves every other brokerage reading)",
      {
        file: M399,
        find: "    and  p.polpermissive                                         -- PERMISSIVE: it ORs",
        replace:
          "    and  0 = any(p.polroles)\n" +
          "    and  p.polpermissive                                         -- PERMISSIVE: it ORs",
      },
      assertM399AssertsTheRuling,
    )

    // A18 — m399 rewritten to key on m398's EXACT spelling. It would then pass
    // over `is_active IS TRUE`, over a bare `is_active`, and over `is_active AND
    // published_at IS NOT NULL` — the same defect in three other spellings.
    negative(
      "m399 keyed on m398's exact predicate spelling instead of the ruling",
      {
        file: M399,
        find: "    and  strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'is_active')    > 0",
        replace:
          "    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = '(is_active = true)'",
      },
      assertM399AssertsTheRuling,
    )

    // A19 — m398 downgraded to m394's remedy. `TO authenticated` alone closes
    // `anon` and leaves the cross-tenant read wide open, which is most of the
    // defect and the easiest wrong fix to reach for.
    negative(
      "m398 downgraded to a role-only narrowing (the cross-tenant read survives)",
      {
        file: M398,
        find:
          "      'alter policy %I on public.%I to authenticated '\n" +
          "      'using (is_active = true and (brokerage_id is null or brokerage_id = current_user_brokerage_id()))',",
        replace: "      'alter policy %I on public.%I to authenticated',",
      },
      assertM398ConjoinsTenantPredicate,
    )

    // A19 — `is_active` REPLACED rather than AND-ed. That is a WIDENING wearing
    // the fix's clothes: every inactive draft becomes readable across the tenant.
    negative(
      "m398 replaces `is_active` instead of conjoining it (inactive drafts published to the tenant)",
      {
        file: M398,
        find: "'using (is_active = true and (brokerage_id is null",
        replace: "'using ((brokerage_id is null",
      },
      assertM398ConjoinsTenantPredicate,
    )

    // A20 — the carve-out array removed from m399 while m398 still has one. The
    // two files would then disagree about which policies are deliberately
    // world-readable, which is A12's failure mode on a new pair.
    negative(
      "m399 loses its `keep_world_readable` array while m398 keeps one",
      {
        file: M399,
        find: "  keep_world_readable     text[] := '{}';",
        replace: "  unused_placeholder      text[] := '{}';",
      },
      assertWorldReadableCarveOutsAgree,
    )

    // A20 — and the two disagreeing on CONTENT rather than existence: m398
    // silently spares a policy m399 still demands be closed, so the migration
    // reopens it on every run and the assertion fails forever after.
    negative(
      "m398 gains a world-readable carve-out that m399 does not exempt",
      {
        file: M398,
        find: "  keep_world_readable text[] := '{}';",
        replace:
          "  keep_world_readable text[] := array['offer_strategy_templates.Read active templates'];",
      },
      assertWorldReadableCarveOutsAgree,
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
    // A13 keys on the CONSTRUCT, not on one exact spelling of it. Reformatting
    // the predicate must not be enough to trip a guard, or the guard is a
    // whitespace test wearing a security label.
    specificity(
      "m396's construct predicate reformatted (whitespace) is still recognised",
      {
        file: M396,
        find: "0 = any(p.polroles)",
        replace: "0  =  any( p.polroles )",
      },
      A13,
    )
    // A17 keys on the CONSTRUCT, not on one exact layout of it. Reformatting the
    // predicate must not be enough to trip a guard, or the guard is a whitespace
    // test wearing a security label.
    specificity(
      "m398's construct predicate reformatted (whitespace) is still recognised",
      {
        file: M398,
        find: "0 = any(p.polroles)",
        replace: "0  =  any( p.polroles )",
      },
      A17,
    )
    // A19 must accept the tenant predicate however it is laid out — it is
    // asserting that the conjunction is THERE, not that it is on one line.
    specificity(
      "m398's conjoined tenant predicate re-wrapped is still recognised",
      {
        file: M398,
        find:
          "      'using (is_active = true and (brokerage_id is null or brokerage_id = current_user_brokerage_id()))',",
        replace:
          "      'using (is_active = true and (brokerage_id is null '\n" +
          "      'or brokerage_id = current_user_brokerage_id()))',",
      },
      assertM398ConjoinsTenantPredicate,
    )
    // A16 keys on the carve-out SET, not on how the array is laid out.
    specificity(
      "m396's carve-out array collapsed onto one line is still the same set",
      {
        file: M396,
        find:
          `array[\n    'listing_inquiries.listing_inquiries_insert',\n` +
          `    'tool_usage_sessions.tool_usage_sessions_insert'\n  ]`,
        replace:
          `array['listing_inquiries.listing_inquiries_insert', ` +
          `'tool_usage_sessions.tool_usage_sessions_insert']`,
      },
      assertM396CarveOutsNamedAgreedAndSuperset,
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
