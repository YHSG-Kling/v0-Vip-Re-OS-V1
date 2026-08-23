#!/usr/bin/env tsx
/**
 * scripts/listing-delete-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CHILD-BLIND LISTING DELETE — proof that it is closed, and proof that this
 * file could still see it if it were reopened.
 *
 * `app/actions/listings.ts` `deleteListing` was one statement against a table
 * with 63 foreign keys pointing at it. 31 of those refused the delete with a raw
 * 23503; 16 more let it SUCCEED while clearing their pointers unseen.
 *
 * FOUR SECTIONS, EACH WITH A CONTROL THAT MUST GO RED:
 *
 *   1. MANIFEST COMPLETENESS — `LISTING_CHILD_RULES` vs `SCHEMA_FK_MAP`, which
 *      is generated from the live database. Both directions: no FK without a
 *      rule (that is the blind spot), no rule without an FK (that is a phantom).
 *      Controls: a manifest with one rule deleted, and one with a phantom rule
 *      added, are each run through the SAME checker and must fail.
 *
 *   2. ENGINE BEHAVIOUR — `deleteParentWithChildren` against an in-memory
 *      Supabase double: blocked / clean / detach-reported / refused-child /
 *      census-failed / wrong-tenant. supabase-js RESOLVES refusals (CLAUDE.md
 *      §3), so the double resolves them too rather than throwing — a double that
 *      threw would prove the opposite of what is being tested.
 *
 *   3. CALL-SITE SHAPE — source pins on `deleteListing`.
 *      THE POSITIVE CONTROL IS THE PRE-FIX FUNCTION ITSELF, frozen into this
 *      file as a specimen: every pin is re-run against it and each MUST fail.
 *      A finder that passes on both texts is not measuring anything. The
 *      specimen is embedded rather than read from `git show HEAD:…` because a
 *      control that inverts the moment the fix is committed is not a control.
 *
 *   4. SURVIVOR STILL WIRED — `rollbackTenantCreation` runs on the same engine
 *      (CLAUDE.md §6, one spelling) and its own behaviour is unchanged.
 *
 * Registered as `test:listing-delete`, so the guard sweep runs it: the manifest
 * drift check in section 1 is only worth anything if it runs unattended.
 * Run: npm run test:listing-delete
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { stripComments } from "./strip-comments"
import { LISTING_CHILD_RULES, deleteListingWithChildren } from "../lib/kernel/listing-delete"
import { deleteParentWithChildren } from "../lib/kernel/child-safe-delete"
import type { ChildRule, ParentDeletePlan } from "../lib/kernel/child-safe-delete"
import { rollbackTenantCreation, TENANT_CREATION_CHILD_TABLES } from "../lib/kernel/tenant-creation-rollback"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// The in-memory Supabase double.
// ═══════════════════════════════════════════════════════════════════════════
type Row = Record<string, any>
interface DbSpec {
  tables: Record<string, Row[]>
  /** table → error message, for proving a REFUSAL is read rather than swallowed. */
  refuse?: Record<string, string>
}

function makeService(spec: DbSpec) {
  const log: string[] = []
  const rows = (t: string) => (spec.tables[t] ??= [])

  function builder(table: string, mode: "select" | "delete", wantCount: boolean) {
    const preds: Array<[string, any]> = []
    const api: any = {
      eq(col: string, val: any) { preds.push([col, val]); return api },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode === "delete") { api._returning = true; return api }
        api._count = !!opts?.count
        return api
      },
      then(resolve: (v: any) => void) {
        const err = spec.refuse?.[table]
        const match = rows(table).filter((r) => preds.every(([c, v]) => r[c] === v))
        if (mode === "select") {
          log.push(`census ${table} ${JSON.stringify(preds)}`)
          if (err) return resolve({ data: null, count: null, error: { message: err } })
          return resolve({ data: [], count: match.length, error: null })
        }
        log.push(`delete ${table} ${JSON.stringify(preds)}`)
        if (err) return resolve({ data: null, count: null, error: { message: err } })
        spec.tables[table] = rows(table).filter((r) => !match.includes(r))
        return resolve({ data: match, count: wantCount ? match.length : null, error: null })
      },
    }
    return api
  }

  const service: any = {
    from(table: string) {
      return {
        select: (cols?: string, opts?: any) => builder(table, "select", false).select(cols, opts),
        delete: (opts?: { count?: string }) => builder(table, "delete", !!opts?.count),
      }
    },
  }
  return { service, log }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. MANIFEST COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════
function fkPairsToListings(): Set<string> {
  const out = new Set<string>()
  for (const [t, cols] of Object.entries(SCHEMA_FK_MAP as Record<string, Record<string, string>>))
    for (const [c, tgt] of Object.entries(cols)) if (tgt === "listings") out.add(`${t}.${c}`)
  return out
}

/** THE CHECKER. Both sections 1 and its own controls call exactly this. */
function auditManifest(rules: readonly ChildRule[]) {
  const fks = fkPairsToListings()
  const declared = rules.map((r) => `${r.table}.${r.column}`)
  const dupes = declared.filter((p, i) => declared.indexOf(p) !== i)
  const declaredSet = new Set(declared)
  const missing = [...fks].filter((p) => !declaredSet.has(p)).sort()
  const phantom = declared.filter((p) => !fks.has(p)).sort()
  return { fkCount: fks.size, declared: declared.length, missing, phantom, dupes }
}

function section1() {
  console.log("\n[1 · manifest completeness — denominator is SCHEMA_FK_MAP, generated from live]")
  const a = auditManifest(LISTING_CHILD_RULES)
  console.log(`      foreign keys → listings: ${a.fkCount}   rules declared: ${a.declared}`)
  const byDisp: Record<string, number> = {}
  for (const r of LISTING_CHILD_RULES) byDisp[r.disposition] = (byDisp[r.disposition] ?? 0) + 1
  console.log(`      dispositions: ${Object.entries(byDisp).map(([k, v]) => `${k}=${v}`).join("  ")}`)

  check("every FK onto listings has a disposition (no blind spot)", a.missing.length === 0, a.missing.join(", "))
  check("no rule names a pair that is not an FK onto listings (no phantom)", a.phantom.length === 0, a.phantom.join(", "))
  check("no pair declared twice", a.dupes.length === 0, a.dupes.join(", "))
  check("manifest size equals the live FK count", a.declared === a.fkCount, `${a.declared} vs ${a.fkCount}`)

  // ── POSITIVE CONTROLS: the checker must recognise both defects ────────────
  const dropped = LISTING_CHILD_RULES.filter((r) => r.table !== "transactions")
  const ctlA = auditManifest(dropped)
  check("CONTROL a manifest missing transactions.listing_id is caught",
    ctlA.missing.includes("transactions.listing_id"), JSON.stringify(ctlA.missing))

  const phantomRules: ChildRule[] = [...LISTING_CHILD_RULES,
    { table: "not_a_real_table", column: "listing_id", disposition: "remove" }]
  const ctlB = auditManifest(phantomRules)
  check("CONTROL a manifest with a phantom table is caught",
    ctlB.phantom.includes("not_a_real_table.listing_id"), JSON.stringify(ctlB.phantom))
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. ENGINE BEHAVIOUR
// ═══════════════════════════════════════════════════════════════════════════
const LID = "11111111-1111-1111-1111-111111111111"
const BID = "22222222-2222-2222-2222-222222222222"
const OTHER_BID = "33333333-3333-3333-3333-333333333333"

function baseDb(extra: Record<string, Row[]> = {}, refuse?: Record<string, string>): DbSpec {
  return { tables: { listings: [{ id: LID, brokerage_id: BID }], ...extra }, refuse }
}

async function section2() {
  console.log("\n[2 · engine behaviour — in-memory Supabase double, refusals RESOLVE as they do live]")

  // 2a — clean listing: remove-children go, listing goes, counts reported.
  {
    const spec = baseDb({
      listing_stage_history: [{ listing_id: LID }, { listing_id: LID }],
      listing_media: [{ listing_id: LID }],
    })
    const { service, log } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, BID)
    check("clean listing is deleted", r.ok, r.error ?? "")
    check("  its stage history went with it (2)", r.outcome.childrenRemoved.listing_stage_history === 2)
    check("  its media went with it (1)", r.outcome.childrenRemoved.listing_media === 1)
    check("  the listings row is gone", spec.tables.listings.length === 0)
    const li = log.findIndex((l) => l.startsWith("delete listings"))
    const ch = log.findIndex((l) => l.startsWith("delete listing_stage_history"))
    check("  children were deleted BEFORE the parent", ch >= 0 && li >= 0 && ch < li)
  }

  // 2b — BLOCKED: somebody else's record refuses the delete and is named.
  {
    const spec = baseDb({ tasks: [{ listing_id: LID }, { listing_id: LID }, { listing_id: LID }],
                          listing_metrics: [{ listing_id: LID }] })
    const { service, log } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, BID)
    check("a listing with tasks is REFUSED", !r.ok && r.outcome.reason === "blocked")
    check("  the refusal names the table and the count", !!r.error?.includes("tasks (3)"), r.error ?? "")
    check("  the listings row survives", spec.tables.listings.length === 1)
    check("  NOTHING was removed on a refused delete", !log.some((l) => l.startsWith("delete ")),
      log.filter((l) => l.startsWith("delete ")).join(" | "))
  }

  // 2c — DETACH is counted and reported, not assumed away.
  {
    const spec = baseDb({ transactions: [{ listing_id: LID }], documents: [{ listing_id: LID }, { listing_id: LID }] })
    const { service } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, BID)
    check("a listing whose only children detach is deleted", r.ok, r.error ?? "")
    check("  the surviving transaction is reported (1)", r.outcome.detached.transactions === 1)
    check("  the surviving documents are reported (2)", r.outcome.detached.documents === 2)
    check("  detached rows were NOT deleted", spec.tables.transactions.length === 1)
  }

  // 2d — a REFUSED child delete is read, not swallowed (CLAUDE.md §3).
  {
    const spec = baseDb({ listing_metrics: [{ listing_id: LID }] }, { listing_metrics: "23503 refused" })
    const { service } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, BID)
    check("a refused CHILD delete is recorded with its message",
      r.outcome.childRefusals.some((f) => f.includes("listing_metrics") && f.includes("23503")),
      JSON.stringify(r.outcome.childRefusals))
  }

  // 2e — FAIL CLOSED: a blocker census that cannot RUN refuses (CLAUDE.md §4).
  {
    const spec = baseDb({}, { tasks: "permission denied for table tasks" })
    const { service, log } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, BID)
    check("a blocker census that cannot run REFUSES", !r.ok && r.outcome.reason === "census-failed")
    check("  the reason names the table that could not be checked",
      !!r.error?.includes("tasks"), r.error ?? "")
    check("  nothing was deleted when the check could not run",
      !log.some((l) => l.startsWith("delete ")), log.filter((l) => l.startsWith("delete ")).join(" | "))
    check("  the listings row survives", spec.tables.listings.length === 1)
  }

  // 2f — TENANCY: another tenant's id deletes nothing and does NOT report success.
  {
    const spec = baseDb()
    const { service } = makeService(spec)
    const r = await deleteListingWithChildren(service, LID, OTHER_BID)
    check("a listing id under the WRONG tenant is not reported deleted", !r.ok, JSON.stringify(r.outcome))
    check("  the listings row survives the wrong-tenant delete", spec.tables.listings.length === 1)
  }

  // 2g — FAIL CLOSED on a missing session tenant.
  {
    const { service } = makeService(baseDb())
    const r = await deleteListingWithChildren(service, LID, "")
    check("no session tenant → refused before any query", !r.ok && !!r.error?.includes("workspace"))
  }

  // ── POSITIVE CONTROL for section 2 ───────────────────────────────────────
  // The pre-fix delete was `.from("listings").delete().eq(id).eq(brokerage_id)`
  // and nothing else. Replay that exact shape as a plan with NO child rules and
  // prove the harness reports the orphan the old code left: a live `tasks` row
  // still pointing at a listing that is gone.
  {
    const spec = baseDb({ tasks: [{ listing_id: LID }] })
    const { service } = makeService(spec)
    const childBlind: ParentDeletePlan = { parentTable: "listings", children: [] }
    const r = await deleteParentWithChildren(service, childBlind, LID, { brokerage_id: BID })
    check("CONTROL the pre-fix child-blind plan deletes the listing anyway", r.ok)
    check("CONTROL it strands a live tasks row pointing at a deleted listing",
      spec.tables.listings.length === 0 && spec.tables.tasks.length === 1 && spec.tables.tasks[0].listing_id === LID)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CALL-SITE SHAPE — the control is the PRE-FIX FILE
// ═══════════════════════════════════════════════════════════════════════════
interface Pin { name: string; holds: (body: string) => boolean }

function deleteListingBody(fileText: string): string {
  // stripComments so a pin can never be satisfied by prose ABOUT the fix
  // (CLAUDE.md §2 — the one correct scanner, never a hand-rolled one).
  const src = stripComments(fileText)
  const start = src.indexOf("export async function deleteListing")
  if (start < 0) return ""
  const rest = src.slice(start)
  const next = rest.slice(1).search(/\nexport (async )?function /)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

const PINS: Pin[] = [
  { name: "does not hard-delete listings inline",
    holds: (b) => !/\.from\(\s*["']listings["']\s*\)\s*\n?\s*\.delete\(/.test(b) },
  { name: "routes through deleteListingWithChildren",
    holds: (b) => b.includes("deleteListingWithChildren") },
  { name: "verifies the row's brokerage against the session tenant",
    holds: (b) => /brokerage_id\s*!==\s*auth\.brokerageId/.test(b) },
  { name: "reads the ownership read's error",
    holds: (b) => /ownedErr/.test(b) },
  { name: "reports what was removed and what was detached",
    holds: (b) => b.includes("childrenRemoved") && b.includes("detached") },
]

/**
 * THE FROZEN SPECIMEN — `deleteListing` exactly as it stood at b0217776, the
 * commit this lane started from.
 *
 * It is embedded rather than read back with `git show HEAD:…` for the reason
 * that makes most positive controls rot: once the fix is COMMITTED, HEAD holds
 * the fixed file, the control inverts, and a guard that was proving something
 * starts failing for a reason that has nothing to do with the defect. A control
 * whose meaning depends on where HEAD happens to point is not a control. This
 * text never changes, so "the pins can still see the defect" stays a live claim
 * for as long as the pins exist.
 */
const PRE_FIX_SPECIMEN = `
export async function deleteListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }

    const supabase = createServiceClient()

    const { error } = await supabase
      .from("listings")
      .delete()
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteListing")
  }
}
`

function section3() {
  console.log("\n[3 · call-site shape — every pin re-run against the frozen PRE-FIX specimen]")
  const now = deleteListingBody(read("app/actions/listings.ts"))
  check("deleteListing was located in the current file", now.length > 0)

  const before = deleteListingBody(PRE_FIX_SPECIMEN)
  check("the frozen specimen still parses as a deleteListing body", before.length > 0)

  // The specimen must match what the repo actually shipped. While the fix is
  // uncommitted that is HEAD; once it is committed HEAD has moved on and this
  // corroboration is skipped rather than inverted — see the note above.
  try {
    const head = deleteListingBody(
      execFileSync("git", ["show", "HEAD:app/actions/listings.ts"], { cwd: ROOT, encoding: "utf8" }))
    if (head && !PINS.every((p) => p.holds(head))) {
      check("the frozen specimen matches the pre-fix HEAD it was taken from",
        head.replace(/\s+/g, " ").trim() === before.replace(/\s+/g, " ").trim(),
        "specimen has drifted from HEAD")
    } else {
      console.log("  · HEAD already carries the fix — specimen corroboration skipped (by design)")
    }
  } catch {
    console.log("  · git unavailable — specimen corroboration skipped")
  }

  for (const p of PINS) {
    check(`now: ${p.name}`, p.holds(now))
    check(`CONTROL the pre-fix specimen FAILS: ${p.name}`, before.length > 0 && !p.holds(before))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SURVIVOR STILL WIRED
// ═══════════════════════════════════════════════════════════════════════════
async function section4() {
  console.log("\n[4 · the survivor still behaves — one engine, two manifests (CLAUDE.md §6)]")
  const rollbackSrc = stripComments(read("lib/kernel/tenant-creation-rollback.ts"))
  check("rollbackTenantCreation runs on the extracted engine",
    rollbackSrc.includes("deleteParentWithChildren"))
  check("it no longer carries its own delete loop",
    !/for\s*\(\s*const table of TENANT_CREATION_CHILD_TABLES\s*\)/.test(rollbackSrc))
  check("its manifest is untouched (10 tables, users last)",
    TENANT_CREATION_CHILD_TABLES.length === 10 &&
    TENANT_CREATION_CHILD_TABLES[TENANT_CREATION_CHILD_TABLES.length - 1] === "users")

  {
    const spec: DbSpec = { tables: { brokerages: [{ id: BID }], users: [{ brokerage_id: BID }], teams: [{ brokerage_id: BID }] } }
    const { service, log } = makeService(spec)
    const r = await rollbackTenantCreation(service, BID)
    check("a half-built tenant still rolls back", r.ok, r.error ?? "")
    check("  its users row went with it", r.childrenRemoved.users === 1)
    check("  teams was deleted before users", log.indexOf("delete teams [[\"brokerage_id\",\"" + BID + "\"]]") <
      log.indexOf("delete users [[\"brokerage_id\",\"" + BID + "\"]]"))
    check("  the brokerages row is gone", spec.tables.brokerages.length === 0)
  }
  {
    const spec: DbSpec = { tables: { brokerages: [{ id: BID }] }, refuse: { brokerages: "23503 still referenced" } }
    const { service } = makeService(spec)
    const r = await rollbackTenantCreation(service, BID)
    check("a REFUSED brokerage delete still fails loudly and names the id",
      !r.ok && !!r.error?.includes(BID) && r.error.includes("23503"), r.error ?? "")
  }
  {
    const { service } = makeService({ tables: {} })
    const r = await rollbackTenantCreation(service, "")
    check("no brokerage id → refuses (unchanged)", !r.ok && !!r.error?.includes("no workspace id"))
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing delete — child-blindness simulator")
  console.log("══════════════════════════════════════════════════")
  section1()
  await section2()
  section3()
  await section4()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOTS, stated:")
  console.log("   • The FK denominator is SCHEMA_FK_MAP (63 pairs → listings), which is")
  console.log("     generated, not live-read. A key added since the last regeneration is")
  console.log("     invisible to section 1 in BOTH directions.")
  console.log("   • Dispositions are not derivable from SCHEMA_FK_MAP (it carries no")
  console.log("     delete rule), so section 1 proves COVERAGE, not that each choice")
  console.log("     matches the live ON DELETE rule. The manifest header carries the")
  console.log("     live measurement those choices were made from, dated.")
  console.log("   • listing_media storage blobs are not cleaned up — row-level only.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" LISTING_DELETE_FAIL")
    process.exit(1)
  }
  console.log(" ✅ deleteListing sees all 63 children: refuses for 20, removes 11, reports 16 detached, 16 cascade.")
  console.log(" LISTING_DELETE_PASS")
  process.exit(0)
}

main()
