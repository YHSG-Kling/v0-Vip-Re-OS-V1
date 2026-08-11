#!/usr/bin/env tsx
/**
 * scripts/transaction-parties-notify-simulator.ts   (npm run test:parties-notify)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 10, obligation 5: "once the transaction is created, the terms/dates need to be saved to
 * the transaction and all parties of the transaction notified of such info, dates, contingencies,
 * parties contact info etc."
 *
 * Proves BOTH halves, as CONSTRUCTS (never literal counts — a correct refactor must not fail this):
 *
 * PURE
 *   · deriveContractDeadlines is CONTRACT-anchored, not clock-anchored (the defect every accept
 *     flow shared: `Date.now() + days`), TZ-safe, and refuses a non-date fallback.
 *   · fromContractDate returns undefined rather than inventing a deadline.
 *   · THE AUDIENCE BOUNDARY: a principal's packet never carries the counterparty principal's
 *     name / email / phone; an outbound (counterparty) packet carries NO principal at all;
 *     staff see the whole roster. Asserted against the DATA of the withheld row, so it holds
 *     however the copy is worded.
 *   · The terms block always states the closing date and the earnest-money due date — "not
 *     recorded" when absent, because a missing money deadline is information, not a blank.
 *
 * SOURCE (structural, scoped to the relevant block — not a global grep count)
 *   · the transactions INSERT carries close_date + the three contingency-deadline columns;
 *   · the bridge notifies AFTER the participant roster is populated (the roster IS the
 *     recipient list and the contact-info block);
 *   · every supabase write inside notifyTransactionParties destructures its error;
 *   · zero recipients ⇒ sent:false (never reported as success), and the idempotency marker is
 *     written only after real delivery.
 *
 * LIVE (creds-gated)
 *   · seeds a throwaway transaction + roster, runs the fan-out twice, asserts honest sent/
 *     already_notified semantics and that the outside principal is skipped-with-reason, then
 *     removes everything it created.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  composeClientMessage,
  composeCounterpartyMessage,
  composeStaffMessage,
  displayContingencies,
  isPrincipalRole,
  rosterForPrincipal,
  PARTIES_NOTIFIED_ACTIVITY_TYPE,
  type PartiesPacket,
  type PartyContact,
  type TransactionTerms,
} from "../lib/notifications/transaction-parties-packet"
import { deriveContractDeadlines } from "../lib/transactions/offer-bridge"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── Fixture: a deal with BOTH principals and a professional bench on the roster ──
const SELLER: PartyContact = { role: "seller", name: "Dana Seller", email: "dana.seller@example.com", phone: "555-0101" }
const BUYER:  PartyContact = { role: "buyer",  name: "Rio Buyer",   email: "rio.buyer@example.com",   phone: "555-0202" }
const ROSTER: PartyContact[] = [
  BUYER,
  { role: "buyer_agent",  name: "Alex Agent",  company: "Outside Realty", email: "alex@outside.example.com", phone: "555-0303", license_number: "SL123" },
  SELLER,
  { role: "seller_agent", name: "Sam Listing", company: "In House RE",    email: "sam@inhouse.example.com",  phone: "555-0404" },
  { role: "title_company", name: "Anchor Title", company: "Anchor Title", email: "closing@anchor.example.com" },
]
const TERMS: TransactionTerms = {
  dealName: "12 Elm St", propertyAddress: "12 Elm St, Austin, TX",
  purchasePrice: 450000, earnestMoney: 5000, earnestMoneyDue: "2026-03-06",
  contractDate: "2026-03-01", closingDate: "2026-04-15",
  inspectionDeadline: "2026-03-11", appraisalDeadline: "2026-03-21", financingDeadline: "2026-03-29",
  contingencies: ["Inspection", "Financing", "Home Sale"], titleCompany: "Anchor Title",
}
const PACKET: PartiesPacket = { terms: TERMS, parties: ROSTER }

/** Every distinguishing datum of a party — what a leak would look like. */
function identifiers(p: PartyContact): string[] {
  return [p.name, p.email, p.phone, p.license_number].filter(Boolean) as string[]
}

function pureLayer() {
  console.log("\n[deriveContractDeadlines · pure — anchored to the CONTRACT date, never the clock]")
  const d = deriveContractDeadlines({
    contractDate: "2026-03-01",
    inspectionPeriodDays: 10, appraisalContingencyDays: 20, financingContingencyDays: 28,
    offerClosingDate: "2026-04-15",
  })
  check("inspection = contract + 10d", d.inspectionDeadline === "2026-03-11")
  check("appraisal  = contract + 20d", d.appraisalDeadline === "2026-03-21")
  check("financing  = contract + 28d", d.financingDeadline === "2026-03-29")
  check("closing date carried from the offer", d.closingDate === "2026-04-15")

  const backdated = deriveContractDeadlines({ contractDate: "2020-01-01", inspectionPeriodDays: 10 })
  check("a BACKDATED contract keeps its own frame (2020-01-11), not today + 10d",
    backdated.inspectionDeadline === "2020-01-11")
  const todayPlus10 = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  check("…and is therefore NOT the clock-anchored value the accept flows used to compute",
    backdated.inspectionDeadline !== todayPlus10)

  const noDays = deriveContractDeadlines({
    contractDate: "2026-03-01",
    fallback: { inspectionDeadline: "2026-03-15", closingDate: "2026-05-01" },
  })
  check("no day column ⇒ caller's calendar-date fallback is used", noDays.inspectionDeadline === "2026-03-15")
  check("…and its closing date too", noDays.closingDate === "2026-05-01")
  const junk = deriveContractDeadlines({
    contractDate: "2026-03-01",
    fallback: { inspectionDeadline: "$5000", closingDate: "$5000" },
  })
  check("a NON-date fallback (a mis-passed dollar amount) is refused, not persisted",
    junk.inspectionDeadline === null && junk.closingDate === null)
  const noContract = deriveContractDeadlines({ contractDate: null, inspectionPeriodDays: 10 })
  check("no contract date + no fallback ⇒ null (honest absence, never a guess)",
    noContract.inspectionDeadline === null)

  console.log("\n[audience boundary · pure — a CONTACT is not staff, and one side is not the other]")
  const staffMsg = composeStaffMessage(PACKET)
  check("staff see every party on the file", ROSTER.every(p => staffMsg.includes(p.name)))
  check("the staff packet carries BOTH principals' contact details (they hold the file)",
    identifiers(BUYER).every(v => staffMsg.includes(v)) && identifiers(SELLER).every(v => staffMsg.includes(v)))

  const buyerRoster = rosterForPrincipal(ROSTER, "buyer")
  check("the buyer's roster keeps the buyer's own row", buyerRoster.some(p => p.role === "buyer"))
  check("the buyer's roster drops the SELLER row entirely", !buyerRoster.some(p => p.role === "seller"))
  const professionals = ROSTER.filter(p => !isPrincipalRole(p.role))
  check("the buyer's roster keeps every professional",
    professionals.every(pro => buyerRoster.some(p => p.role === pro.role)))
  const buyerMsg = composeClientMessage(PACKET, "buyer")
  check("NOTHING identifying the seller reaches the buyer (name, email, phone)",
    identifiers(SELLER).every(v => !buyerMsg.includes(v)))
  check("…and the buyer still gets the professionals' reach-me details",
    buyerMsg.includes("alex@outside.example.com") && buyerMsg.includes("sam@inhouse.example.com"))

  const sellerMsg = composeClientMessage(PACKET, "seller")
  check("symmetric: nothing identifying the buyer reaches the seller",
    identifiers(BUYER).every(v => !sellerMsg.includes(v)))

  const unknownViewer = rosterForPrincipal(ROSTER, null)
  check("an UNRESOLVED viewer gets NEITHER principal (unknown is never a reason to leak)",
    !unknownViewer.some(p => p.role === "buyer" || p.role === "seller"))

  const outbound = composeCounterpartyMessage(PACKET)
  check("the packet that LEAVES the building carries no principal from either side",
    [...identifiers(BUYER), ...identifiers(SELLER)].every(v => !outbound.includes(v)))
  check("…and still carries the terms, the dates and the contingencies",
    outbound.includes("450,000") && outbound.includes("2026-04-15") && outbound.includes("Home Sale"))

  console.log("\n[terms block · pure — honest about what is missing]")
  const bare = composeStaffMessage({
    terms: { ...TERMS, closingDate: null, earnestMoneyDue: null, earnestMoney: null, contingencies: [] },
    parties: ROSTER,
  })
  check("a missing closing date is STATED, not hidden", /Closing date: not recorded/.test(bare))
  check("a missing earnest deposit + due date is STATED", /Earnest deposit: not recorded — due not recorded/.test(bare))
  check("no contingencies says so explicitly", /Contingencies: none recorded/.test(bare))
  check("every recorded deadline appears in the delivered message",
    ["2026-03-11", "2026-03-21", "2026-03-29", "2026-04-15", "2026-03-06"].every(v => staffMsg.includes(v)))

  console.log("\n[contingencies · pure — fold spellings, drop nothing the contract said]")
  const disp = displayContingencies(["home_sale", "Home Sale", "inspection", "attorney-review", "", null])
  check("deduped case-insensitively", disp.filter(c => c.toLowerCase() === "home sale").length === 1)
  check("unknown values still pass through (nothing silently dropped)", disp.includes("Attorney Review"))
  check("non-array ⇒ [] (honest empty)", displayContingencies(null).length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — the SAVE half lands on the transaction row]")
  const bridge = src("lib/transactions/offer-bridge.ts")
  // Scope to the transactions INSERT payload so this asserts the WRITE, not a mention anywhere.
  const insertStart = bridge.indexOf('.from("transactions")')
  const insertBlock = insertStart >= 0 ? bridge.slice(insertStart, bridge.indexOf(".select()", insertStart)) : ""
  // Column keys are anchored on a word boundary: `estimated_close_date` must never be mistaken
  // for `close_date` (the first negative control caught exactly that false pass).
  const hasKey = (block: string, col: string, value?: string) =>
    new RegExp(`(^|[\\s{,])${col}:\\s*${value ?? ""}`, "m").test(block)
  for (const col of ["close_date", "inspection_deadline", "appraisal_deadline", "financing_deadline", "purchase_price", "earnest_money", "contract_date"]) {
    check(`transactions insert persists ${col}`, hasKey(insertBlock, col))
  }
  check("the deadline values come from the contract-anchored derivation, not the caller's clock math",
    hasKey(insertBlock, "close_date", "contractDeadlines\\.closingDate") &&
    hasKey(insertBlock, "inspection_deadline", "contractDeadlines\\.inspectionDeadline"))
  check("milestones are seeded from the SAME derivation (deal row and milestone card cannot disagree)",
    /const \{ closingDate, inspectionDeadline, appraisalDeadline, financingDeadline \} = contractDeadlines/.test(bridge))

  // The kernel converter is server-only (identity resolver), so its frame of reference is asserted
  // structurally rather than by import: what matters is that its fallback deadlines are anchored to
  // the CONTRACT date and that it no longer invents an earnest-money due date.
  console.log("\n[wiring — the kernel converter shares the contract frame]")
  const kernel = src("lib/kernel/transactions.ts")
  const termsStart = kernel.indexOf("contractTerms: {", kernel.indexOf("createTransactionFromOffer({"))
  const termsBlock = termsStart > 0 ? kernel.slice(termsStart, kernel.indexOf("})", termsStart)) : ""
  check("it reuses the bridge's ONE derivation instead of a second copy of the date math",
    /deriveContractDeadlines\(\{[\s\S]{0,400}contractDate/.test(kernel) &&
    /fallbackDeadlines\.(inspectionDeadline|closingDate)/.test(termsBlock))
  check("no clock-anchored deadline math survives in that block", !/Date\.now\(\)/.test(termsBlock))
  check("no earnest-money due date is invented from the deposit amount", !/earnestMoneyDue/.test(termsBlock))

  console.log("\n[wiring — the NOTIFY half runs on the one chokepoint, after the roster exists]")
  const notifyIdx   = bridge.indexOf("notifyTransactionParties")
  const rosterIdx   = bridge.indexOf("populateInitialParticipants(")
  check("the offer→deal bridge notifies the parties", notifyIdx > 0)
  check("…AFTER populating the participant roster (the roster is the recipient list)",
    rosterIdx > 0 && notifyIdx > rosterIdx)
  check("a fan-out that reached nobody is logged as NOT sent by the caller too",
    /!partiesNotified\.sent[\s\S]{0,200}console\.error/.test(bridge))

  console.log("\n[honesty — every write destructures its error; zero recipients is not success]")
  const helpers = src("lib/notifications/notify-helpers.ts")
  const fnStart = helpers.indexOf("export async function notifyTransactionParties")
  const fn = fnStart > 0 ? helpers.slice(fnStart) : ""
  check("notifyTransactionParties exists in the shared helper (extended, not forked)", fn.length > 0)
  const writes = [...fn.matchAll(/await supabase\s*\.?\s*\n?\s*\.from\([^)]*\)\s*\.?\s*\n?\s*\.(insert|update|upsert|delete)\(/g)]
  check("the fan-out performs at least one write", writes.length > 0)
  const undestructured = writes.filter(m => {
    const before = fn.slice(Math.max(0, m.index! - 80), m.index!)
    return !/const\s*\{[^}]*error[^}]*\}\s*=\s*$/.test(before)
  })
  check(`every supabase write destructures its error (${writes.length} writes, ${undestructured.length} bare)`,
    undestructured.length === 0)
  check("sent is computed from ACTUAL recipients, never assumed",
    /result\.sent\s*=[\s\S]{0,200}staff_user_ids\.length > 0[\s\S]{0,120}contact_ids\.length > 0[\s\S]{0,120}emailed\.length > 0/.test(fn))
  const zeroGuardIdx = fn.indexOf("if (!result.sent)")
  // The MARKER write specifically (its payload carries the marker type) — not the
  // per-recipient outbound audit row, which is written earlier by design.
  const markerWriteIdx = fn.search(/activity_type:\s*PARTIES_NOTIFIED_ACTIVITY_TYPE/)
  check("zero recipients returns before the marker is written (a retry can still notify)",
    zeroGuardIdx > 0 && markerWriteIdx > zeroGuardIdx)
  check("the idempotency gate FAILS CLOSED on a refused read",
    /markerError[\s\S]{0,160}refusing to fan out/.test(fn))
  check("id classes are resolved, never crossed (agents.id → users.id before any notifications write)",
    /resolveAgentRecordToUserId\(/.test(fn))
  check("the TC bench is resolved through the shared role vocabulary, not a hand-typed string",
    /rawRoleVariantsFor\(/.test(fn))
  check("outside PRINCIPALS are recorded as skipped-with-reason, never silently dropped",
    /skipped_outside_principals\.push/.test(fn))
  check("the OUTBOUND leg is idempotent per recipient (a prior send is looked up before sending)",
    /PARTIES_EMAILED_ACTIVITY_TYPE[\s\S]{0,400}if \(alreadyEmailed\) continue/.test(fn))
  check("…and that lookup FAILS CLOSED (a refused read skips the send rather than risk a duplicate)",
    /emailDupeError[\s\S]{0,160}send skipped[\s\S]{0,60}continue/.test(fn))
  check("outbound email rides THE gate (lib/providers/dispatch), not a raw provider sender",
    /import\("@\/lib\/providers\/dispatch"\)/.test(fn) && !/@\/lib\/providers\/messaging/.test(fn))

  console.log("\n[ownership]")
  const reg = src("lib/kernel/manager-registry.ts")
  check("the domain is owned by a manager with a runnable proof",
    /transaction_parties_notification:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:parties-notify"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed txn + roster → notify → assert honesty + idempotency → clean up")
  const { data: brk, error: brkErr } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (brkErr) { check(`brokerage lookup succeeded (${brkErr.message})`, false); return }
  if (!brk) { console.log("  ⊘ no brokerage rows — skipping live layer"); return }
  const brokerageId = (brk as any).id as string
  let txnId: string | null = null
  try {
    const { data: txn, error: txnErr } = await svc.from("transactions").insert({
      brokerage_id: brokerageId,
      deal_name: "ZZ parties-notify probe",
      property_address: "1 Probe Way",
      purchase_price: 100000,
      contract_date: "2099-03-01",
      close_date: "2099-04-15",
      inspection_deadline: "2099-03-11",
      status: "under_contract",
      stage: "UNDER_CONTRACT",
    }).select("id").single()
    if (txnErr || !txn) { check(`probe transaction created (${txnErr?.message ?? "no row"})`, false); return }
    txnId = (txn as any).id as string

    const { error: partErr } = await svc.from("transaction_participants").insert([
      { transaction_id: txnId, brokerage_id: brokerageId, role: "buyer",        name: "Probe Buyer",  email: "probe.buyer@example.invalid" },
      { transaction_id: txnId, brokerage_id: brokerageId, role: "seller_agent", name: "Probe Agent",  email: "probe.agent@example.invalid" },
    ])
    check(`roster seeded (${partErr?.message ?? "ok"})`, !partErr)

    const { notifyTransactionParties } = await import("../lib/notifications/notify-helpers")
    const first = await notifyTransactionParties(svc as never, { transactionId: txnId, brokerageId })
    check("the outside principal on the roster is skipped WITH A REASON (never emailed around their agent)",
      first.skipped_outside_principals.some(s => s.role === "buyer" && s.reason.length > 0))
    check("the result is honest: sent ⇔ at least one recipient was actually reached",
      first.sent === (first.staff_user_ids.length + first.contact_ids.length + first.emailed.length > 0))
    check("a fan-out that reached nobody carries a reason (never a silent success)",
      first.sent || first.errors.length > 0)

    const second = await notifyTransactionParties(svc as never, { transactionId: txnId, brokerageId })
    if (first.sent) {
      check("second run is a no-op — already_notified (a retry cannot notify twice)",
        second.already_notified && !second.sent)
    } else {
      check("nothing was delivered, so no marker was written and a retry is still allowed",
        !second.already_notified)
    }

    const { data: markers } = await svc.from("activities").select("id")
      .eq("transaction_id", txnId).eq("activity_type", PARTIES_NOTIFIED_ACTIVITY_TYPE)
    check("at most ONE notification marker exists for the transaction", (markers ?? []).length <= 1)
  } finally {
    if (txnId) {
      await svc.from("activities").delete().eq("transaction_id", txnId)
      await svc.from("notifications").delete().eq("entity_id", txnId)
      await svc.from("transparency_updates").delete().eq("transaction_id", txnId)
      await svc.from("transaction_participants").delete().eq("transaction_id", txnId)
      await svc.from("transactions").delete().eq("id", txnId)
      const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txnId)
      check("live residue cleaned up (0 probe rows left)", (count ?? 0) === 0)
    }
  }
}

async function main() {
  console.log("═".repeat(78))
  console.log("TRANSACTION PARTIES NOTIFY — terms saved on the deal, every party told, honestly")
  console.log("═".repeat(78))
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n" + "─".repeat(78))
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach(f => console.log(`  · ${f}`)); process.exit(1) }
  console.log("✅ transaction-parties notification proof green")
}

main().catch(err => { console.error(err); process.exit(1) })
