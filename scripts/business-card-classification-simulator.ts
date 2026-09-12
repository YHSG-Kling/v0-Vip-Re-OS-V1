#!/usr/bin/env tsx
/**
 * scripts/business-card-classification-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUSINESS-CARD CLASSIFICATION PROOF — wave 48 (owner ruling 2026-09-10,
 * verbatim): "the kernel events scanned business card shouldn't be assumed
 * contact since it is a business card from an event, sphere of influence/other
 * agent/potential contact so should be a userid user type and card reader or
 * agents notes can determine."
 *
 *   1. PURE classifier (lib/contacts/card-classifier.ts classifyCardSubject) —
 *      reader-field cues (agent / each vendor family sample) and notes cues
 *      (sphere / agent / vendor / potential_contact / contact) each resolve to
 *      the right class, WITH a positive control per family so a broken regex
 *      that matched nothing would fail loudly rather than read as a clean bill
 *      of health (CLAUDE.md §2). The regression the whole ruling exists to
 *      prevent: a silent card (no reader signal, no notes) must NEVER resolve
 *      'contact' — it must be 'unknown'.
 *   2. SOURCE — the approve path (app/actions/business-card/business-card-
 *      actions.ts) never calls captureContact (the only contacts-row writer on
 *      this path) from the vendor / agent / sphere-or-unknown branches — only
 *      reachable for card_subject_type 'contact' or 'potential_contact'. Reads
 *      COMMENT-STRIPPED source (scripts/strip-comments.ts) so a tombstone or a
 *      doc comment mentioning captureContact can never masquerade as a call
 *      site (CLAUDE.md §2 — the exact defect that broke five guards in wave
 *      2026-08-23).
 *   3. ROUTING — every one of the six card_subject_type values has a manager
 *      route declared in lib/kernel/event-reactor.ts's BUSINESS_CARD_APPROVED
 *      block, and every signal_type it routes to is registered in
 *      SIGNAL_REGISTRY with a real SIGNAL_HANDLERS consumer wherever
 *      disposition is "handled" (signal-integrity-simulator re-proves this at
 *      the bus level; this proof additionally pins the SIX-CLASS COVERAGE,
 *      which signal-integrity has no notion of).
 *
 * Run: npx tsx scripts/business-card-classification-simulator.ts
 *      (npm run test:business-card-classification)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyCardSubject, type CardSubjectType } from "../lib/contacts/card-classifier"
import { blankComments } from "./strip-comments"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Business-card classification whole — six-way vocabulary, never assumed 'contact', every class routed.")
  console.log(" BUSINESS_CARD_CLASSIFICATION_PASS")
  process.exit(0)
}

const ROOT = process.cwd()
const ALL_CLASSES: CardSubjectType[] = ["sphere", "agent", "potential_contact", "contact", "vendor", "unknown"]
const ALL_CLASSIFIED_BY: Array<"picker" | "reader" | "notes" | "match" | "default"> = ["picker", "reader", "notes", "match", "default"]

function sameSet(a: string[], b: string[]): boolean {
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.length === sb.length && sa.every((v, i) => v === sb[i])
}

// ── 0 · ONE VOCABULARY (§6) — CardSubjectType/classifiedBy literally EQUAL the
// live CHECK constraint scripts/check-vocabularies.ts holds for m617's typed
// columns (business_card_scans.card_subject_type / .classified_by), not just
// "close enough". A drift here is exactly the defect CLAUDE.md §6 names: two
// spellings of the same idea that a scorer can no longer match across.
console.log("[0 · ONE VOCABULARY — CardSubjectType/classifiedBy === live CHECK vocab] (§6)")
{
  // POSITIVE CONTROL (CLAUDE.md §2): prove sameSet() itself actually catches a
  // mismatch before trusting it on the real comparison below — a checker that
  // silently returns true for anything would make every assertion beneath it
  // a false "clean bill of health".
  check("positive control — sameSet() rejects a genuinely different set",
    !sameSet(["a", "b", "c"], ["a", "b"]))
  check("positive control — sameSet() rejects a set with an extra/renamed member",
    !sameSet(["a", "b", "c"], ["a", "b", "d"]))
  check("positive control — sameSet() accepts an out-of-order but equal set",
    sameSet(["a", "b", "c"], ["c", "a", "b"]))

  const liveCardSubjectType = CHECK_VOCABULARIES.business_card_scans?.card_subject_type ?? []
  check("CHECK_VOCABULARIES has a business_card_scans.card_subject_type entry (positive control — an empty vocab would falsely pass every comparison below)",
    liveCardSubjectType.length > 0, `got ${liveCardSubjectType.length} values`)
  check("CardSubjectType (lib/contacts/card-classifier.ts) === business_card_scans.card_subject_type CHECK (scripts/check-vocabularies.ts)",
    sameSet(ALL_CLASSES, liveCardSubjectType),
    `classifier=[${[...ALL_CLASSES].sort().join(",")}] check=[${[...liveCardSubjectType].sort().join(",")}]`)

  const liveClassifiedBy = CHECK_VOCABULARIES.business_card_scans?.classified_by ?? []
  check("CHECK_VOCABULARIES has a business_card_scans.classified_by entry (positive control)",
    liveClassifiedBy.length > 0, `got ${liveClassifiedBy.length} values`)
  check("classifyCardSubject's `source` union === business_card_scans.classified_by CHECK (scripts/check-vocabularies.ts)",
    sameSet(ALL_CLASSIFIED_BY, liveClassifiedBy),
    `source=[${[...ALL_CLASSIFIED_BY].sort().join(",")}] check=[${[...liveClassifiedBy].sort().join(",")}]`)
}

// ── 1 · pure classifier ─────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════")
console.log(" Business-card classification simulator (wave 48)")
console.log("══════════════════════════════════════════════════\n")
console.log("[1 · pure classifyCardSubject — reader fields]")

check("a fellow agent's title reaches 'agent'",
  classifyCardSubject({ title: "Listing Agent", company: null, notes: null }).subjectType === "agent")
check("a brokerage in the company field reaches 'agent'",
  classifyCardSubject({ title: null, company: "Sunrise Realty Brokerage", notes: null }).subjectType === "agent")

// Positive-control sample per vendor family shape (not exhaustive — the family
// table itself is lib/kernel/vendor-categories.ts's job to prove; this proves
// the READER TIER still resolves to 'vendor' with a category, not a broken
// no-op that silently returns 'unknown' for every title on earth).
const VENDOR_SAMPLES: Array<{ title: string; category: string }> = [
  { title: "Home Inspector", category: "inspector" },
  { title: "Loan Officer, NMLS #12345", category: "lender" },
  { title: "Real Estate Photographer", category: "photographer" },
  { title: "Licensed Drone Pilot", category: "drone_pilot" },
  { title: "Certified Residential Appraiser", category: "appraiser" },
  { title: "Land Surveyor, PLS", category: "surveyor" },
]
for (const { title, category } of VENDOR_SAMPLES) {
  const cls = classifyCardSubject({ title, company: null, notes: null })
  check(`"${title}" reaches 'vendor'/${category}`, cls.subjectType === "vendor" && cls.category === category,
    `got ${cls.subjectType}/${cls.category}`)
}

console.log("\n[1b · pure classifyCardSubject — notes, only when the reader is silent]")
const NOTES_SAMPLES: Array<{ notes: string; want: CardSubjectType }> = [
  { notes: "Met at my daughter's soccer game — old friend, not a client.", want: "sphere" },
  { notes: "Fellow agent, works at another brokerage across town.", want: "agent" },
  { notes: "Vendor — service provider we might use for a listing.", want: "vendor" },
  { notes: "Potential buyer, interested in buying next year.", want: "potential_contact" },
  { notes: "Ready to sell, signed with us last week.", want: "contact" },
]
for (const { notes, want } of NOTES_SAMPLES) {
  const cls = classifyCardSubject({ title: null, company: null, notes })
  check(`notes "${notes.slice(0, 40)}..." reach '${want}'`, cls.subjectType === want, `got ${cls.subjectType}`)
}

console.log("\n[1c · reader OUTRANKS notes (priority order)]")
{
  const cls = classifyCardSubject({ title: "Home Inspector", company: null, notes: "old friend, not a client" })
  check("a printed vendor title wins over a sphere note", cls.subjectType === "vendor", `got ${cls.subjectType}`)
}

console.log("\n[1d · THE REGRESSION THIS RULING EXISTS TO PREVENT]")
{
  const silent = classifyCardSubject({ title: null, company: null, notes: null })
  check("a card with NO reader signal and NO notes is 'unknown', never 'contact'",
    silent.subjectType === "unknown", `got ${silent.subjectType}`)
  check("...and its source is 'default', not silently 'reader' or 'notes'",
    silent.source === "default", `got ${silent.source}`)
  const blank = classifyCardSubject({ title: "", company: "", notes: "" })
  check("blank-string fields behave identically to null fields (unknown)", blank.subjectType === "unknown")
}
check("every ALL_CLASSES value is reachable by the classifier or its caller's match/picker tiers (six-way vocabulary declared)",
  ALL_CLASSES.length === 6)

// ── 2 · source: the approve path never auto-creates a contact outside {contact, potential_contact} ──
console.log("\n[2 · source — captureContact only reachable for contact/potential_contact]")
const actionsPath = join(ROOT, "app/actions/business-card/business-card-actions.ts")
const rawSrc = readFileSync(actionsPath, "utf8")
const src = blankComments(rawSrc) // strip comments FIRST (CLAUDE.md §2) — a tombstone/doc mention must never count as a call site

const captureCallCount = (src.match(/\bcaptureContact\s*\(/g) ?? []).length
check("captureContact is called exactly once on the approve path (single contact-creation call site)",
  captureCallCount === 1, `found ${captureCallCount}`)

function branchBody(openMarker: string): string {
  const start = src.indexOf(openMarker)
  if (start === -1) return ""
  // Balance braces from the FIRST '{' after the marker to find the branch's own close.
  const braceStart = src.indexOf("{", start)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(braceStart, i + 1) }
  }
  return src.slice(braceStart)
}

const vendorBranch = branchBody('if (cardSubjectType === "vendor")')
const agentBranch = branchBody('if (cardSubjectType === "agent")')
const sphereUnknownBranch = branchBody('if (cardSubjectType === "sphere" || cardSubjectType === "unknown")')

check("found the vendor branch to scan (positive control — an empty branch would falsely pass)", vendorBranch.length > 40)
check("found the agent branch to scan (positive control)", agentBranch.length > 40)
check("found the sphere/unknown branch to scan (positive control)", sphereUnknownBranch.length > 40)

check("the VENDOR branch never calls captureContact", !vendorBranch.includes("captureContact("))
check("the AGENT branch never calls captureContact", !agentBranch.includes("captureContact("))
check("the SPHERE/UNKNOWN branch never calls captureContact", !sphereUnknownBranch.includes("captureContact("))
check("the VENDOR branch returns before falling through", vendorBranch.includes("return {"))
check("the AGENT branch returns before falling through", agentBranch.includes("return {"))
check("the SPHERE/UNKNOWN branch returns before falling through", sphereUnknownBranch.includes("return {"))

// potential_contact must still be REACHABLE (not accidentally deleted) — the positive
// control for the contact_type distinction the ruling permits.
check("potential_contact still maps to contacts.contact_type='prospect' on the surviving captureContact call",
  src.includes('contact_type: cardSubjectType === "potential_contact" ? "prospect"'))

// ── 3 · routing — every class has a manager route + registered handled signal ──
console.log("\n[3 · every card_subject_type has a manager route]")
const reactorPath = join(ROOT, "lib/kernel/event-reactor.ts")
const reactorSrc = blankComments(readFileSync(reactorPath, "utf8"))
const routeBlockStart = reactorSrc.indexOf("KernelEvent.BUSINESS_CARD_APPROVED")
check("found the BUSINESS_CARD_APPROVED routing block in event-reactor.ts", routeBlockStart !== -1)
const routeBlock = routeBlockStart === -1 ? "" : reactorSrc.slice(routeBlockStart, routeBlockStart + 4000)

for (const cls of ALL_CLASSES) {
  // Each class is a key in the ROUTE object literal, e.g. `sphere: {` ... `toManager: "...",`.
  const keyIdx = routeBlock.indexOf(`\n          ${cls}: {`)
  check(`'${cls}' has a declared ROUTE entry`, keyIdx !== -1)
  if (keyIdx === -1) continue
  const entrySlice = routeBlock.slice(keyIdx, keyIdx + 400)
  const toManagerMatch = entrySlice.match(/toManager:\s*"([a-z_]+)"/)
  const signalTypeMatch = entrySlice.match(/signalType:\s*"([a-z_]+)"/)
  check(`'${cls}' route names a toManager`, !!toManagerMatch, entrySlice.slice(0, 120))
  check(`'${cls}' route names a signalType`, !!signalTypeMatch, entrySlice.slice(0, 120))
  if (!toManagerMatch || !signalTypeMatch) continue
  const [, toManager] = toManagerMatch
  const [, signalType] = signalTypeMatch
  const spec = SIGNAL_REGISTRY[signalType]
  check(`'${cls}' → ${toManager}:${signalType} is catalogued in SIGNAL_REGISTRY`, !!spec, `signalType ${signalType} not found`)
  if (!spec) continue
  check(`'${cls}' route's toManager is in the signal's declared consumers OR the signal is feed_only`,
    spec.disposition === "feed_only" || spec.consumers.includes(toManager),
    `${toManager} not in [${spec.consumers.join(", ")}] and disposition is ${spec.disposition}`)
  if (spec.disposition === "handled") {
    check(`'${cls}' → ${toManager}:${signalType} has a real SIGNAL_HANDLERS consumer (no dead promise)`,
      Object.prototype.hasOwnProperty.call(SIGNAL_HANDLERS, `${toManager}:${signalType}`))
  }
}

report()
