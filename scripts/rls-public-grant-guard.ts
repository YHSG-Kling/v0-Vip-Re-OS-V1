#!/usr/bin/env tsx
/**
 * scripts/rls-public-grant-guard.ts   (tsx scripts/rls-public-grant-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * A POLICY NAMED "Service role full access" THAT GRANTS EVERYTHING TO EVERYONE.
 *
 * scripts/330-create-client-portal-collaborative-features.sql:217-226 declares
 * nine of these, under the comment "service role has full access, authenticated
 * users can read":
 *
 *     CREATE POLICY "Service role full access <t>" ON <t> FOR ALL USING (true);
 *
 * The name says service role. The statement does not.
 *
 *   · No `TO` clause ⇒ the policy applies to PUBLIC, which includes `anon` and
 *     `authenticated`.
 *   · `FOR ALL` is SELECT **and INSERT and UPDATE and DELETE**.
 *   · `USING (true)` is every row in every tenant.
 *   · Postgres does not read policy names. And the service role never needed a
 *     policy at all — it BYPASSES RLS. So the only principal the name mentions
 *     is the only principal the policy grants nothing to.
 *
 * AND RLS POLICIES ARE PERMISSIVE BY DEFAULT, SO THEY *OR* TOGETHER. One of
 * these does not sit beside a correct policy — it makes the correct one
 * decorative. That is why this is a guard and not a lint: the damage is silent,
 * total, and invisible in the presence of perfectly good policies right next to
 * it.
 *
 * ── WHAT THIS GUARD STANDS OVER ──────────────────────────────────────────────
 *
 * TWO CORPORA, TWO DIFFERENT RULES, because they carry two different risks.
 *
 *   APPLIED  — `supabase/migrations/*.sql`. This is what actually reaches the
 *              database. Measured baseline: **ZERO**. So the rule is zero, and
 *              any occurrence FAILS. Not a ratchet — there is no acceptable
 *              first one.
 *
 *   LEGACY   — `scripts/*.sql`. 437 files, no runner in package.json, invoked by
 *              nothing. It holds 173 of these across 42 files: this was a house
 *              convention before the migrations corpus existed. Deleting 173
 *              lines out of 42 historical files is a separate decision from
 *              stopping the bleeding, so the rule here is a RATCHET: the count
 *              may fall, never rise. A new one cannot be added by copying a
 *              neighbour, which is exactly how the other 173 got there.
 *
 * Plus: the two migrations that clean this up must keep keying on the CONSTRUCT.
 * m392 (drop) and m393 (assert) select on `polpermissive AND polcmd='*' AND
 * qual='true' AND granted-to-PUBLIC/anon/authenticated`. If either is ever
 * rewritten to match on the policy NAME instead, it would find exactly the nine
 * from 330 and miss every differently-named one — reproducing the original
 * mistake, which was believing a policy's name over its text.
 *
 * ── HOW THIS PROOF IS BUILT ──────────────────────────────────────────────────
 *   · Detection is STATEMENT-LEVEL, not line-level: SQL wraps freely, and a
 *     `CREATE POLICY … \n FOR ALL USING (true)` split across three lines is the
 *     same statement. Comments are stripped first, so a guard cannot be
 *     satisfied — or tripped — by prose.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into a
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre, not a control), the check is
 *     required to flip RED, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const APPLIED_DIR = "supabase/migrations"
const LEGACY_DIR = "scripts"

/** The legacy corpus ratchet. Lower it when the count genuinely falls.
 *  173 -> 170: scripts/335-create-agents-table.sql's gamification block was
 *  removed with m484. It defined three tables that do not exist in the live
 *  database (agent_points_history, agent_earned_badges, and an `agent_badges`
 *  with a shape that COLLIDES with the live join table), each guarded by
 *  `FOR ALL USING (true) WITH CHECK (true)`. Slack in this ratchet is not
 *  harmless: it is exactly what let the negative control add a defect and still
 *  pass, so the number has to follow the corpus down. */
const LEGACY_BASELINE = 170

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
 * Every statement in a SQL file that CREATEs a permissive policy granting ALL
 * commands on every row to PUBLIC (or explicitly to anon / authenticated).
 *
 * Statement-level and whitespace-normalised, because the construct wraps across
 * lines freely and a line-oriented scan would miss the wrapped ones — which is
 * to say, it would miss whichever ones somebody happened to format differently.
 */
function publicGrantAllStatements(src: string): string[] {
  const clean = stripSqlComments(src)
  const out: string[] = []
  for (const stmt of clean.split(";")) {
    const s = stmt.replace(/\s+/g, " ").trim()
    if (!/^CREATE\s+POLICY\b/i.test(s)) continue
    // RESTRICTIVE policies AND together and cannot widen anything — out of scope.
    if (/\bAS\s+RESTRICTIVE\b/i.test(s)) continue
    if (!/\bFOR\s+ALL\b/i.test(s)) continue
    if (!/\bUSING\s*\(\s*true\s*\)/i.test(s)) continue
    // A `TO` clause naming only real principals (service_role, a named role) is
    // not this defect. No TO clause at all means PUBLIC, which is.
    const to = /\bTO\s+([A-Za-z_", ]+?)\s+(?:USING|WITH)\b/i.exec(s)
    if (to) {
      const roles = to[1].toLowerCase()
      if (!/\b(public|anon|authenticated)\b/.test(roles)) continue
    }
    out.push(s)
  }
  return out
}

function sqlFiles(dir: string): string[] {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f))
}

function countIn(dir: string): { total: number; files: string[] } {
  const files: string[] = []
  let total = 0
  for (const f of sqlFiles(dir)) {
    const n = publicGrantAllStatements(raw(f)).length
    if (n > 0) {
      files.push(`${f} (${n})`)
      total += n
    }
  }
  return { total, files }
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 — the applied corpus is ZERO and stays zero
// ─────────────────────────────────────────────────────────────────────────────
function assertAppliedCorpusClean(): boolean {
  const { total, files } = countIn(APPLIED_DIR)
  return check(
    `A1  ${APPLIED_DIR}/ declares NO policy granting ALL to PUBLIC`,
    total === 0,
    total === 0 ? "" : `found ${total} in: ${files.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A2 — the legacy corpus may shrink, never grow
// ─────────────────────────────────────────────────────────────────────────────
function assertLegacyRatchet(): boolean {
  const { total } = countIn(LEGACY_DIR)
  const ok = check(
    `A2  ${LEGACY_DIR}/ ALL-to-PUBLIC count ${total} <= baseline ${LEGACY_BASELINE}`,
    total <= LEGACY_BASELINE,
    total <= LEGACY_BASELINE ? "" : `grew by ${total - LEGACY_BASELINE}`,
  )
  if (total < LEGACY_BASELINE) {
    console.log(
      `    ↓ count fell to ${total}. Lower LEGACY_BASELINE to ${total} in this file — deliberately, as a record that they went away.`,
    )
  }
  return ok
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 — the cleanup migrations key on the CONSTRUCT, not on a policy name
// ─────────────────────────────────────────────────────────────────────────────
const M392 = "supabase/migrations/m392-drop-every-policy-that-grants-all-to-public.sql"
const M393 = "supabase/migrations/m393-assert-no-policy-grants-all-to-public.sql"

function assertKeysOnConstruct(path: string, label: string): boolean {
  if (!existsSync(resolve(ROOT, path))) {
    return check(label, false, `${path} is missing`)
  }
  const body = stripSqlComments(raw(path)).replace(/\s+/g, " ")

  // The four facts that MAKE it the defect. All four must appear in the
  // selection, or the migration is matching on something weaker than the thing.
  const permissive = /\bp\.polpermissive\b/.test(body)
  const forAll = /\bp\.polcmd\s*=\s*'\*'/.test(body)
  const qualTrue = /pg_get_expr\s*\(\s*p\.polqual[\s\S]{0,80}?=\s*'true'/.test(body)
  const toPublic =
    /0\s*=\s*any\s*\(\s*p\.polroles\s*\)/.test(body) &&
    /'anon'\s*,\s*'authenticated'/.test(body)

  // And it must NOT be selecting by policy name — the original mistake was
  // believing a policy's name over its text.
  const keysOnName = /\bp\.polname\s+(?:i?like|=|~)/i.test(body)

  return check(
    label,
    permissive && forAll && qualTrue && toPublic && !keysOnName,
    permissive && forAll && qualTrue && toPublic && !keysOnName
      ? ""
      : `permissive=${permissive} forAll=${forAll} qualTrue=${qualTrue} toPublic=${toPublic} keysOnName=${keysOnName}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 — m392's drops must be conditional on the table having another policy
// ─────────────────────────────────────────────────────────────────────────────
function assertM392WillNotLockOut(): boolean {
  const body = stripSqlComments(raw(M392)).replace(/\s+/g, " ")
  // It counts sibling policies, and the DROP is inside the branch where that
  // count is non-zero. Without this, dropping a table's only policy denies every
  // non-service caller — the opposite failure, and just as real.
  const counts = /count\s*\(\s*\*\s*\)\s+into\s+other_count[\s\S]*?polname\s*<>/i.test(body)
  const dropGuarded = /if\s+other_count\s*=\s*0\s+then[\s\S]*?else[\s\S]*?drop policy/i.test(body)
  return check(
    "A4  m392 drops ONLY where the table has another policy (no lockout)",
    counts && dropGuarded,
    counts && dropGuarded ? "" : `siblingCount=${counts} dropGuarded=${dropGuarded}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control {
  file: string
  find: string
  replace: string
}

/**
 * Apply a patch, VERIFY IT CHANGED THE FILE, run `fn`, require RED, restore,
 * verify the restore by sha256.
 *
 * The applied-check is the part that matters. A control whose find-string no
 * longer matches leaves the file untouched, the assertion stays green, and a
 * green run gets read as "the control passed" when nothing was ever tested.
 */
function controlled(label: string, c: Control, fn: () => boolean): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)

  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }

  writeFileSync(resolve(ROOT, c.file), after)
  let wentRed = false
  try {
    const marker = failures.length
    const ok = fn()
    wentRed = !ok
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }

  if (wentRed) {
    console.log(`  ✓ NEGATIVE CONTROL ${label} — went RED as required`)
  } else {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
    failures.push(`negative control stayed green: ${label}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function main(): void {
  console.log("RLS PUBLIC-GRANT GUARD\n")

  console.log("ASSERTIONS")
  assertAppliedCorpusClean()
  assertLegacyRatchet()
  assertKeysOnConstruct(M392, "A3a m392 selects on the CONSTRUCT, not on polname")
  assertKeysOnConstruct(M393, "A3b m393 selects on the CONSTRUCT, not on polname")
  assertM392WillNotLockOut()

  const { total: appliedNow } = countIn(APPLIED_DIR)
  const { total: legacyNow, files: legacyFiles } = countIn(LEGACY_DIR)
  console.log(
    `\n  applied corpus: ${appliedNow}   legacy corpus: ${legacyNow} across ${legacyFiles.length} files`,
  )

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. One slips into the APPLIED corpus. Zero-baseline must catch it.
    //    Patched into m393's trailing notice line so the statement is real SQL
    //    in a real applied migration rather than an appended stub.
    controlled(
      "an ALL-to-PUBLIC policy added to supabase/migrations/",
      {
        file: M393,
        find: "do $$",
        replace: `create policy "nc probe" on public.contacts for all using (true);\ndo $$`,
      },
      assertAppliedCorpusClean,
    )

    // 2. The same statement, WRAPPED across lines — the line-oriented scan this
    //    replaces would sail straight past it.
    controlled(
      "the same policy wrapped across three lines (statement-level scan)",
      {
        file: M393,
        find: "do $$",
        replace: `create policy "nc probe wrapped"\n  on public.contacts\n  for all\n  using (true);\ndo $$`,
      },
      assertAppliedCorpusClean,
    )

    // 3. The legacy ratchet notices growth.
    const legacyProbe = "scripts/330-create-client-portal-collaborative-features.sql"
    controlled(
      "one more ALL-to-PUBLIC policy added to the legacy corpus",
      {
        file: legacyProbe,
        find: "-- ROW LEVEL SECURITY",
        replace: `CREATE POLICY "nc probe legacy" ON showing_requests FOR ALL USING (true);\n-- ROW LEVEL SECURITY`,
      },
      assertLegacyRatchet,
    )

    // 4. m392 rewritten to match the policy NAME — it would find 330's nine and
    //    miss every differently-named one. This is the original mistake exactly:
    //    believing the name over the text.
    controlled(
      "m392 rewritten to select on polname instead of the construct",
      {
        file: M392,
        find: "and  p.polpermissive",
        replace: "and  p.polname like 'Service role%'\n      and  false and p.polpermissive",
      },
      () => assertKeysOnConstruct(M392, "A3a m392 selects on the CONSTRUCT, not on polname"),
    )

    // 5. m392's drop made unconditional — it would deny every non-service caller
    //    on any table whose only policy is the bad one.
    controlled(
      "m392's DROP made unconditional (would lock out single-policy tables)",
      {
        file: M392,
        find: "if other_count = 0 then",
        replace: "if false then",
      },
      assertM392WillNotLockOut,
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
