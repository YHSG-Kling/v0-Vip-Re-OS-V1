#!/usr/bin/env tsx
/**
 * scripts/appraiser-bench-simulator.ts   (npm run test:appraiser-bench)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN APPRAISER IS A VENDOR TYPE, IS STATE-LICENSED, AND IS THE ONE TRADE
 * NOTHING MODEL-AUTHORED MAY REACH
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * OWNER RULING, verbatim:
 *
 *   "an appraiser can be another vendor type and is state licensed."
 *
 * m554 obeyed it. This guard stands over the three things that ruling had to be
 * true of at once, and it is written two-sided throughout: every refusal is
 * paired with the allowance that proves the gate is not simply refusing
 * everything, and every allowance with the refusal that proves it is not simply
 * allowing everything (CLAUDE.md §2 — an absence assertion needs a POSITIVE
 * CONTROL, and so does a presence one).
 *
 *   A  ONE TAXONOMY. `appraiser` is in the module, in the generated vocabulary
 *      cache, labelled, and in exactly one picker group — and the widening did
 *      not drop the CHECK, which is a different thing from widening it.
 *   B  THE LICENCE GATE COVERS IT. `appraiser` is on the state-licensed list on
 *      BOTH sides — TypeScript and the migration that most recently defines the
 *      SQL function — and an appraiser with coverage but no current licence is
 *      NOT bookable, while the same facts on an unlicensed trade ARE.
 *   C  §5 HOLDS ON THE NEW ROUTES. Benching appraisers opened new ways to reach
 *      one. The gate refuses before the model call, the route inventory's files
 *      all still exist, and the surfaces recorded as deterministic still are.
 *
 * ── THE LIVE EVIDENCE THIS PURE GUARD STANDS ON ─────────────────────────────
 * Layer LIVE below re-proves these wherever credentials exist. They were run by
 * hand against project hrvaqgvukzxfskkcrwbt when m554 was applied, inside DO
 * blocks that end in RAISE so every fixture rolled back:
 *
 *   BEFORE  vendors.category    appraiser=REFUSED(23514)  invented=REFUSED(23514)
 *           vsa.trade_category  appraiser=REFUSED(23514)  invented=REFUSED(23514)
 *           vendor_trade_requires_state_license('appraiser') = false
 *   AFTER   vendors.category    appraiser=ADMITTED        invented=REFUSED(23514)
 *           vsa.trade_category  appraiser=ADMITTED        invented=REFUSED(23514)
 *           gate: appraiser=true  inspector=false  title=true
 *   GATE    covered+no licence   → licence_missing, booking REFUSED(23514)
 *           covered+licence      → covered,         booking ACCEPTED
 *           licensed AZ, job CA  → no_overlap,      booking REFUSED(23514)
 *   MUTATION (appraiser taken back off the SQL list, licence still absent)
 *           → covered, booking ACCEPTED  ← RED, which is the point
 *
 * ── MUTATION TEST ───────────────────────────────────────────────────────────
 * MUTATION_TARGETS names the exact edits this guard claims to catch, so the
 * claim is checkable rather than taken on trust, and layer M re-introduces each
 * one INTO AN IN-MEMORY COPY of the real source and re-runs the SAME predicate,
 * requiring it to go red. In-memory on purpose: this repo runs waves of agents in
 * parallel, and a control that writes a defect into a real file on disk can be
 * read by another process or left behind by a crash.
 *
 * Comment-STRIPPED source is scanned throughout (scripts/strip-comments.ts).
 * That is load-bearing here: lib/vendors/vendor-service-area.ts carries a
 * SUPERSEDED NOTE quoting the pre-m554 state in prose, and a raw-source scan
 * would read that tombstone as the live rule and accuse the fix of being the
 * defect (CLAUDE.md §2).
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { LIVE_TABLES } from "./live-tables"
import {
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_LABELS,
  VENDOR_CATEGORY_GROUPS,
  VENDOR_CATEGORY_APPRAISER,
  isVendorCategory,
  toVendorCategory,
} from "../lib/kernel/vendor-categories"
import {
  STATE_LICENSED_VENDOR_CATEGORIES,
  isStateLicensedTrade,
  vendorGeoVerdict,
  type VendorCoverageRow,
  type VendorGeoFacts,
} from "../lib/vendors/vendor-service-area"
import {
  APPRAISER_INDEPENDENCE_RULE,
  APPRAISER_VENDOR_CATEGORY,
  APPRAISER_REACH_ROUTES,
  MODEL_AUTHORED_VENDOR_FACING_ROUTES,
  isAppraiserTrade,
  labelNamesAppraisal,
  modelAuthoredToVendorVerdict,
} from "../lib/vendors/appraiser-independence"
import {
  sqlLicensedTrades,
  latestMigrationDefining,
  LICENSED_TRADE_FN_DDL,
} from "./vendor-trade-vocab-source"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** CLAUDE.md §2 — a tombstone is not a call site. Scan STRIPPED source. */
const src = (p: string) => stripComments(raw(p))
/** …and blank string literals too where a specimen could match a code token. */
const srcNoStrings = (p: string) => blankStrings(stripComments(raw(p)))

const ACTION = "app/actions/ai-vendor-management.ts"
const RULE = "lib/vendors/appraiser-independence.ts"
const MODEL = "lib/vendors/vendor-service-area.ts"
const TAXONOMY = "lib/kernel/vendor-categories.ts"
const AI_NOTE = "app/api/internal/ai-note/route.ts"

/**
 * The exact mutations this guard claims to catch.
 *   M1  vendor-service-area.ts: drop "appraiser" from STATE_LICENSED_VENDOR_CATEGORIES
 *                                       → caught by B2 (SQL and TS lists disagree)
 *   M2  ai-vendor-management.ts: delete the modelAuthoredToVendorVerdict call
 *                                       → caught by C1 (the gate is not wired)
 *   M3  ai-vendor-management.ts: move the gate BELOW the generateObject call
 *                                       → caught by C2 (refused after the spend)
 *   M4  ai-vendor-management.ts: discard the vendor read's `error` again
 *                                       → caught by C3 (the gate cannot fail closed)
 */
const MUTATION_TARGETS = ["B2", "C1", "C2", "C3"] as const

let pass = 0
let fail = 0
const fails: string[] = []
const blindSpots: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(t: string) { console.log(`\n■ ${t}`) }
function blind(t: string) { blindSpots.push(t) }

const NOW = Date.parse("2026-08-25T00:00:00.000Z")

// ═════════════════════════════════════════════════════════════════════════════
// LAYER A — ONE TAXONOMY, AND IT GREW BY EXACTLY ONE THING
// ═════════════════════════════════════════════════════════════════════════════

function layerTaxonomy() {
  section("Layer A — appraiser is a vendor type, in the ONE taxonomy")

  check("A1 the module admits 'appraiser'", isVendorCategory(APPRAISER_VENDOR_CATEGORY))
  check("A1b POSITIVE CONTROL — it still refuses an invented trade (widened, not opened)",
    !isVendorCategory("not_a_real_trade") && !isVendorCategory("appraisal"))

  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  const cover = CHECK_VOCABULARIES.vendor_service_areas?.trade_category ?? []
  check("A2 the generated vocabulary cache carries it on the BENCH column",
    live.includes("appraiser"), `live has ${live.length} values`)
  check("A2b …and on the COVERAGE column, which is the other spelling of the same taxonomy",
    cover.includes("appraiser"), `coverage has ${cover.length} values`)
  check("A2c THE TWO SPELLINGS ARE THE SAME LIST — widening one alone would give a vendor a trade the bench can hold and no licence can be filed against (or the reverse)",
    live.length > 0 && JSON.stringify([...live].sort()) === JSON.stringify([...cover].sort()))
  check("A2d …and the module is that same list, so there is no third spelling (§6)",
    live.length === VENDOR_CATEGORIES.length &&
    VENDOR_CATEGORIES.every((c) => live.includes(c)))

  check("A3 it is labelled — a category with no label renders as a raw token",
    VENDOR_CATEGORY_LABELS[APPRAISER_VENDOR_CATEGORY] === "Appraiser")
  const groupsFlat = VENDOR_CATEGORY_GROUPS.flatMap((g) => g.categories)
  check("A4 it appears in EXACTLY ONE picker group (absent = invisible; twice = a duplicate row)",
    groupsFlat.filter((c) => c === APPRAISER_VENDOR_CATEGORY).length === 1)
  check("A4b …and the groups still partition the whole taxonomy",
    groupsFlat.length === VENDOR_CATEGORIES.length &&
    new Set(groupsFlat).size === VENDOR_CATEGORIES.length)

  check("A5 a loose spelling normalises onto the token", toVendorCategory("Appraiser") === "appraiser")
  check("A5b POSITIVE CONTROL — normalisation still refuses to guess",
    toVendorCategory("astrologer") === null)

  // The scanned-card path: the vocabulary growing is decorative if the classifier
  // cannot emit the new value. Proven in scripts/vendor-category-consolidation-simulator.ts;
  // asserted here as REACHABILITY so the two cannot drift apart silently.
  check("A6 the business-card classifier can EMIT the new value (a widening nothing writes is decorative)",
    /category: "appraiser"/.test(src("lib/contacts/card-classifier.ts")))

  check("A7 every table this lane reasons about is a LIVE table",
    ["vendors", "vendor_service_areas", "vendor_bookings", "vendor_jobs", "vendor_messages"]
      .every((t) => LIVE_TABLES.includes(t)))
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER B — THE LICENCE GATE COVERS IT, AND STILL DOES NOT COVER EVERYTHING
// ═════════════════════════════════════════════════════════════════════════════

/** An appraiser covering AZ statewide with a CURRENT licence. One field moves per
 *  case below, so a verdict change is attributable to exactly one fact. */
const AZ_APPRAISER: VendorCoverageRow = {
  state: "AZ", zipCode: null, tradeCategory: "appraiser", status: "active",
  license: { policy_number: "AZ-CR-1234", expiry: "2099-01-01" },
  notes: null,
}

const CLEAN: VendorGeoFacts = {
  resolved: true,
  tradeCategory: "appraiser",
  jobState: "AZ",
  jobZip: "85001",
  localBenchRow: false,
  coverage: [AZ_APPRAISER],
  tenantAreas: [{ state: "AZ", zipCode: "85001" }],
}

function layerLicence() {
  section("Layer B — state-licensed, on both sides, and it bites")

  check("B1 the TypeScript gate treats appraiser as state-licensed",
    isStateLicensedTrade("appraiser") && STATE_LICENSED_VENDOR_CATEGORIES.has("appraiser"))
  check("B1b POSITIVE CONTROL — inspector is still NOT gated, deliberately (home-inspector licensure is not universal; a gate wrong in one direction gets switched off)",
    !isStateLicensedTrade("inspector") && !isStateLicensedTrade("stager"))

  // THE TWO LISTS MUST BE THE SAME LIST, read from the migration that most
  // recently DEFINES the SQL function rather than from a file named by hand.
  const licSrc = latestMigrationDefining(ROOT, LICENSED_TRADE_FN_DDL)
  check("B2a the parser found a migration that defines the SQL list (a blind parser and a clean tree both report zero)",
    !!licSrc && sqlLicensedTrades(licSrc.sql).length > 0)
  const sqlList = sqlLicensedTrades(licSrc?.sql ?? "").slice().sort()
  const tsList = [...STATE_LICENSED_VENDOR_CATEGORIES].slice().sort()
  check(`B2 the SQL and TypeScript state-licensed lists are IDENTICAL (sql from ${licSrc?.name ?? "nothing"})`,
    sqlList.length > 0 && JSON.stringify(sqlList) === JSON.stringify(tsList),
    `sql=${JSON.stringify(sqlList)} ts=${JSON.stringify(tsList)}`)
  check("B2b …and every trade on it is a REAL category, not an invented token",
    tsList.every((c) => (VENDOR_CATEGORIES as readonly string[]).includes(c)))

  // THE GATE ITSELF, two-sided on the one fact that decides it.
  const licensed = vendorGeoVerdict(CLEAN, NOW)
  check("B3 POSITIVE CONTROL — a covered appraiser WITH a current licence is bookable",
    licensed.ok && licensed.reason === "covered" && licensed.licence === "verified_in_state")
  const noLicence = vendorGeoVerdict(
    { ...CLEAN, coverage: [{ ...AZ_APPRAISER, license: null }] }, NOW)
  check("B4 an appraiser covering the state with NO licence is NOT bookable there",
    !noLicence.ok && noLicence.reason === "licence_missing")
  const expired = vendorGeoVerdict(
    { ...CLEAN, coverage: [{ ...AZ_APPRAISER, license: { expiry: "2020-01-01" } }] }, NOW)
  check("B5 …and an EXPIRED licence is refused distinctly from a missing one",
    !expired.ok && expired.reason === "licence_expired")

  // THE MUTATION, EXPRESSED AS A CONTRAST: identical facts, one trade on the list
  // and one off it. This is the pure twin of the live mutation recorded in the
  // header — take appraiser off the list and the unlicensed booking goes through.
  const asUnlicensedTrade = vendorGeoVerdict({
    ...CLEAN,
    tradeCategory: "inspector",
    coverage: [{ ...AZ_APPRAISER, tradeCategory: "inspector", license: null }],
  }, NOW)
  check("B6 MUTATION CONTRAST — the SAME facts on a trade that is NOT state-licensed ARE bookable, so it is list membership doing the refusing and nothing else",
    asUnlicensedTrade.ok && asUnlicensedTrade.licence === "not_required")

  // Cross-state: licensed in AZ does not make an appraiser bookable in CA.
  const crossState = vendorGeoVerdict({
    ...CLEAN, jobState: "CA", jobZip: "90210",
    tenantAreas: [{ state: "CA", zipCode: "90210" }],
  }, NOW)
  check("B7 an appraiser licensed in AZ is NOT bookable on a CA job",
    !crossState.ok && crossState.reason === "no_overlap")
  check("B8 an appraiser who declared NOTHING is refused by name, not silently allowed",
    (() => { const v = vendorGeoVerdict({ ...CLEAN, coverage: [] }, NOW); return !v.ok && v.reason === "vendor_coverage_unknown" })())

  // A LOCAL bench row: the tenant typed the appraiser in themselves. The licence
  // question still applies and the honest answer is "state unknown".
  const local: VendorGeoFacts = {
    ...CLEAN, localBenchRow: true, coverage: [], tenantAreas: [],
    benchLicense: { expiry: "2099-01-01" },
  }
  const localOk = vendorGeoVerdict(local, NOW)
  check("B9 a LOCAL appraiser row with a licence on file is bookable, and says its licence state is unknown",
    localOk.ok && localOk.licence === "on_file_state_unknown")
  const localBad = vendorGeoVerdict({ ...local, benchLicense: null }, NOW)
  check("B10 …and a LOCAL appraiser row with NO licence at all is still refused",
    !localBad.ok && localBad.reason === "licence_missing")
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER C — CLAUDE.md §5 ON THE ROUTES THE WIDENING OPENED
// ═════════════════════════════════════════════════════════════════════════════

/** The predicates the source layer asserts, DEFINED ONCE so the mutation layer
 *  can re-run the very same ones. A control that re-implements the check it is
 *  testing proves only that two regexes disagree. */
const P = {
  /** C1 — the gate is called at all. */
  gateWired: (s: string) => /modelAuthoredToVendorVerdict\(/.test(s),
  /** C2 — and BEFORE the model call, not after it. Refusing after the spend is
   *  not a gate, it is an apology. */
  gateBeforeSpend: (s: string) => {
    const gate = s.indexOf("modelAuthoredToVendorVerdict(")
    const model = s.indexOf("generateObject({", s.indexOf("coordinateVendors"))
    return gate > -1 && model > -1 && gate < model
  },
  /** C3 — the read the gate is computed from destructures its error, so a refused
   *  read cannot read as "no appraiser here" (supabase-js RESOLVES refusals). */
  readFailsClosed: (s: string) =>
    /const \{ data: vendors, error: vendorsErr \}/.test(s) &&
    /resolved: !vendorsErr/.test(s),
}

function layerSources() {
  section("Layer C — §5 holds on the routes benching appraisers opened")

  check("C0 the rule is spelled ONCE, in the module that owns it",
    existsSync(join(ROOT, RULE)) &&
    APPRAISER_INDEPENDENCE_RULE.includes("must not be model-authored"))
  check("C0b …and CLAUDE.md still states it, so the module is mirroring a live ruling and not a memory",
    /Anything reaching a \*\*licensed appraiser\*\* must not be model-authored/.test(raw("CLAUDE.md")))

  const action = src(ACTION)
  check("C1 the coordination action calls the gate", P.gateWired(action))
  check("C2 …BEFORE the model call, so no such text is ever produced (and no spend is incurred producing it)",
    P.gateBeforeSpend(action))
  check("C3 …and the read it judges from FAILS CLOSED on a refusal", P.readFailsClosed(action))
  check("C3b …and the rule is imported, not re-spelled beside the call site (§6)",
    /from "@\/lib\/vendors\/appraiser-independence"/.test(action) &&
    !/"appraiser"/.test(action))

  // THE VERDICT ITSELF, two-sided. A gate that refuses everything is not a gate.
  const withAppraiser = modelAuthoredToVendorVerdict({
    resolved: true, vendorCategories: ["photographer", "appraiser"],
  })
  check("C4 a coordination request naming an APPRAISER is refused",
    !withAppraiser.ok && withAppraiser.reason === "appraiser_named")
  const withoutAppraiser = modelAuthoredToVendorVerdict({
    resolved: true, vendorCategories: ["photographer", "stager", "title"],
  })
  check("C4b POSITIVE CONTROL — the same request with no appraiser is ALLOWED (the gate is not refusing everything)",
    withoutAppraiser.ok)
  const unresolved = modelAuthoredToVendorVerdict({ resolved: false, vendorCategories: [] })
  check("C5 a REFUSED bench read fails CLOSED and is nameable as such — 'nobody checked' never renders as 'checked and fine' (§4)",
    !unresolved.ok && unresolved.reason === "vendor_read_refused")
  const byService = modelAuthoredToVendorVerdict({
    resolved: true, vendorCategories: [], serviceLabels: ["Appraisal for the refi"],
  })
  check("C6 a request that names APPRAISAL WORK with no vendor row is refused too (the model would otherwise write to an appraiser with no id here to check)",
    !byService.ok && byService.reason === "appraisal_service_named")
  const byServiceOk = modelAuthoredToVendorVerdict({
    resolved: true, vendorCategories: [], serviceLabels: ["Photography and staging"],
  })
  check("C6b POSITIVE CONTROL — an ordinary service list is allowed", byServiceOk.ok)
  check("C6c the label matcher is word-anchored, not a substring free-for-all",
    labelNamesAppraisal("appraisal") && labelNamesAppraisal("Appraiser visit") &&
    !labelNamesAppraisal("praise") && !labelNamesAppraisal("appraisalsomething"))
  check("C7 the trade test tolerates the loose spellings the normaliser already accepts",
    isAppraiserTrade("appraiser") && isAppraiserTrade("Appraiser") &&
    !isAppraiserTrade("inspector") && !isAppraiserTrade(null))

  // THE ROUTE INVENTORY IS A CURRENT AUDIT, NOT A STALE ONE.
  check("C8 the walk names at least one route in each direction (an inventory with no safe routes is a scan that found nothing)",
    APPRAISER_REACH_ROUTES.some((r) => r.authorship === "model_authored") &&
    APPRAISER_REACH_ROUTES.some((r) => r.authorship === "deterministic"))
  const missing = APPRAISER_REACH_ROUTES.filter((r) => !existsSync(join(ROOT, r.file)))
  check("C8b every file the walk names still EXISTS — a route inventory whose files have moved is a stale audit that reads like a current one",
    missing.length === 0, missing.map((r) => r.file).join(", "))
  check("C8c the model-authored VENDOR-FACING set is derived from the walk, not hand-counted",
    MODEL_AUTHORED_VENDOR_FACING_ROUTES.length > 0 &&
    MODEL_AUTHORED_VENDOR_FACING_ROUTES.every((r) => r.reachesVendor && r.authorship === "model_authored"))

  // …and the surfaces the walk recorded as DETERMINISTIC still are. This is the
  // half that rots: a later change adding a model call to a vendor email would
  // silently make the recorded finding false.
  for (const f of ["lib/communications/vendor-communications.tsx", "lib/agents/vendor-loop-producer.ts"]) {
    check(`C9 ${f} still imports NO model helper — the walk recorded it deterministic`,
      !/@\/lib\/ai\/|from "ai"/.test(srcNoStrings(f)))
  }
  check("C9b the vendor auto-email is still a literal template over database facts",
    /dispatchEmail\(/.test(src("app/actions/vendor-marketplace.ts")) &&
    !/generateObject|generateText/.test(
      src("app/actions/vendor-marketplace.ts")))

  // The one model-authored route ruled ALLOWED: it must stay keyed to the
  // CALLER'S OWN vendor grant. If it ever becomes agent-targetable the ruling
  // flips, and this is what notices.
  const note = src(AI_NOTE)
  check("C10 the ai-note vendor write stays keyed to the CALLER'S OWN vendor grant (that is the whole reason it was ruled allowed)",
    /selectVendorId\(grants\)/.test(note) &&
    /role === "vendor" && vendorId/.test(note))

  // The superseded note must be a COMMENT, not live code.
  const modelStripped = src(MODEL)
  check("C11 the pre-m554 'appraiser is missing from the vocabulary' finding survives only as prose, and the live list holds the value",
    !/APPRAISER IS MISSING/.test(modelStripped) && /"appraiser"/.test(modelStripped))
  check("C12 the taxonomy module names the value once, as a constant, rather than leaving it hand-typed at gates",
    /VENDOR_CATEGORY_APPRAISER/.test(src(TAXONOMY)))
  check("C13 this guard names the mutations it claims to catch", MUTATION_TARGETS.length === 4)
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER M — MUTATION: re-introduce each defect in memory, require RED
// ═════════════════════════════════════════════════════════════════════════════

function mutate(source: string, find: string, replaceWith: string, label: string): string | null {
  if (!source.includes(find)) {
    check(`M· the mutation "${label}" could be APPLIED (a find-string that stopped matching is theatre, not a control)`, false)
    return null
  }
  pass++
  console.log(`  ✓ M· the mutation "${label}" applied`)
  return source.replace(find, replaceWith)
}

function layerMutation() {
  section("Layer M — each claimed mutation, re-introduced in memory, must go RED")

  const action = src(ACTION)

  // M2 — delete the gate call.
  const m2 = mutate(action, "modelAuthoredToVendorVerdict({", "noSuchGate({", "M2 delete the gate call")
  if (m2) check("M2 → C1 goes RED when the gate is not called", !P.gateWired(m2))

  // M3 — the gate still runs, but AFTER the model call.
  const gateStart = action.indexOf("const reach = modelAuthoredToVendorVerdict({")
  const gateEnd = action.indexOf("if (!reach.ok) return", gateStart)
  if (gateStart > -1 && gateEnd > -1) {
    pass++
    console.log('  ✓ M· the mutation "M3 move the gate after the spend" applied')
    const block = action.slice(gateStart, action.indexOf("\n", gateEnd) + 1)
    const m3 = action.slice(0, gateStart) + action.slice(gateStart + block.length) + "\n" + block
    check("M3 → C2 goes RED when the gate runs after the model call", !P.gateBeforeSpend(m3))
  } else {
    check("M· the mutation \"M3 move the gate after the spend\" could be APPLIED", false)
  }

  // M4 — discard the vendor read's error again.
  const m4 = mutate(action, "const { data: vendors, error: vendorsErr }", "const { data: vendors }",
    "M4 discard the vendor read's error")
  if (m4) check("M4 → C3 goes RED when the gate can no longer tell a refusal from an empty bench",
    !P.readFailsClosed(m4))

  // M1 — take `appraiser` off the TypeScript state-licensed list. Asserted
  // against the SAME comparison layer B runs, on an in-memory copy.
  const modelSrc = raw(MODEL)
  const m1 = mutate(modelSrc, '  "insurance",\n  "appraiser",\n', '  "insurance",\n',
    "M1 remove appraiser from STATE_LICENSED_VENDOR_CATEGORIES")
  if (m1) {
    // ANCHORED ON THE `export const`, not on the first mention of the name: the
    // module header and the JSDoc both NAME this constant in prose, and matching
    // the first occurrence would have parsed a sentence instead of the Set —
    // the same defect scripts/vendor-service-area-simulator.ts records paying for
    // once already (CLAUDE.md §2 — a tombstone is not a call site).
    const setLiteral = m1.match(
      /export const STATE_LICENSED_VENDOR_CATEGORIES[\s\S]*?\]\)/)?.[0] ?? ""
    const mutatedTs = [...setLiteral.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
    const licSrc = latestMigrationDefining(ROOT, LICENSED_TRADE_FN_DDL)
    const sqlList = sqlLicensedTrades(licSrc?.sql ?? "").slice().sort()
    check("M1 → B2 goes RED when the TS list drops a trade the SQL gate still holds",
      mutatedTs.length > 0 && JSON.stringify(mutatedTs) !== JSON.stringify(sqlList),
      `mutated ts=${JSON.stringify(mutatedTs)}`)
    check("M1b …and the mutation is exactly one trade smaller, so the control is not passing for an unrelated reason",
      mutatedTs.length === sqlList.length - 1 && !mutatedTs.includes("appraiser"))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER LIVE — creds-gated
// ═════════════════════════════════════════════════════════════════════════════

async function layerLive() {
  section("Layer LIVE — is m554 really applied, and does the DATABASE refuse?")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("  ⊘ skipped (no SUPABASE creds) — layers A-M proved the rules and the wiring")
    blind(
      "Layer LIVE did not run here: no SUPABASE credentials in this environment. The live two-sided " +
      "controls WERE run by hand against project hrvaqgvukzxfskkcrwbt when m554 was applied — " +
      "before/after on both CHECKs with an invented value as the positive control, the licence gate " +
      "refusing an unlicensed appraiser booking and accepting a licensed one, and the mutation " +
      "confirming the refusal is the list's doing. Their exact outputs are quoted in this file's " +
      "header and in the lane report. In CI with credentials this layer re-proves them on every run.")
    return
  }
  const svc = createClient(url, key)

  const { data: gated, error: gateErr } = await svc.rpc("vendor_trade_requires_state_license", {
    p_trade: "appraiser",
  })
  if (gateErr) {
    check("m554 is APPLIED (the licence gate answers for 'appraiser')", false, gateErr.message)
    blind("The live layer stopped at the shape probe: m554 is not applied to the project these " +
      "credentials point at. That is the PRE-MIGRATION shape reported honestly, not a passing run.")
    return
  }
  check("LIVE1 the DATABASE treats appraiser as state-licensed", gated === true, String(gated))
  const { data: notGated } = await svc.rpc("vendor_trade_requires_state_license", { p_trade: "inspector" })
  check("LIVE1b POSITIVE CONTROL — and inspector is still NOT gated", notGated === false, String(notGated))
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("APPRAISER ON THE BENCH — one taxonomy, a real licence gate, and §5 held")
  layerTaxonomy()
  layerLicence()
  layerSources()
  layerMutation()
  await layerLive()

  if (blindSpots.length) {
    section("BLIND SPOTS (published beside the number — CLAUDE.md §2)")
    for (const b of blindSpots) console.log(`  ⚠ ${b}`)
  }

  console.log("\n" + "─".repeat(50))
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail) {
    for (const f of fails) console.log(`   ✗ ${f}`)
    console.log(" ❌ APPRAISER_BENCH_FAIL")
    process.exit(1)
  }
  console.log(" ✅ APPRAISER_BENCH_PASS — an appraiser is a vendor type, is unbookable in a state" +
    " where they hold no current licence, and nothing model-authored reaches one")
}

main().catch((e) => { console.error(e); process.exit(1) })
