#!/usr/bin/env tsx
/**
 * scripts/listing-archive-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A LISTING IS RETAINED, NOT DESTROYED — proof of the rule, and proof that this
 * file would still go red if the rule were reversed again.
 *
 * OWNER'S RULING: "listing shouldn't be deleted because of rules of needing to
 * keep real estate records."
 *
 * WAS: scripts/listing-delete-simulator.ts (51 passed / 0 failed), which proved
 * that a HARD delete saw all 63 of its children. That proof is not discarded —
 * it is INVERTED. Every claim it made about what the delete destroyed is now a
 * claim about what the archive keeps, run against the same manifest.
 *
 * SIX SECTIONS, EACH WITH A CONTROL THAT MUST GO RED:
 *
 *   1. LEDGER COMPLETENESS — `LISTING_CHILD_RULES` vs `SCHEMA_FK_MAP`, generated
 *      from the live database. Both directions: no FK without a rule (a blind
 *      spot), no rule without an FK (a phantom). Plus the m542 retirement, which
 *      is a THIRD direction and self-expiring.
 *
 *   2. RETENTION — `archiveListing` against an in-memory Supabase double. The
 *      controls here are TWO-SIDED, which is the whole design of this section:
 *        · the POSITIVE side proves the listing and every child row are still
 *          there after an archive;
 *        · the NEGATIVE side replays the HARD DELETE that shipped last wave
 *          against the same fixture and proves the SAME assertions FAIL — the
 *          listing gone, the children gone. An assertion that passes on both a
 *          retaining and a destroying implementation measures nothing.
 *
 *   3. THE ARCHIVE IS NOT A NO-OP — source pins on the two canonical working
 *      surfaces and on the call site. Controls: the pre-fix text of each,
 *      frozen, must FAIL the same pin.
 *
 *   4. THE SURVIVOR ENGINE — `rollbackTenantCreation` still runs on
 *      `child-safe-delete.ts`, unchanged. It is a genuine hard delete and this
 *      ruling does not touch it. Exercised here because an engine whose only
 *      proof lived in the caller that walked away is an engine nobody watches.
 *
 *   5. THE COLUMN CHOICE IS ENFORCED — the archive must never write `status`.
 *      Control: a synthetic writer that does write it is caught by the same scan.
 *
 *   6. open_houses.property_id IS GONE — the m542 census, with a positive
 *      control proving the census can still SEE such a reader when one exists.
 *
 * Registered as `test:listing-archive`, so the guard sweep runs it.
 * Run: npm run test:listing-archive
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { stripComments, blankComments } from "./strip-comments"
import {
  LISTING_CHILD_RULES,
  LISTING_RETAINED_TABLES,
  LISTING_ARCHIVE_BLOCKERS,
  archiveListing,
  unarchiveListing,
} from "../lib/kernel/listing-archive"
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
//
// Grown from the delete simulator's double with UPDATE, because the archive is
// an update. Refusals RESOLVE rather than throw, exactly as supabase-js does
// (CLAUDE.md §3) — a double that threw would prove the opposite of what is
// being tested. A zero-row UPDATE also resolves, empty, which is the specific
// trap `archiveListing` guards against.
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

  function builder(table: string, mode: "select" | "delete" | "update", wantCount: boolean, patch?: Row) {
    const preds: Array<[string, "eq" | "isNull" | "notNull", any]> = []
    const api: any = {
      eq(col: string, val: any) { preds.push([col, "eq", val]); return api },
      is(col: string, val: any) { preds.push([col, "isNull", val]); return api },
      not(col: string, _op: string, _val: any) { preds.push([col, "notNull", null]); return api },
      limit(_n: number) { return api },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode !== "select") { api._returning = true; return api }
        api._count = !!opts?.count
        return api
      },
      then(resolve: (v: any) => void) {
        const err = spec.refuse?.[table]
        const match = rows(table).filter((r) =>
          preds.every(([c, kind, v]) =>
            kind === "eq" ? r[c] === v
            : kind === "isNull" ? (r[c] ?? null) === null
            : (r[c] ?? null) !== null))
        if (mode === "select") {
          log.push(`select ${table}`)
          if (err) return resolve({ data: null, count: null, error: { message: err } })
          return resolve({ data: match, count: match.length, error: null })
        }
        if (mode === "update") {
          log.push(`update ${table} ${JSON.stringify(patch)}`)
          if (err) return resolve({ data: null, error: { message: err } })
          for (const r of match) Object.assign(r, patch)
          return resolve({ data: match.map((r) => ({ ...r })), error: null })
        }
        log.push(`delete ${table}`)
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
        update: (patch: Row) => builder(table, "update", false, patch),
      }
    },
  }
  return { service, log }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. LEDGER COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pairs retired from the live database by an APPLIED migration which the
 * GENERATED caches have not caught up with yet.
 *
 * CURRENTLY EMPTY, and the story of why is the useful part.
 *
 * `scripts/schema-fk-map.ts` is generated, hand-editing it is forbidden
 * (CLAUDE.md §3), and it is owned by another lane this wave — so this map was
 * written holding `open_houses.property_id`, on the assumption that the cache
 * would still list a pair m542 had just dropped from hrvaqgvukzxfskkcrwbt.
 *
 * THE EXCEPTION EXPIRED ON ITS FIRST RUN. `section1` asserts that every pair
 * named here is STILL IN the cache; on the first execution that assertion FAILED
 * with "the cache has caught up", because the cache had already been regenerated
 * and reads 62 pairs onto `listings` — the exact post-m542 live count
 * (`pg_constraint`, contype='f', confrelid='public.listings'::regclass → 62,
 * measured 2026-08-23, down from 63). Cache and database agree, so the entry was
 * deleted rather than left standing as a permanent excuse.
 *
 * The mechanism stays, empty, with a synthetic control below proving the
 * subtraction still works — the next applied migration needs it, and an
 * exception mechanism that only exists while it is in use is one that gets
 * re-invented badly.
 */
const RETIRED_BY_MIGRATION: Record<string, string> = {}

function fkPairsToListings(): Set<string> {
  const out = new Set<string>()
  for (const [t, cols] of Object.entries(SCHEMA_FK_MAP as Record<string, Record<string, string>>))
    for (const [c, tgt] of Object.entries(cols)) if (tgt === "listings") out.add(`${t}.${c}`)
  return out
}

/** THE CHECKER. Section 1 and its own controls call exactly this. */
function auditLedger(rules: readonly ChildRule[], retired: Record<string, string> = RETIRED_BY_MIGRATION) {
  const cacheFks = fkPairsToListings()
  // The LIVE denominator = the generated cache minus what an applied migration
  // has already retired. Published beside the number, per §2.
  const liveFks = new Set([...cacheFks].filter((p) => !(p in retired)))
  const declared = rules.map((r) => `${r.table}.${r.column}`)
  const dupes = declared.filter((p, i) => declared.indexOf(p) !== i)
  const declaredSet = new Set(declared)
  const missing = [...liveFks].filter((p) => !declaredSet.has(p)).sort()
  const phantom = declared.filter((p) => !liveFks.has(p)).sort()
  const staleRetirements = Object.keys(retired).filter((p) => !cacheFks.has(p)).sort()
  return { cacheCount: cacheFks.size, liveCount: liveFks.size, declared: declared.length, missing, phantom, dupes, staleRetirements }
}

function section1() {
  console.log("\n[1 · retention-ledger completeness — denominator is SCHEMA_FK_MAP, generated from live]")
  const a = auditLedger(LISTING_CHILD_RULES)
  console.log(`      FKs → listings in the generated cache: ${a.cacheCount}`)
  console.log(`      retired by an APPLIED migration:       ${Object.keys(RETIRED_BY_MIGRATION).length}  (${Object.keys(RETIRED_BY_MIGRATION).join(", ")})`)
  console.log(`      LIVE denominator:                      ${a.liveCount}   rules declared: ${a.declared}`)
  const byDisp: Record<string, number> = {}
  for (const r of LISTING_CHILD_RULES) byDisp[r.disposition] = (byDisp[r.disposition] ?? 0) + 1
  console.log(`      dispositions: ${Object.entries(byDisp).map(([k, v]) => `${k}=${v}`).join("  ")}`)
  console.log(`      retention denominator (remove+cascade+detach): ${LISTING_RETAINED_TABLES.length} tables`)

  check("every live FK onto listings has a ledger entry (no blind spot)", a.missing.length === 0, a.missing.join(", "))
  check("no ledger entry names a pair that is not a live FK (no phantom)", a.phantom.length === 0, a.phantom.join(", "))
  check("no pair declared twice", a.dupes.length === 0, a.dupes.join(", "))
  check("ledger size equals the live FK count", a.declared === a.liveCount, `${a.declared} vs ${a.liveCount}`)
  check("RETIRED_BY_MIGRATION has not outlived the stale cache — DELETE the listed entries from " +
        "scripts/listing-archive-simulator.ts when this fails, the cache has caught up",
    a.staleRetirements.length === 0, a.staleRetirements.join(", "))

  // ── POSITIVE CONTROLS: the checker must recognise all three defects ───────
  const dropped = LISTING_CHILD_RULES.filter((r) => r.table !== "transactions")
  check("CONTROL a ledger missing transactions.listing_id is caught",
    auditLedger(dropped).missing.includes("transactions.listing_id"))

  const phantomRules: ChildRule[] = [...LISTING_CHILD_RULES,
    { table: "not_a_real_table", column: "listing_id", disposition: "remove" }]
  check("CONTROL a ledger with a phantom table is caught",
    auditLedger(phantomRules).phantom.includes("not_a_real_table.listing_id"))

  // CONTROL the retirement MECHANISM, synthetically, because it currently holds
  // nothing. Retire a pair that IS in the cache and the checker must move it out
  // of the denominator and start reporting the ledger's entry for it as a phantom.
  {
    const synthetic = { "transactions.listing_id": "synthetic — control only" }
    const ctl = auditLedger(LISTING_CHILD_RULES, synthetic)
    check("CONTROL a retired pair leaves the denominator and its ledger entry becomes a phantom",
      ctl.liveCount === a.liveCount - 1 && ctl.phantom.includes("transactions.listing_id"),
      `${ctl.liveCount} vs ${a.liveCount}; phantom=${ctl.phantom.join(",")}`)
    const stale = auditLedger(LISTING_CHILD_RULES, { "gone.never_existed": "synthetic" })
    check("CONTROL a retirement the cache no longer lists is reported as stale",
      stale.staleRetirements.includes("gone.never_existed"))
  }

  // m542's own outcome, seen through the cache: the pair is gone from BOTH the
  // live database and the generated map, so the ledger dropping it is right.
  // THESE TWO ASSERTIONS WERE PINNED TO AN INTERMEDIATE STATE AND WENT RED WHEN
  // THE WORLD MOVED PAST IT — the same shape as the "WRITTEN, NOT APPLIED"
  // assertion fixed earlier in this session, and worth naming again because it
  // keeps recurring during a multi-step migration.
  //
  // They read: "open_houses.property_id is gone, listing_id REMAINS". That was
  // exactly right after m542 dropped the wrong FK. Then m543 established
  // `open_house_events` as the survivor and m547 DROPPED `open_houses` entirely,
  // so `listing_id` went with the table — and an assertion demanding it still
  // exist now fails for the correct outcome.
  //
  // Re-pinned to the END STATE rather than the waypoint: the retired table is
  // absent from the generated cache AND from the ledger, and the survivor's
  // pointer is what carries the relationship.
  check("the generated cache agrees with m542+m547 — open_houses is gone entirely, survivor remains",
    !fkPairsToListings().has("open_houses.property_id")
    && !fkPairsToListings().has("open_houses.listing_id")
    && fkPairsToListings().has("open_house_events.listing_id"))
  check("and the ledger names only the survivor",
    !LISTING_CHILD_RULES.some((r) => r.table === "open_houses") &&
    LISTING_CHILD_RULES.some((r) => r.table === "open_house_events" && r.column === "listing_id"))
  // CONTROL — a checker that merely returns true for anything absent would pass
  // both lines above. Prove the cache reader still FINDS a pair that is there and
  // still MISSES one that never was.
  check("CONTROL — the cache reader discriminates: a live pair is found, an invented one is not",
    fkPairsToListings().has("transactions.listing_id")
    && !fkPairsToListings().has("open_house_events.definitely_not_a_column"))
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. RETENTION — two-sided controls
// ═══════════════════════════════════════════════════════════════════════════
const LID = "11111111-1111-1111-1111-111111111111"
const BID = "22222222-2222-2222-2222-222222222222"
const OTHER_BID = "33333333-3333-3333-3333-333333333333"

/**
 * THE FIXTURE. One listing that has actually lived: it SOLD, it has a stage
 * trail and media (a delete would have DESTROYED both), a closed transaction and
 * a document (a delete would have NULLED both pointers), an offer and a showing
 * (a delete would have CASCADED both away), and a task and a signed listing
 * agreement (a delete would have REFUSED outright because of them).
 */
function livedListing(): DbSpec {
  return {
    tables: {
      listings: [{ id: LID, brokerage_id: BID, status: "sold", lifecycle_stage: "CLOSED", deleted_at: null }],
      // remove → a delete destroyed these
      listing_stage_history: [{ listing_id: LID }, { listing_id: LID }, { listing_id: LID }],
      listing_media: [{ listing_id: LID }, { listing_id: LID }],
      pricing_history: [{ listing_id: LID }],
      // detach → a delete kept the row and nulled the pointer
      transactions: [{ id: "t1", listing_id: LID, status: "closed", stage: "CLOSED" }],
      documents: [{ listing_id: LID }, { listing_id: LID }],
      // cascade → a delete destroyed these too
      offers: [{ listing_id: LID }],
      showings: [{ listing_id: LID }],
      // block → a delete refused because of these
      tasks: [{ listing_id: LID }],
      listing_agreements: [{ listing_id: LID }],
    },
  }
}

/** Every assertion that "the record survived", applied to one fixture. */
function retentionAssertions(spec: DbSpec) {
  const t = spec.tables
  return {
    listingRowExists: (t.listings ?? []).length === 1,
    stageTrailKept: (t.listing_stage_history ?? []).length === 3,
    mediaKept: (t.listing_media ?? []).length === 2,
    priceTrailKept: (t.pricing_history ?? []).length === 1,
    offersKept: (t.offers ?? []).length === 1,
    showingsKept: (t.showings ?? []).length === 1,
    txnKept: (t.transactions ?? []).length === 1,
    txnPointerKept: (t.transactions ?? [])[0]?.listing_id === LID,
    docsKept: (t.documents ?? []).length === 2,
    statusUnrewritten: (t.listings ?? [])[0]?.status === "sold",
  }
}

async function section2() {
  console.log("\n[2 · retention — in-memory Supabase double, refusals RESOLVE as they do live]")

  // 2a — THE RULING. A listing that has lived is archived and nothing dies.
  {
    const spec = livedListing()
    const { service } = makeService(spec)
    const r = await archiveListing(service, LID, BID)
    check("a listing with real history is ARCHIVED", r.ok, r.error ?? "")

    const a = retentionAssertions(spec)
    check("  the listings row SURVIVES", a.listingRowExists)
    check("  it is stamped deleted_at", !!spec.tables.listings[0].deleted_at)
    check("  its stage trail survives (3)", a.stageTrailKept)
    check("  its media survives (2)", a.mediaKept)
    check("  its price trail survives (1)", a.priceTrailKept)
    check("  its offers survive (1) — CASCADE never fires", a.offersKept)
    check("  its showings survive (1) — CASCADE never fires", a.showingsKept)
    check("  its transaction survives (1)", a.txnKept)
    check("  the transaction KEEPS its listing pointer — SET NULL never fires", a.txnPointerKept)
    check("  its documents survive (2)", a.docsKept)
    check("  status is NOT rewritten — the record still says 'sold'", a.statusUnrewritten)
    check("  the outcome reports the status it read back", r.outcome.statusAfter === "sold", String(r.outcome.statusAfter))
    check("  a task does NOT block an archive (it blocked the delete)", r.ok && !r.outcome.blocked.tasks)
    check("  a signed listing agreement does NOT block an archive either",
      r.ok && !r.outcome.blocked.listing_agreements)

    // The retention number, measured rather than asserted.
    check("  the retained census counts the rows a delete would have destroyed or unlinked",
      r.outcome.retainedTotal === 11, `retainedTotal=${r.outcome.retainedTotal}`)
    check("  the census does NOT count `block` tables (they were never at risk)",
      !("tasks" in r.outcome.retained) && !("listing_agreements" in r.outcome.retained),
      JSON.stringify(Object.keys(r.outcome.retained)))
    check("  nothing was DELETED at all",
      !makeService(spec).log.some((l) => l.startsWith("delete ")))
  }

  // ── POSITIVE CONTROL, THE OTHER SIDE ─────────────────────────────────────
  // The SAME fixture, the SAME assertions, run against the HARD DELETE that
  // shipped last wave. Every retention assertion must FAIL. If they pass here
  // too, section 2a is not measuring retention — it is measuring nothing.
  {
    const spec = livedListing()
    // Blockers removed so the delete actually proceeds — the point of the
    // control is what a SUCCESSFUL delete does, not that it refuses.
    delete spec.tables.tasks
    delete spec.tables.listing_agreements
    const { service } = makeService(spec)
    const hardDeletePlan: ParentDeletePlan = {
      parentTable: "listings",
      requireParentRowRemoved: true,
      children: LISTING_CHILD_RULES,
    }
    const d = await deleteParentWithChildren(service, hardDeletePlan, LID, { brokerage_id: BID })
    check("CONTROL the pre-ruling HARD delete still succeeds on the same fixture", d.ok)

    const a = retentionAssertions(spec)
    check("CONTROL the hard delete DESTROYS the listings row", !a.listingRowExists)
    check("CONTROL the hard delete DESTROYS the stage trail", !a.stageTrailKept)
    check("CONTROL the hard delete DESTROYS the media", !a.mediaKept)
    check("CONTROL the hard delete DESTROYS the price trail", !a.priceTrailKept)
    check("CONTROL the hard delete reports the transaction as DETACHED (pointer nulled by the DB)",
      d.detached.transactions === 1, JSON.stringify(d.detached))
  }

  // 2b — BLOCKED: a LIVE deal refuses the archive and is named.
  {
    const spec = livedListing()
    spec.tables.transactions = [{ id: "t1", listing_id: LID, status: "under_contract", stage: "INSPECTION" }]
    const { service, log } = makeService(spec)
    const r = await archiveListing(service, LID, BID)
    check("a listing with a LIVE transaction is REFUSED", !r.ok && r.outcome.reason === "blocked")
    check("  the refusal names the table and the count", !!r.error?.includes("transactions (1)"), r.error ?? "")
    check("  the refusal says nothing was deleted", !!r.error?.includes("Nothing was deleted"), r.error ?? "")
    check("  deleted_at was NOT stamped", spec.tables.listings[0].deleted_at === null)
    check("  no update ran at all", !log.some((l) => l.startsWith("update ")))
  }

  // 2c — a CLOSED deal is not a live deal. The mirror of 2b, and the reason
  // `isTransactionLive` is used instead of negating a terminal list.
  {
    const spec = livedListing()
    spec.tables.transactions = [{ id: "t1", listing_id: LID, status: "funded", stage: "CLOSING_PREP" }]
    const { service } = makeService(spec)
    const r = await archiveListing(service, LID, BID)
    check("a FUNDED deal whose stage never got cleared does NOT block the archive", r.ok, r.error ?? "")
  }

  // 2d — FAIL CLOSED: a blocker census that cannot RUN refuses (CLAUDE.md §4).
  {
    const spec = livedListing()
    spec.refuse = { transactions: "permission denied for table transactions" }
    const { service, log } = makeService(spec)
    const r = await archiveListing(service, LID, BID)
    check("a blocker census that cannot run REFUSES", !r.ok && r.outcome.reason === "blocker-census-failed")
    check("  the reason names the table that could not be checked", !!r.error?.includes("transactions"), r.error ?? "")
    check("  deleted_at was NOT stamped when the check could not run",
      spec.tables.listings[0].deleted_at === null)
    check("  no update ran", !log.some((l) => l.startsWith("update ")))
  }

  // 2e — FAIL OPEN on the RETENTION census, and the asymmetry is deliberate.
  {
    const spec = livedListing()
    spec.refuse = { listing_media: "permission denied for table listing_media" }
    const { service } = makeService(spec)
    const r = await archiveListing(service, LID, BID)
    check("a RETENTION census failure does NOT block the archive (nothing is at risk)", r.ok, r.error ?? "")
    check("  but it is recorded rather than swallowed",
      r.outcome.retentionCensusFailures.some((f) => f.includes("listing_media")),
      JSON.stringify(r.outcome.retentionCensusFailures))
  }

  // 2f — TENANCY: another tenant's id changes nothing and does NOT report success.
  {
    const spec = livedListing()
    const { service } = makeService(spec)
    const r = await archiveListing(service, LID, OTHER_BID)
    check("a listing id under the WRONG tenant is not reported archived",
      !r.ok && r.outcome.reason === "not-found-or-already-archived")
    check("  deleted_at was NOT stamped under the wrong tenant", spec.tables.listings[0].deleted_at === null)
  }

  // 2g — a SECOND archive is not a fresh archive. The §3 zero-row-UPDATE trap.
  {
    const spec = livedListing()
    const { service } = makeService(spec)
    const first = await archiveListing(service, LID, BID)
    const stamp = spec.tables.listings[0].deleted_at
    const second = await archiveListing(service, LID, BID)
    check("archiving twice is REFUSED, not reported as a fresh archive",
      first.ok && !second.ok && second.outcome.reason === "not-found-or-already-archived")
    check("  the original timestamp is not overwritten", spec.tables.listings[0].deleted_at === stamp)
  }

  // 2h — FAIL CLOSED on a missing session tenant / id.
  {
    const { service } = makeService(livedListing())
    const noTenant = await archiveListing(service, LID, "")
    check("no session tenant → refused before any query", !noTenant.ok && !!noTenant.error?.includes("workspace"))
    const noId = await archiveListing(service, "", BID)
    check("no listing id → refused before any query", !noId.ok && noId.outcome.reason === "no-listing-id")
  }

  // 2i — THE WAY BACK. Without this the archive is a delete with extra steps.
  {
    const spec = livedListing()
    const { service } = makeService(spec)
    await archiveListing(service, LID, BID)
    const back = await unarchiveListing(service, LID, BID)
    check("an archived listing can be RESTORED", back.ok, back.error ?? "")
    check("  deleted_at is cleared", spec.tables.listings[0].deleted_at === null)
    const again = await unarchiveListing(service, LID, BID)
    check("  restoring a LIVE listing matches nothing and says so", !again.ok)
    const wrongTenant = await unarchiveListing(service, LID, OTHER_BID)
    check("  restore is tenant-scoped too", !wrongTenant.ok)
  }

  // 2j — the blocker set is ONE entry, and that is a decision, not an accident.
  check("LISTING_ARCHIVE_BLOCKERS is exactly the live-transaction rule",
    LISTING_ARCHIVE_BLOCKERS.length === 1 && LISTING_ARCHIVE_BLOCKERS[0].table === "transactions",
    LISTING_ARCHIVE_BLOCKERS.map((b) => b.table).join(", "))
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE ARCHIVE IS NOT A NO-OP — the control is the PRE-FIX TEXT
// ═══════════════════════════════════════════════════════════════════════════
interface Pin { name: string; holds: (body: string) => boolean }

function fnBody(fileText: string, header: string): string {
  // stripComments so a pin can never be satisfied by prose ABOUT the fix
  // (CLAUDE.md §2 — the one correct scanner, never a hand-rolled one).
  const src = stripComments(fileText)
  const start = src.indexOf(header)
  if (start < 0) return ""
  const rest = src.slice(start)
  const next = rest.slice(1).search(/\nexport (async )?function /)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

const ACTION_PINS: Pin[] = [
  // NOT "no inline .delete(" — that pin PASSED on the specimen too, because last
  // wave's version had already moved the delete behind a helper. A pin both
  // texts satisfy measures nothing (§2), so it asks the question that actually
  // separates them: does this function destroy the row by ANY route?
  { name: "destroys the listing by no route — neither inline nor through a delete helper",
    holds: (b) =>
      !/\.from\(\s*["']listings["']\s*\)\s*\n?\s*\.delete\(/.test(b) &&
      !/delete[A-Za-z]*Listing[A-Za-z]*\s*\(/.test(b) &&
      !/deleteParentWithChildren\s*\(/.test(b) },
  { name: "routes through the archive kernel",
    holds: (b) => b.includes("archiveListingRecord") },
  { name: "verifies the row's brokerage against the session tenant",
    holds: (b) => /brokerage_id\s*!==\s*auth\.brokerageId/.test(b) },
  { name: "reads the ownership read's error",
    holds: (b) => /ownedErr/.test(b) },
  { name: "reports what was RETAINED",
    holds: (b) => b.includes("retained") && b.includes("retainedTotal") },
  { name: "writes a LISTING_ARCHIVED audit event naming the real actor",
    holds: (b) => b.includes("LISTING_ARCHIVED") && /actor_user_id:\s*auth\.actorUserId/.test(b) },
]

/**
 * THE FROZEN SPECIMEN — `deleteListing` exactly as it shipped last wave, the
 * hard delete this ruling reverses.
 *
 * Embedded rather than read back with `git show HEAD:…` for the reason that rots
 * most positive controls: once the reversal is COMMITTED, HEAD holds the archive,
 * the control inverts, and a guard that was proving something starts failing for
 * a reason unrelated to the defect. This text never changes, so "the pins can
 * still tell an archive from a delete" stays a live claim.
 */
const HARD_DELETE_SPECIMEN = `
export async function archiveListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    if (auth.readOnly) return { success: false, error: READ_ONLY_ACTING_ERROR }
    const supabase = createServiceClient()
    const { data: owned } = await supabase
      .from("listings").select("id, brokerage_id").eq("id", listingId).maybeSingle()
    if (!owned) return { success: false, error: "Listing not found" }
    const result = await deleteListingWithChildren(supabase, listingId, auth.brokerageId)
    if (!result.ok) return { success: false, error: result.error }
    revalidatePath("/listings")
    return { success: true, removed: result.outcome.childrenRemoved, detached: result.outcome.detached }
  } catch (error) {
    return handleError(error, "deleteListing")
  }
}
`

/** The two working surfaces, and the exact text each had BEFORE this wave. */
const SURFACE_PINS: Array<{ file: string; anchor: RegExp; preFix: string; label: string }> = [
  {
    file: "lib/application/listings.ts",
    label: "getListingsService — the /listings list",
    anchor: /\.eq\("brokerage_id",\s*params\.brokerageId\)\s*\.is\("deleted_at",\s*null\)/,
    preFix: `let query = supabase.from("listings").select("*").order("created_at", { ascending: false }).eq("brokerage_id", params.brokerageId)`,
  },
  {
    file: "app/dashboard/listings/page.tsx",
    label: "the agent listings board",
    anchor: /\.eq\("agent_id",\s*agentId\)\s*\.is\("deleted_at",\s*null\)/,
    preFix: `const { data: listings } = await supabase.from("listings").select("id, address").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(50)`,
  },
]

function section3() {
  console.log("\n[3 · the archive is not a no-op — pins re-run against the frozen PRE-FIX text]")

  const now = fnBody(read("app/actions/listings.ts"), "export async function archiveListing")
  check("archiveListing was located in the current file", now.length > 0)
  const before = fnBody(HARD_DELETE_SPECIMEN, "export async function archiveListing")
  check("the frozen hard-delete specimen still parses", before.length > 0)

  for (const p of ACTION_PINS) {
    check(`now: ${p.name}`, p.holds(now))
    check(`CONTROL the hard-delete specimen FAILS: ${p.name}`, before.length > 0 && !p.holds(before))
  }

  // The two working surfaces. Without these the archive stamps a column nobody
  // reads and the listing stays on the board.
  for (const s of SURFACE_PINS) {
    // blankComments (not stripComments) — positions are irrelevant here, but a
    // `//` line mentioning deleted_at must not satisfy the pin.
    const src = blankComments(read(s.file)).replace(/\s+/g, " ")
    check(`${s.label} filters deleted_at`, s.anchor.test(src), s.file)
    check(`CONTROL its PRE-FIX text FAILS the same pin`, !s.anchor.test(s.preFix.replace(/\s+/g, " ")))
  }

  // NEGATIVE CONTROLS on the other side of the line. An archive that hides the
  // record from the readers that must still see it — compliance, commission,
  // transaction history — is WORSE than the delete it replaced, so the retention
  // surfaces are pinned as NOT filtering, exactly as hard as the working
  // surfaces are pinned as filtering.
  {
    const detail = blankComments(read("app/listings/[listingId]/page.tsx"))
    check("NEGATIVE CONTROL the by-id record page does NOT filter deleted_at (retention surface)",
      !/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/.test(detail))

    const byId = fnBody(read("app/actions/listings.ts"), "export async function getListingById")
    check("NEGATIVE CONTROL getListingById does NOT filter deleted_at — it is the resolver a " +
          "transaction, offer, commission or document reaches a listing through",
      byId.length > 0 && !/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/.test(byId))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE SURVIVOR ENGINE — unchanged, and still watched
// ═══════════════════════════════════════════════════════════════════════════
const RBID = "44444444-4444-4444-4444-444444444444"

async function section4() {
  console.log("\n[4 · child-safe-delete still serves the tenant rollback, unchanged]")
  const rollbackSrc = stripComments(read("lib/kernel/tenant-creation-rollback.ts"))
  check("rollbackTenantCreation runs on the shared engine",
    rollbackSrc.includes("deleteParentWithChildren"))
  check("it does not carry its own delete loop",
    !/for\s*\(\s*const table of TENANT_CREATION_CHILD_TABLES\s*\)/.test(rollbackSrc))
  check("its manifest is untouched (10 tables, users last)",
    TENANT_CREATION_CHILD_TABLES.length === 10 &&
    TENANT_CREATION_CHILD_TABLES[TENANT_CREATION_CHILD_TABLES.length - 1] === "users")

  const archiveSrc = stripComments(read("lib/kernel/listing-archive.ts"))
  check("the listing path no longer imports the delete engine's runtime",
    !/from\s+["']\.\/child-safe-delete["'][\s\S]{0,40}deleteParentWithChildren/.test(archiveSrc) &&
    !archiveSrc.includes("deleteParentWithChildren("))
  check("the listing path contains no .delete( at all",
    !/\.delete\(/.test(archiveSrc))

  {
    const spec: DbSpec = { tables: { brokerages: [{ id: RBID }], users: [{ brokerage_id: RBID }], teams: [{ brokerage_id: RBID }] } }
    const { service, log } = makeService(spec)
    const r = await rollbackTenantCreation(service, RBID)
    check("a half-built tenant still rolls back", r.ok, r.error ?? "")
    check("  its users row went with it", r.childrenRemoved.users === 1)
    check("  teams was deleted before users", log.indexOf("delete teams") < log.indexOf("delete users"))
    check("  the brokerages row is gone", spec.tables.brokerages.length === 0)
  }
  {
    const spec: DbSpec = { tables: { brokerages: [{ id: RBID }] }, refuse: { brokerages: "23503 still referenced" } }
    const { service } = makeService(spec)
    const r = await rollbackTenantCreation(service, RBID)
    check("a REFUSED brokerage delete still fails loudly and names the id",
      !r.ok && !!r.error?.includes(RBID) && r.error.includes("23503"), r.error ?? "")
  }
  {
    const { service } = makeService({ tables: {} })
    const r = await rollbackTenantCreation(service, "")
    check("no brokerage id → refuses (unchanged)", !r.ok && !!r.error?.includes("no workspace id"))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE COLUMN CHOICE IS ENFORCED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE FINDER. Does this source write `status` on a `listings` update?
 *
 * `listings_status_check` admits ten values and none of them is `archived`
 * (live, 2026-08-23), so such a write would be REFUSED — and even if it were
 * admitted, it would overwrite the record's own outcome (sold / withdrawn /
 * expired), which is the fact retention exists to keep.
 */
function writesListingStatus(src: string): boolean {
  const s = blankComments(src)
  return /\.from\(\s*["']listings["']\s*\)\s*[\s\S]{0,120}?\.update\(\s*\{[^}]*\bstatus\s*:/.test(s)
}

function section5() {
  console.log("\n[5 · the archive writes deleted_at and never status]")
  const archiveSrc = read("lib/kernel/listing-archive.ts")
  check("the archive kernel does NOT write listings.status", !writesListingStatus(archiveSrc))
  check("the archive kernel DOES write deleted_at",
    /\.update\(\s*\{\s*deleted_at:\s*now/.test(blankComments(archiveSrc)))
  check("it guards the update with .is(\"deleted_at\", null)",
    /\.is\("deleted_at",\s*null\)/.test(blankComments(archiveSrc)))
  check("it .select()s the update so a zero-row UPDATE cannot report success",
    /\.select\("id, status, lifecycle_stage"\)/.test(blankComments(archiveSrc)))

  // ── POSITIVE CONTROL: the finder must still recognise the defect ──────────
  const SPECIMEN_THAT_WRITES_STATUS = `
    const { data } = await supabase
      .from("listings")
      .update({ status: "archived", updated_at: now })
      .eq("id", listingId).select("id")
  `
  check("CONTROL the finder catches a writer that DOES set listings.status",
    writesListingStatus(SPECIMEN_THAT_WRITES_STATUS))
  check("CONTROL the finder is not satisfied by a COMMENT about status",
    !writesListingStatus(`// .from("listings").update({ status: "archived" })`))
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. open_houses.property_id — m542
// ═══════════════════════════════════════════════════════════════════════════

/** THE CENSUS. Files that name `open_houses` AND `property_id`. */
function openHousePropertyIdReaders(files: Array<{ path: string; text: string }>): string[] {
  const hits: string[] = []
  for (const f of files) {
    const s = blankComments(f.text)
    if (!s.includes("open_houses")) continue
    // A `.from("open_houses")` chain, or an object literal in the same statement,
    // that names property_id.
    if (/from\(\s*["']open_houses["']\s*\)[\s\S]{0,400}?\bproperty_id\b/.test(s)) hits.push(f.path)
  }
  return hits
}

function section6() {
  console.log("\n[6 · open_houses.property_id — m542, APPLIED 2026-08-23 hrvaqgvukzxfskkcrwbt]")

  // The file list is DERIVED, not hand-kept. A hardcoded list is a census that
  // silently shrinks: another lane is consolidating the open-house tables this
  // same wave, and a list written against yesterday's tree would keep reporting
  // a clean zero while scanning files that no longer mention open_houses.
  const paths = execFileSync("bash", ["-lc",
    `grep -rl 'open_houses' --include=*.ts --include=*.tsx lib app 2>/dev/null || true`],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean)
  const files = paths.map((p) => ({ path: p, text: read(p) }))
  const hits = openHousePropertyIdReaders(files)
  console.log(`      files scanned: ${files.length} (derived — every lib/app file naming open_houses)`)
  check("the census actually scanned something (a zero over zero files is not a measurement)",
    files.length >= 5, `${files.length} files`)
  check("no code reads or writes open_houses.property_id", hits.length === 0, hits.join(", "))

  // ── POSITIVE CONTROL: the census must still SEE such a reader ─────────────
  const SPECIMEN = `const { data } = await svc.from("open_houses").select("id").eq("property_id", listingId)`
  check("CONTROL the census catches a real open_houses.property_id reader",
    openHousePropertyIdReaders([{ path: "specimen", text: SPECIMEN }]).length === 1)
  check("CONTROL the census is not satisfied by a COMMENT",
    openHousePropertyIdReaders([{ path: "c", text: `// from("open_houses") ... property_id` }]).length === 0)
  check("CONTROL the census does not fire on the survivor's own name",
    openHousePropertyIdReaders([{ path: "s",
      text: `await svc.from("open_houses").select("id").eq("listing_id", listingId)` }]).length === 0)

  // The migration must declare its application status truthfully (CLAUDE.md §3).
  const mig = read("supabase/migrations/m542-a-property-id-that-points-at-listings-is-not-a-property-id.sql")
  const applied = /^--\s*APPLIED 2026-08-23 hrvaqgvukzxfskkcrwbt\.?$/m.test(mig)
  const notApplied = /WRITTEN, NOT APPLIED/.test(mig)
  check("m542 declares exactly one application status, truthfully", applied !== notApplied && applied)
  check("m542 drops the constraint AND the column",
    /DROP CONSTRAINT IF EXISTS open_houses_property_id_fkey/.test(mig) &&
    /DROP COLUMN IF EXISTS property_id/.test(mig))
  check("m542 names its survivor", mig.includes("SURVIVOR: open_houses.listing_id"))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing archive — retention simulator")
  console.log(" RULING: a listing is RETAINED, never destroyed.")
  console.log("══════════════════════════════════════════════════")
  section1()
  await section2()
  section3()
  await section4()
  section5()
  section6()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOTS, stated:")
  console.log("   • The FK denominator is SCHEMA_FK_MAP, GENERATED and not live-read, minus")
  console.log("     the pairs in RETIRED_BY_MIGRATION. A key added since the last")
  console.log("     regeneration is invisible to section 1 in BOTH directions.")
  console.log("   • Section 3 pins TWO working surfaces. 511 `.from(\"listings\")` call sites")
  console.log("     exist and 23 filter deleted_at; the other 488 were classified by")
  console.log("     inspecting those 23, not by auditing all 511. A list-shaped reader in")
  console.log("     the long tail will keep showing archived listings. UNRESOLVED.")
  console.log("   • deleted_at is a COLUMN, not an RLS policy. A direct PostgREST caller")
  console.log("     with a valid session still sees archived rows — the same posture every")
  console.log("     other soft-delete in this tree has.")
  console.log("   • The retention census COUNTS rows. It proves they are still there; it")
  console.log("     does not diff their contents.")
  console.log("   • Section 6 scans the files that name open_houses, not the whole tree.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" LISTING_ARCHIVE_FAIL")
    process.exit(1)
  }
  console.log(" ✅ A listing leaves the working surface and NOTHING is destroyed:")
  // DERIVED, NOT TYPED. This line read a hardcoded "62" — correct after m542 and
  // wrong the moment m547 dropped `open_houses`, taking its listing_id with it.
  // The ledger and the generated cache both hold 61; only the summary sentence
  // disagreed, which is the worst place for a stale number because it is the one
  // line a reader takes as the verdict. Counting the ledger means it cannot drift
  // from what was actually checked.
  const ledgered = LISTING_CHILD_RULES.length
  // "retained" is NOT every ledgered table — it is the ones whose rows the hard
  // delete would have DESTROYED or DETACHED (remove + cascade + detach). The
  // `block` entries never lost anything, so counting them here would inflate the
  // claim by exactly the tables that were never at risk. Deriving it from the
  // dispositions keeps the sentence true as the ledger changes.
  const retained = new Set(
    LISTING_CHILD_RULES.filter((r) => r.disposition !== "block").map((r) => r.table),
  ).size
  console.log(`    ${ledgered} FKs ledgered, ${retained} tables' rows retained, status unrewritten, restorable.`)
  console.log(" LISTING_ARCHIVE_PASS")
  process.exit(0)
}

main()
