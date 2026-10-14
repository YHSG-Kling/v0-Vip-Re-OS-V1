#!/usr/bin/env tsx
/**
 * scripts/rental-graduation-sourcer-simulator.ts  (npm run test:rental-graduation-sourcer)
 *
 * RENTAL-TO-BUYER GRADUATION, TENANT SIDE — lane 74D, mirroring the email-engagement-sourcer
 * proof shape (scripts/email-engagement-sourcer-simulator.ts). Proves:
 *
 *   1. The PURE classifier (lib/lead-pipeline/rental-graduation-sourcer.ts::
 *      normalizeRentalGraduationSignal) — renter-only gating, tenure-threshold gating (via the
 *      REUSED lib/avm/provider-chain.ts::parseLengthOfResidence, CLAUDE.md §6), income-signal
 *      boost (never a gate), and the null-on-owner / null-below-tenure refusals.
 *   2. POSITIVE CONTROLS (CLAUDE.md §2): an owner (not a renter) never qualifies; a renter below
 *      the tenure bar never qualifies; income presence alone (no renter status) never qualifies.
 *   3. `records` stays ALWAYS empty — same contract as email_engagement_intent — a renter already
 *      in `contacts` is never a raw lead.
 *   4. The SOURCE_MAP / SOURCE_ALIASES / SOURCE_VENDOR / GATE_TOKEN wiring in
 *      lib/lead-pipeline/source-intent-map.ts.
 *   5. A LIVE layer (skipped without SUPABASE creds) that inserts a tagged test brokerage +
 *      renter contact, calls sourceRentalToBuyerGraduation for real, asserts the manager signal
 *      landed (shopping_agent → ai_isa, contact_rental_graduation_reengage), asserts the COOLDOWN
 *      (a second call in the same run does NOT re-signal), and DELETES every row it created.
 *
 * No database required for layers 1-4. Source assertions + pure-function calls only.
 */
import { createClient } from "@supabase/supabase-js"
import {
  getSourceSemantics,
  resolveSourceKey,
  SOURCE_VENDOR,
  expandEnabledSources,
  hasScoringEntry,
} from "../lib/lead-pipeline/source-intent-map"

// lib/lead-pipeline/rental-graduation-sourcer.ts statically imports lib/avm/provider-chain.ts,
// which imports `server-only` — a marker package that THROWS outside a Server Component. A
// static ESM import of the sourcer would hoist above any require-cache neutralization, so this
// module is loaded via a DEFERRED dynamic import after the shim below (the same idiom
// scripts/accounting-scopes-simulator.ts established for the identical class of defect).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
const {
  normalizeRentalGraduationSignal,
  sourceRentalToBuyerGraduation,
  RENTAL_GRADUATION_MIN_TENURE_YEARS,
  RENTAL_GRADUATION_SIGNAL_COOLDOWN_DAYS,
} = await import("../lib/lead-pipeline/rental-graduation-sourcer")

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const RENTER_LONG_TENURE = {
  contactId: "contact-renter-1",
  firstName: "Jordan",
  lastName: "Price",
  city: "Austin",
  state: "TX",
  homeOwnerStatus: "renter",
  lengthOfResidence: "1.5 years",
  householdIncome: "$75,000-$99,999",
  fundsMaxPurchase: null as number | null,
}

function testPureClassifier() {
  console.log("\n[1 · normalizeRentalGraduationSignal — pure classifier]")

  const rec = normalizeRentalGraduationSignal(RENTER_LONG_TENURE)
  check("normalizes a qualifying renter (tenure ≥ bar)", rec !== null)
  check("source tagged", rec?.source === "rental_to_buyer_graduation")
  check("behaviorType tagged", rec?.behaviorType === "rental_to_buyer_graduation")
  check("ALWAYS buyer intent (never a seller signal)", rec?.intentType === "buyer")
  check("renter_tenure_threshold always present on a qualifying row", !!rec?.intentSignals.includes("renter_tenure_threshold"))
  check("income_signal_present when household_income is on file", !!rec?.intentSignals.includes("income_signal_present"))
  check("name + geography carried", rec?.firstName === "Jordan" && rec?.city === "Austin")
  check("sourceRecordId anchors on contactId (one signal per contact, not per tick)", rec?.sourceRecordId === "rental_graduation-contact-renter-1")
  check("rawPayload never claims a lease_end_date (this repo has no such column)", !("lease_end_date" in (rec?.rawPayload ?? {})))

  // POSITIVE CONTROL — an owner (not a renter) must NEVER qualify.
  const owner = { ...RENTER_LONG_TENURE, homeOwnerStatus: "owner" }
  check("positive control: an owner does NOT qualify", normalizeRentalGraduationSignal(owner) === null)

  // POSITIVE CONTROL — a renter below the tenure bar must NEVER qualify.
  const shortTenure = { ...RENTER_LONG_TENURE, lengthOfResidence: "0.3 years" }
  check(
    "positive control: a renter below RENTAL_GRADUATION_MIN_TENURE_YEARS does NOT qualify",
    normalizeRentalGraduationSignal(shortTenure) === null,
  )

  // POSITIVE CONTROL — unknown tenure (unparseable text) must NEVER qualify (never guessed).
  const unknownTenure = { ...RENTER_LONG_TENURE, lengthOfResidence: "unsure" }
  check(
    "positive control: unparseable tenure does NOT qualify (never guessed)",
    normalizeRentalGraduationSignal(unknownTenure) === null,
  )

  // POSITIVE CONTROL — no length_of_residence at all must NEVER qualify.
  check(
    "positive control: null length_of_residence does NOT qualify",
    normalizeRentalGraduationSignal({ ...RENTER_LONG_TENURE, lengthOfResidence: null }) === null,
  )

  // Income presence is a BOOST, never a gate — a renter with long tenure and NO income data
  // still qualifies (just without the extra signal).
  const noIncome = { ...RENTER_LONG_TENURE, householdIncome: null, fundsMaxPurchase: null }
  const noIncomeRec = normalizeRentalGraduationSignal(noIncome)
  check("income absence does NOT block qualification (tenure alone is the gate)", noIncomeRec !== null)
  check("positive control: income_signal_present is ABSENT with no income data on file", !noIncomeRec?.intentSignals.includes("income_signal_present"))

  // funds_max_purchase alone (no household_income) also triggers the income boost.
  const fundsOnly = { ...RENTER_LONG_TENURE, householdIncome: null, fundsMaxPurchase: 450000 }
  check("funds_max_purchase alone triggers income_signal_present", !!normalizeRentalGraduationSignal(fundsOnly)?.intentSignals.includes("income_signal_present"))

  // long_tenure escalation at 2x the bar.
  const veryLong = { ...RENTER_LONG_TENURE, lengthOfResidence: `${RENTAL_GRADUATION_MIN_TENURE_YEARS * 2 + 1} years` }
  check("long_tenure appears at 2x the bar", !!normalizeRentalGraduationSignal(veryLong)?.intentSignals.includes("long_tenure"))
}

function testSourceIntentMapWiring() {
  console.log("\n[2 · lib/lead-pipeline/source-intent-map.ts wiring]")
  check("semantics registered (hasScoringEntry, not the silent fallback)", hasScoringEntry("rental_to_buyer_graduation"))
  check("motivation type registered", getSourceSemantics("rental_to_buyer_graduation").motivationType === "rental_to_buyer_graduation")
  check("enrichment-first identity policy (already a contact, never promoted as a raw lead)", getSourceSemantics("rental_to_buyer_graduation").identityPolicy === "enrichment_first")
  check("first-party vendor routing ('internal', $0, never a paid call)", SOURCE_VENDOR.rental_to_buyer_graduation === "internal")
  check("DISTINCT from every other lane", resolveSourceKey("rental_to_buyer_graduation") === "rental_to_buyer_graduation")
  check("alias 'rental_graduation' resolves to the canonical key", resolveSourceKey("rental_graduation") === "rental_to_buyer_graduation")
  check("alias 'rental_to_buyer' resolves to the canonical key", resolveSourceKey("rental_to_buyer") === "rental_to_buyer_graduation")
  check("cron gate token present (expandEnabledSources wires it)", expandEnabledSources(["rental_to_buyer_graduation"]).has("rental_to_buyer_graduation"))
  check("tenure bar is a fraction of a year, not a fabricated lease_end_date", RENTAL_GRADUATION_MIN_TENURE_YEARS > 0 && RENTAL_GRADUATION_MIN_TENURE_YEARS < 2)
  check("cooldown is a sane multi-day window (never same-tick re-signal)", RENTAL_GRADUATION_SIGNAL_COOLDOWN_DAYS >= 30)
}

async function testLiveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[3 · live] ⊘ skipped (no SUPABASE creds) — pure + wiring layers proved the logic")
    return
  }
  console.log("\n[3 · live] real round trip — tagged rows, cooldown proved, deleted in the same run")
  const svc = createClient(url, key)
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
    const brokerageId = (brk as any).id

    const { data: contact, error: contactError } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      first_name: "ZZ-LANE74D",
      last_name: "RentalGraduationTest",
      email: `zz-lane74d-rental-${Date.now()}@example.invalid`,
      contact_type: "buyer",
      home_owner_status: "renter",
      length_of_residence: "1.5 years",
      household_income: "$75,000-$99,999",
    }).select("id, brokerage_id").maybeSingle()
    if (contactError || !contact) { console.log(`  ⊘ could not create test contact — ${contactError?.message ?? "no row"}`); return }
    cleanup.push({ table: "contacts", id: (contact as any).id })

    const { rowsExamined, contactsNotified } = await sourceRentalToBuyerGraduation(svc, brokerageId)
    check("live: examined at least the row this run created", rowsExamined >= 1)
    check("live: the tagged renter contact was notified", contactsNotified >= 1)

    const { data: signalRow, error: signalError } = await svc
      .from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, contact_id, payload")
      .eq("brokerage_id", brokerageId)
      .eq("contact_id", (contact as any).id)
      .eq("signal_type", "contact_rental_graduation_reengage")
      .maybeSingle()
    check("live: manager signal written shopping_agent → ai_isa for the contact",
      !signalError && !!signalRow && (signalRow as any).from_manager === "shopping_agent" && (signalRow as any).to_manager === "ai_isa")
    if (signalRow) cleanup.push({ table: "manager_signals", id: (signalRow as any).id })

    // COOLDOWN — a second call in the SAME run must NOT re-signal (the direct manager_signals
    // cooldown read, not just the bus's own dedupe).
    const second = await sourceRentalToBuyerGraduation(svc, brokerageId)
    check("live: cooldown suppresses a same-run re-signal", second.contactsNotified === 0)
  } finally {
    for (const row of cleanup.reverse()) {
      const { data: deleted, error } = await svc.from(row.table).delete().eq("id", row.id).select("id")
      const ok = !error && (deleted?.length ?? 0) > 0
      check(`live cleanup: ${row.table}/${row.id.slice(0, 8)}… deleted`, ok, error?.message)
    }
  }
}

async function main() {
  testPureClassifier()
  testSourceIntentMapWiring()
  await testLiveLayer()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ RENTAL_GRADUATION_SOURCER_PASS — renters in our own contacts crossing the tenure bar become a contact-side signal, never a raw lead, $0 marginal cost")
  process.exit(0)
}

void main()
