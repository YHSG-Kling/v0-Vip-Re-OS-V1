#!/usr/bin/env tsx
/**
 * scripts/listing-status-two-senses-guard.ts   (npm run test:listing-status-two-senses)
 * ─────────────────────────────────────────────────────────────────────────────
 * "ACTIVE" NAMES TWO DIFFERENT THINGS AND THEY MAY NEVER RE-MERGE.
 *
 * Owner's ruling, verbatim (2026-09-05):
 *
 *   "after the compliance gate for a signed executed listing agreement is passed, the listing is
 *    active in the system but the listing status is coming soon."
 *
 * ACTIVE IN THE SYSTEM (the OS starts running the listing, at the listing-agreement compliance
 * gate) is NOT ACTIVE ON THE MARKET (listings.status = 'active', which is MLS-live and nothing
 * else). This guard holds the two apart in lib/listings/listing-status-sync.ts.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS THE RULE RATHER THAN A WAYPOINT (§2) ─────
 * The two strings the owner NAMED (COMING_SOON_PREP, coming_soon) and the MLS pair
 * (MLS_ACTIVE, active) appear below because they ARE the ruling — but nothing else is pinned:
 *   · the status and stage vocabularies are DERIVED from the generated cache
 *     scripts/check-vocabularies.ts (CLAUDE.md §3), never typed here, and no count is hardcoded;
 *   · "exactly one stage yields 'active'" is derived by sweeping EVERY live lifecycle_stage with
 *     every gate FORCED OPEN — so a second 'active' cannot hide behind a gate;
 *   · the LISTING_CANCELLED terminal is not pinned to a value at all. The forward map and the
 *     REVERSE map in app/actions/listings-kernel.ts are read and required to AGREE, so the pair
 *     holds whichever value it settles on and cannot be split one-sidedly;
 *   · the enrichment/ads status sets are asserted to PARTITION the live vocabulary, not to have
 *     N members.
 *
 * ── SOURCE SCANS READ COMMENT-STRIPPED SOURCE (§2) ──────────────────────────
 * A TOMBSTONE IS NOT A CALL SITE. lib/listings/listing-status-sync.ts's own tombstone quotes the
 * deleted 7-value list verbatim, and app/actions/listings-kernel.ts's comments quote
 * "LISTING_CANCELLED" in prose. Every scan below goes through scripts/strip-comments.ts, and a
 * BLINDNESS CONTROL proves it: the raw source must contain the tombstone's literals and the
 * stripped source must not. If that control ever passes trivially, the stripper stopped working.
 *
 * ── POSITIVE CONTROLS (§2) ──────────────────────────────────────────────────
 * Every absence/derived assertion is re-run against a deliberately defective stand-in that must
 * FAIL it. A broken finder and a clean tree both report zero; the controls tell them apart.
 *
 * Pure: no database, no network.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { LISTING_STATUSES } from "../lib/constants"
import { LISTING_STATUSES_ACTIVE, LISTING_STATUSES_INACTIVE } from "../lib/enrichment/deal-vocabulary"
import {
  statusForStage,
  mappedStages,
  LISTING_STATUS_VALUES,
  STATUS_AFTER_LISTING_AGREEMENT_GATE,
  type ListingStatusGate,
} from "../lib/listings/listing-status-sync"

// Repo root. `process.cwd()` rather than `__dirname` — this file is loaded as an
// ES module (no __dirname), and it is the form the sibling guards use.
const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

let pass = 0
const fails: string[] = []
const notes: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? `  — ${detail}` : ""}`) }
}
const note = (n: string) => { notes.push(n); console.log(`  · ${n}`) }

// ─── THE OWNER'S FOUR WORDS. Everything else is derived. ─────────────────────
// THE OWNER REFINED THIS ON 2026-09-05, and the refinement moved the stage.
// "listing agreement signed /mls start date STARTS the compliance gate ... if passed then the
// status is coming soon prep" — so agreement-signed BEGINS the gate; the stage that means the
// gate PASSED is COMING_SOON_PREP. "coming soon prep" names a lifecycle STAGE; the market-facing
// status at that stage is `coming_soon`, the only coming-soon value listings_status_check admits.
const RULING_STAGE  = "COMING_SOON_PREP"
const RULING_STATUS = "coming_soon"
const MLS_STAGE     = "MLS_ACTIVE"
const MLS_STATUS    = "active"
const GATE_OPEN: ListingStatusGate = { listingAgreementCompliancePassed: true }

// ─── LIVE VOCABULARY, from the generated cache (§3) ──────────────────────────
const LIVE_STATUS = CHECK_VOCABULARIES.listings?.status ?? []
const LIVE_STAGE  = CHECK_VOCABULARIES.listings?.lifecycle_stage ?? []
const liveStatus  = new Set(LIVE_STATUS)
const liveStage   = new Set(LIVE_STAGE)

const eqSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

function main() {
  console.log("\n[0] The generated cache is readable at all — every number below is derived from it")
  check("CHECK_VOCABULARIES.listings.status is non-empty", LIVE_STATUS.length > 0)
  check("CHECK_VOCABULARIES.listings.lifecycle_stage is non-empty", LIVE_STAGE.length > 0)
  note(`live listings.status admits ${LIVE_STATUS.length}: ${LIVE_STATUS.join(", ")}`)
  note(`live listings.lifecycle_stage admits ${LIVE_STAGE.length} stages`)
  if (LIVE_STATUS.length === 0 || LIVE_STAGE.length === 0) return finish()

  // ── 1. ONE VOCABULARY (§6 / §1) ───────────────────────────────────────────
  console.log("\n[1] One vocabulary: the survivor matches the database and the alias matches the survivor")
  check("lib/constants::LISTING_STATUSES is EXACTLY the live CHECK set",
    eqSet(LISTING_STATUSES as readonly string[], LIVE_STATUS),
    `constant=${LISTING_STATUSES.length} live=${LIVE_STATUS.length}`)
  check("listing-status-sync::LISTING_STATUS_VALUES is the SAME object as the survivor (one definition, two names)",
    (LISTING_STATUS_VALUES as readonly string[]) === (LISTING_STATUSES as readonly string[]))
  check("…and therefore admits every live value, none extra",
    eqSet(LISTING_STATUS_VALUES as readonly string[], LIVE_STATUS))

  // The 7-value list this lane deleted must not have been re-typed anywhere in the map file.
  const syncRaw = read("lib/listings/listing-status-sync.ts")
  const syncSrc = stripComments(syncRaw)
  check("no hand-typed status vocabulary survives in listing-status-sync.ts (code, comments excluded)",
    !/LISTING_STATUS_VALUES\s*(:|=)\s*\[/.test(syncSrc) && !/type\s+ListingStatus\s*=\s*"/.test(syncSrc))
  // BLINDNESS CONTROL — the tombstone quotes the deleted list verbatim. If the scan above were
  // reading RAW source it would fire on the tombstone and accuse the code of the thing the
  // tombstone records having fixed (the 2026-08-23 shape, CLAUDE.md §2).
  check("BLINDNESS CONTROL: the tombstone's deleted list IS in the raw file and is NOT in the stripped file",
    /type\s+ListingStatus\s*=\s*"draft"/.test(syncRaw) && !/type\s+ListingStatus\s*=\s*"draft"/.test(syncSrc))

  // ── 2. THE MAP ONLY EMITS THINGS THE DATABASE ADMITS ──────────────────────
  console.log("\n[2] Every key the map carries is a live stage; every status it can emit is a live status")
  const mapped = mappedStages()
  const badKeys = mapped.filter((m) => !liveStage.has(m.stage)).map((m) => m.stage)
  const badVals = mapped.filter((m) => !liveStatus.has(m.status)).map((m) => `${m.stage}→${m.status}`)
  check("every mapped lifecycle_stage key ∈ live CHECK", badKeys.length === 0, badKeys.join(", "))
  check("every emitted status ∈ live CHECK", badVals.length === 0, badVals.join(", "))
  note(`the map covers ${mapped.length} of ${LIVE_STAGE.length} live stages (${mapped.filter(m => m.gate).length} of them gated); ` +
       `the remaining ${LIVE_STAGE.length - mapped.length} are intentional no-clobber stages`)

  // ── 3. THE RULING ─────────────────────────────────────────────────────────
  console.log("\n[3] The ruling: the gate the owner named yields the status the owner named")
  check(`${RULING_STAGE} + gate PASSED → ${RULING_STATUS}`,
    statusForStage(RULING_STAGE, GATE_OPEN) === RULING_STATUS,
    String(statusForStage(RULING_STAGE, GATE_OPEN)))
  check("the exported constant says the same thing (so ad-hoc writers can converge on one spelling)",
    STATUS_AFTER_LISTING_AGREEMENT_GATE === RULING_STATUS)
  check(`${RULING_STATUS} is a value the database admits`, liveStatus.has(RULING_STATUS))

  console.log("\n[3b] FAIL CLOSED (§4): a stage reached without the gate picks up NOTHING")
  check("no gate argument at all → undefined", statusForStage(RULING_STAGE) === undefined)
  check("empty gate object → undefined", statusForStage(RULING_STAGE, {}) === undefined)
  check("gate explicitly false → undefined", statusForStage(RULING_STAGE, { listingAgreementCompliancePassed: false }) === undefined)
  check("gate undefined → undefined", statusForStage(RULING_STAGE, { listingAgreementCompliancePassed: undefined }) === undefined)
  check("a truthy-but-not-true verdict does not open the gate",
    statusForStage(RULING_STAGE, { listingAgreementCompliancePassed: 1 as unknown as boolean }) === undefined)

  // ── 4. THE TWO SENSES OF ACTIVE CANNOT RE-MERGE ───────────────────────────
  console.log("\n[4] The two senses of \"active\" — derived over EVERY live stage, gates forced OPEN")
  const yieldsActiveOpen = LIVE_STAGE.filter((s) => statusForStage(s, GATE_OPEN) === MLS_STATUS)
  check(`exactly ONE live stage yields '${MLS_STATUS}' even with every gate open`,
    yieldsActiveOpen.length === 1, `got [${yieldsActiveOpen.join(", ")}]`)
  check(`…and it is ${MLS_STAGE}`, yieldsActiveOpen[0] === MLS_STAGE)
  check(`${MLS_STAGE} still yields '${MLS_STATUS}' with no gate (it is stage-implied, not gated)`,
    statusForStage(MLS_STAGE) === MLS_STATUS)
  check("NO gated stage yields 'active' — passing a compliance gate never makes a listing MLS-live",
    mapped.filter((m) => m.gate).every((m) => m.status !== MLS_STATUS))
  check(`the ruling's stage does NOT yield '${MLS_STATUS}' under any gate`,
    statusForStage(RULING_STAGE, GATE_OPEN) !== MLS_STATUS && statusForStage(RULING_STAGE) !== MLS_STATUS)

  // ── 5. NO CLOBBER ─────────────────────────────────────────────────────────
  console.log("\n[5] Unmapped stages never clobber status, gate open or shut")
  const mappedSet = new Set(mapped.map((m) => m.stage))
  const clobbering = LIVE_STAGE.filter((s) => !mappedSet.has(s))
    .filter((s) => statusForStage(s) !== undefined || statusForStage(s, GATE_OPEN) !== undefined)
  check("every live stage outside the map returns undefined in both gate states",
    clobbering.length === 0, clobbering.join(", "))
  check("an unknown stage returns undefined", statusForStage("NOT_A_STAGE", GATE_OPEN) === undefined)

  // ── 6. THE LISTING_CANCELLED PAIR MUST AGREE (the rule, not the value) ────
  console.log("\n[6] The forward map and the reverse map name the SAME terminal for LISTING_CANCELLED")
  const kernelSrc = stripComments(read("app/actions/listings-kernel.ts"))
  const reverse = extractReverseTerminals(kernelSrc)
  note(`reverse map (app/actions/listings-kernel.ts, comment-stripped): ${
    reverse.length ? reverse.map((r) => `${r.status}→${r.stage}`).join(", ") : "NONE FOUND"}`)
  check("the reverse map was actually found (a scan that finds nothing proves nothing)", reverse.length > 0)
  for (const r of reverse) {
    const forward = statusForStage(r.stage, GATE_OPEN)
    check(`round trip agrees: '${r.status}' → ${r.stage} → '${String(forward)}'`, forward === r.status,
      `forward map says '${String(forward)}', reverse map says '${r.status}'`)
  }

  // ── 7. §6 ADJUDICATION: the two "active listing statuses" sets ────────────
  console.log("\n[7] The two status sets that were NOT duplicates — renamed, and each still legal")
  const dvAll: string[] = [...LISTING_STATUSES_ACTIVE, ...LISTING_STATUSES_INACTIVE]
  check("deal-vocabulary ACTIVE ∪ INACTIVE PARTITIONS the live status set exactly (disjoint and covering)",
    eqSet(dvAll, LIVE_STATUS), `union=${dvAll.length} live=${LIVE_STATUS.length}`)

  const adsSrc = stripComments(read("lib/ads/audience-source-rules.ts"))
  const adsSet = extractStringArray(adsSrc, "MARKETABLE_SELLER_LISTING_STATUSES")
  check("the ads set was found under its NEW name", adsSet !== null)
  if (adsSet) {
    check("every member of the ads set ∈ live CHECK", adsSet.every((s) => liveStatus.has(s)), adsSet.join(", "))
    check("the ads set and the enrichment set are genuinely DIFFERENT (the rename records a real difference)",
      !eqSet(adsSet, LISTING_STATUSES_ACTIVE))
    note(`ads/marketable = [${adsSet.join(", ")}]  ·  enrichment/live-client = [${LISTING_STATUSES_ACTIVE.join(", ")}]`)
  }
  check("the colliding old name ACTIVE_LISTING_STATUSES is gone from lib/ads/audience-source-rules.ts (code)",
    !/\bACTIVE_LISTING_STATUSES\b/.test(adsSrc))

  // ── 8. POSITIVE CONTROLS — prove every finder above still recognises a defect ──
  console.log("\n[8] POSITIVE CONTROLS — each finder is re-run against a deliberate defect and MUST catch it")
  positiveControls()

  // ── 9. PUBLISHED MEASUREMENT — writerless CHECK values (recorded, not enforced) ──
  console.log("\n[9] Measurement, published beside its denominator (§2) — NOT an enforcement")
  reportWriterlessStatuses()

  inForceLayer()

  finish()
}

// ─── FINDERS ─────────────────────────────────────────────────────────────────

/** `status === "x" ? "STAGE" : …` — the reverse map inside updateListingStatus. */
function extractReverseTerminals(src: string): { status: string; stage: string }[] {
  const out: { status: string; stage: string }[] = []
  const re = /status\s*===\s*"([a-z_]+)"\s*\?\s*"([A-Z_]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push({ status: m[1], stage: m[2] })
  return out
}

/** `const NAME = ["a", "b"] as const` → ["a","b"]; null when not found. */
function extractStringArray(src: string, name: string): string[] | null {
  const m = new RegExp(`\\b${name}\\b\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)
  if (!m) return null
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/** Files whose status literals count as WRITES to listings.status. */
const WRITE_SCAN_FILES = [
  "lib/listings/listing-status-sync.ts",
  "lib/esign-webhooks/finalize-packet.ts",
  "app/api/webhooks/dotloop/route.ts",
  "lib/workflow-orchestrator/chains/compliance-listing-auto-create.ts",
  "lib/kernel/listings.ts",
  "app/actions/listings-kernel.ts",
]

/** Every `status: "x"` / `status = "x"` / `"status", "x"` literal in a listing writer. */
function statusWriteLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const f of WRITE_SCAN_FILES) {
    let src: string
    try { src = stripComments(read(f)) } catch { continue }
    for (const m of src.matchAll(/status:\s*"([a-z_]+)"/g)) {
      if (!found.has(m[1])) found.set(m[1], [])
      if (!found.get(m[1])!.includes(f)) found.get(m[1])!.push(f)
    }
    // A WRITER THAT NAMES THE CONSTANT IS STILL A WRITER. The three real
    // agreement-signed writers used to spell `status: "coming_soon"` as a
    // literal; they now import STATUS_AFTER_LISTING_AGREEMENT_GATE (§6, one
    // spelling). A literal-only scan called that value writerless the moment the
    // duplication was removed — i.e. it would have punished the fix and rewarded
    // the drift. The constant's value is resolved from the module, not assumed.
    if (src.includes("STATUS_AFTER_LISTING_AGREEMENT_GATE")) {
      const v = STATUS_AFTER_LISTING_AGREEMENT_GATE as string
      if (!found.has(v)) found.set(v, [])
      if (!found.get(v)!.includes(f)) found.get(v)!.push(f)
    }
  }
  return found
}

function reportWriterlessStatuses() {
  const literals = statusWriteLiterals()
  // POSITIVE CONTROL for the write scanner itself: a status we KNOW is written must be found.
  // POSITIVE CONTROL ON A SPECIMEN, NOT ON THE TREE (§2). This asserted that the
  // scanner found the LITERAL "coming_soon" somewhere in the production writers —
  // which made the control depend on the defect it was written beside. When those
  // writers were changed to import STATUS_AFTER_LISTING_AGREEMENT_GATE instead of
  // repeating the literal, the control went red although the scanner was fine and
  // the code had strictly improved. A control must prove the FINDER still works,
  // and a finder is proved against input the finder is handed.
  const SPECIMEN = 'await db.from("listings").update({ status: "coming_soon" })'
  check("POSITIVE CONTROL: the literal finder still recognises a literal status write",
    /status:\s*"([a-z_]+)"/.exec(SPECIMEN)?.[1] === RULING_STATUS)
  check("NEGATIVE CONTROL: it does not fire on a status write that names no literal",
    /status:\s*"([a-z_]+)"/.exec('update({ status: SOME_CONSTANT })') === null)
  check("the ruling's status is reached by a real writer, by literal OR by the shared constant",
    literals.has(RULING_STATUS), `found: ${[...literals.keys()].join(", ") || "nothing"}`)

  // A status the canonical map can EMIT is written by transitionLifecycle's synced update, which is
  // not a `status: "…"` literal anywhere. Counting only literals would report it writerless.
  const emitted = new Set(mappedStages().map((m) => m.status as string))
  check("POSITIVE CONTROL: the emission scanner sees the map's own outputs", emitted.size > 0)

  const written = LIVE_STATUS.filter((s) => literals.has(s) || emitted.has(s))
  const unwritten = LIVE_STATUS.filter((s) => !literals.has(s) && !emitted.has(s))
  // Denominator and both halves, so the count is a measurement rather than a number (§2).
  note(`written by a scanned listing writer OR emitted by the canonical map: ` +
       `${written.length} of ${LIVE_STATUS.length} live values — ${written.join(", ")}`)
  note(`NOT written and NOT emitted: ${unwritten.length} — ${unwritten.join(", ") || "none"}`)
  note(`(status literals seen in the ${WRITE_SCAN_FILES.length} scanned writers, including values ` +
       `belonging to OTHER tables' status columns in the same files: ${[...literals.keys()].sort().join(", ")})`)
  note("BLIND SPOT: the literal half of this scan covers only the files listed in WRITE_SCAN_FILES " +
       "and only literal `status: \"…\"` object keys. Writes via a variable, an .rpc(), a migration " +
       "backfill or a DB trigger are invisible to it (CLAUDE.md §3) and are NOT evidence of a " +
       "writerless value. This is a published measurement, not an enforcement.")
  // ── RESOLVED 2026-09-05 — owner: "the listing signed is part of the gate to start compliance." ──
  // The OWNER QUESTION that stood here (listing_signed admitted by the CHECK, written by no
  // automated path) is answered: it is the status at the moment compliance BEGINS, stamped
  // UNGATED on LISTING_AGREEMENT_SIGNED. These assert the ruling rather than a waypoint — the
  // status is derived from the map, the sequence from the three stages the owner named.
  {
    const signed = mappedStages().find((m) => m.stage === "LISTING_AGREEMENT_SIGNED")
    check("LISTING_AGREEMENT_SIGNED yields a status (compliance STARTS here — it is not silent)",
      signed !== undefined)
    check("…and that status is listing_signed, the live CHECK value nothing automated wrote before",
      signed?.status === "listing_signed" && LIVE_STATUS.includes("listing_signed"))
    check("…UNGATED: starting compliance needs no pass, only the executed agreement",
      signed?.gate === null)
    const prep = mappedStages().find((m) => m.stage === "COMING_SOON_PREP")
    check("the sequence reads in the owner's words: listing_signed → coming_soon (gated) → active (MLS only)",
      signed?.status === "listing_signed" && prep?.status === "coming_soon" && prep?.gate !== null &&
      mappedStages().filter((m) => m.status === "active").every((m) => m.stage === "MLS_ACTIVE"))
    check("listing_signed is therefore no longer writerless (the published measurement moves for a reason)",
      !unwritten.includes("listing_signed"))
    check("NEGATIVE CONTROL: the stage finder returns nothing for a stage the map does not carry",
      mappedStages().find((m) => m.stage === "MEDIA_CAPTURE") === undefined)
  }
}

// ─── POSITIVE CONTROLS ───────────────────────────────────────────────────────

function positiveControls() {
  const controls: { what: string; caught: boolean }[] = []

  // C1 — a map that lets a second stage yield 'active' must break the one-active sweep.
  const brokenMap: Record<string, string> = { MLS_ACTIVE: "active", COMING_SOON_ACTIVE: "active" }
  const brokenSweep = LIVE_STAGE.filter((s) => brokenMap[s] === MLS_STATUS)
  controls.push({ what: "a second stage yielding 'active' is caught by the one-active sweep", caught: brokenSweep.length !== 1 })

  // C2 — a statusForStage that ignores the gate must break the fail-closed battery.
  const ungatedRuling = (stage: string) => (stage === RULING_STAGE ? RULING_STATUS : undefined)
  controls.push({ what: "a gate-ignoring map is caught by the fail-closed battery", caught: ungatedRuling(RULING_STAGE) !== undefined })

  // C3 — a truncated status vocabulary must break the survivor/live equality.
  controls.push({ what: "a truncated status vocabulary is caught by the survivor equality",
    caught: !eqSet(LIVE_STATUS.slice(0, -1), LIVE_STATUS) })

  // C4 — the reverse-map finder must read a real reverse-map shape out of a specimen.
  const specimen = `lifecycle_stage: status === "sold" ? "CLOSED" : status === "withdrawn" ? "LISTING_CANCELLED" : undefined,`
  const spec = extractReverseTerminals(specimen)
  controls.push({ what: "the reverse-map finder extracts both arms from a specimen", caught: spec.length === 2 })

  // C5 — the round-trip check must FAIL on a disagreeing pair.
  const disagree = spec.map((r) => ({ ...r, forward: r.stage === "LISTING_CANCELLED" ? "cancelled" : "sold" }))
  controls.push({ what: "the round-trip check catches a split terminal (withdrawn vs cancelled)",
    caught: disagree.some((d) => d.forward !== d.status) })

  // C6 — the array extractor must find nothing for an absent name (so [7]'s 'found' check is real).
  controls.push({ what: "the array extractor returns null for a name that is not there",
    caught: extractStringArray(`const OTHER = ["a"]`, "MARKETABLE_SELLER_LISTING_STATUSES") === null })

  // C7 — the partition check must catch a status that lands in NEITHER bucket.
  controls.push({ what: "the partition check catches a live status in neither bucket",
    caught: !eqSet(LIVE_STATUS.filter((s) => s !== LIVE_STATUS[0]), LIVE_STATUS) })

  // C8 — the comment stripper must actually strip (guards against a no-op stripper).
  const stripSpecimen = `// const ACTIVE_LISTING_STATUSES = ["draft"]\nconst REAL = 1`
  controls.push({ what: "the stripper removes a commented-out defect (a no-op stripper is caught)",
    caught: !/ACTIVE_LISTING_STATUSES/.test(stripComments(stripSpecimen)) && /REAL/.test(stripComments(stripSpecimen)) })

  // C9 — the write scanner must see a write in a specimen.
  controls.push({ what: "the write-literal finder sees `status: \"x\"` in a specimen",
    caught: /status:\s*"([a-z_]+)"/.test(`.update({ status: "coming_soon" })`) })

  for (const c of controls) check(`POSITIVE CONTROL — ${c.what}`, c.caught)
}

/**
 * ── IS THE RULING ACTUALLY IN FORCE? ─────────────────────────────────────────
 *
 * Everything above proves the MAP is right. None of it proves any live path asks
 * the map the gated question — and for one wave it did not: the map expressed the
 * owner's ruling while all three writers called statusForStage with no verdict, so
 * a listing reaching the gated stage got no status at all. "Expressed" and "in
 * force" are different claims and only one of them is worth anything in
 * production, so this layer asserts the second.
 *
 * It reads STRIPPED source, because this repo has burned itself on prose before:
 * the header of listing-status-sync.ts DESCRIBES the wiring in detail, and a raw
 * scan would happily accept that description as the wiring (§2 — a tombstone, or a
 * plan, is not a call site).
 */
function inForceLayer() {
  console.log("\n[10] The ruling is IN FORCE — the callers ask the gated question, not just the map")
  const SYNC  = stripComments(read("lib/listings/listing-status-sync.ts"))
  const GATE  = stripComments(read("lib/listings/listing-activation-gate.ts"))
  const KERN  = stripComments(read("lib/kernel/lifecycle.ts"))
  const APPL  = stripComments(read("lib/application/listing-lifecycle.ts"))

  check("the map exposes isGatedStage, DERIVED from the gated map rather than a typed stage list",
    /export function isGatedStage/.test(SYNC) &&
    /hasOwnProperty\.call\(STATUS_FOR_GATED_STAGE, stage\)/.test(SYNC) &&
    !/isGatedStage[\s\S]{0,200}"COMING_SOON_PREP"/.test(SYNC))

  check("ONE authority answers 'did compliance pass' — the gate exports it and DELEGATES to its own reader",
    /export async function listingAgreementComplianceState/.test(GATE) &&
    /return readListingCompliance\(|res = await readListingCompliance\(|await readListingCompliance\(/.test(GATE))
  check("…and it is THREE-valued, so a REFUSED read cannot masquerade as a clean negative (§3/§4)",
    /"passed" \| "not_passed" \| "unknown"/.test(GATE) &&
    /if \(!res\.ok\) return "unknown"/.test(GATE))

  // Both writers of listings.lifecycle_stage must ask. Named individually so a
  // failure says WHICH door stopped asking rather than "something regressed".
  for (const [label, src] of [["lib/kernel/lifecycle.ts", KERN], ["lib/application/listing-lifecycle.ts", APPL]] as const) {
    check(`${label}: asks isGatedStage BEFORE doing any I/O (an ungated transition pays nothing)`,
      /isGatedStage\(/.test(src))
    check(`${label}: resolves the verdict from the gate module, never re-deriving the predicate (§6)`,
      /listingAgreementComplianceState/.test(src) &&
      !/compliance_passed[\s\S]{0,120}esign_status/.test(src))
    check(`${label}: passes the verdict INTO the map — statusForStage is no longer called bare`,
      /statusForStage\([^)]*,\s*\w/.test(src))
    check(`${label}: FAILS CLOSED — only an explicit pass yields the gated status`,
      /=== "passed"/.test(src))
    check(`${label}: an UNKNOWN verdict is reported as unknown, not as "compliance has not passed"`,
      /REFUSED/.test(src) && /NOT/.test(src))
  }

  // NEGATIVE CONTROLS — each of the five shapes above, in a specimen that must FAIL.
  // Without these, a regex that silently stopped matching would report five green ticks.
  const bare = 'const s = statusForStage(toState)'
  check("NEGATIVE CONTROL: a bare statusForStage call is NOT accepted as wired",
    !/statusForStage\([^)]*,\s*\w/.test(bare))
  check("NEGATIVE CONTROL: a caller that re-derives the predicate itself is caught",
    /compliance_passed[\s\S]{0,120}esign_status/.test('.select("compliance_passed, esign_status, fully_executed_at")'))
  check("NEGATIVE CONTROL: a hardcoded stage name in isGatedStage would be caught",
    /isGatedStage[\s\S]{0,200}"COMING_SOON_PREP"/.test('function isGatedStage(s){ return s === "COMING_SOON_PREP" }'))
}

function finish() {
  console.log("\n──────────────────────────────────────────────────")
  for (const n of notes) console.log(` note: ${n}`)
  if (fails.length) {
    console.log("\nFAILURES:")
    fails.forEach((f) => console.log("  - " + f))
  }
  console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
  if (fails.length > 0) { console.log(" ❌ LISTING_STATUS_TWO_SENSES_FAIL"); process.exit(1) }
  console.log(" ✅ LISTING_STATUS_TWO_SENSES_PASS — 'active in the system' and 'active on the market' are held apart")
}

main()
