/**
 * scripts/canaries/_verified-closing.ts — the wave-144 journeys' SHARED TAIL: the VERIFIED CLOSING, driven (lane 144J).
 *
 * Folds in lane 144B's `## Canary requirements` (SELLER 10–13 / BUYER 12–15, $S/lane144B-notes.md): the gated stage machine
 * (lib/transactions/stage-progression.ts canAdvanceStage → advanceStage) is the AUTHORITATIVE WRITE of a verified closing —
 * CDA only when the brokerage requires it, milestones found through the one identity resolver, closing compliance asked AT
 * the close, contingency TYPES never freezing a deal, stage order kept; the close stamps the verified date, emits
 * TRANSACTION_CLOSED + DEAL_CLOSED and converts BOTH parties through the ONE lifetime writer (payout hold honoured); the
 * review ask is timed from the verified date. The kernel close-button door (lib/kernel/transactions.ts
 * closeTransactionCommand) and the coming-soon announcement door (app/actions/seller-listing/execution-engine.ts
 * activateComingSoon) must reach their gates too.
 *
 * NOT A SECOND HARNESS: the recorder stubs are the SAME list lane 144B's scripts/journey-promotion-gates-guard.ts installs
 * (copied, per its notes), through the harness's stubModule — installed at module load, so this module must be imported
 * BEFORE anything reaches lib/transactions/stage-progression.ts (seller-journey runs first in WAVE144_CANARY_KEYS for that
 * reason, and every step that depends on a stub asserts the stub was hit).
 */
import { CANARY_TAG, canaryClient, cleanupCanary, setSvc, stubModule, uuid, type CanaryCleanup } from "./_harness"
import { fnBody, strippedRepo } from "./_registry"

type Ctl = { closingGate: { allowed: boolean; blockers: string[] }; gateCalls: Array<{ t: string }>; calc: Array<Record<string, unknown>>; audience: string[]; newsletter: string[] }
const G = globalThis as unknown as { __W144J: Ctl }
G.__W144J = { closingGate: { allowed: true, blockers: [] }, gateCalls: [], calc: [], audience: [], newsletter: [] }
stubModule("@/app/actions/transaction-compliance", "export async function canProceedToClosingPrep(t, b) { const g = globalThis.__W144J; g.gateCalls.push({ t, b }); return g.closingGate } export async function seedTransactionComplianceChecks() { return { success: true } }")
stubModule("@/lib/commission/engine", "export async function calculateCommission(p) { globalThis.__W144J.calc.push(p); return { success: true } }")
stubModule("@/lib/commission/reconcile-tracking", "export async function finalizeCommissionAtClose() { return { ok: true } }")
stubModule("@/lib/offers/closing-cost-accuracy", "export async function recordClosingCostAccuracy() { return { recorded: false } }")
stubModule("@/lib/net-sheet/net-sheet-guard-runner", "export async function runNetSheetSurpriseGuard() { return { ran: false } }")
stubModule("@/lib/analytics/ai-prediction-outcomes", "export async function gradeTransactionPredictionOutcomes() { return 0 } export async function markLeadConversionOutcomes() { return 0 }")
stubModule("@/lib/audiences/audience-sync", "export async function onContactBecameLifetimeForAudience(p) { globalThis.__W144J.audience.push(p.contactId); return { ok: true } }")
stubModule("@/lib/content/newsletter-enrollment", "export async function enrollContactInNewsletter(p) { globalThis.__W144J.newsletter.push(p.contactId); return { ok: true } }")
stubModule("@/lib/managers/accuracy-gate", "export function __clearAccuracyGateCache() {}")

type Rule = (owner: "144B" | "144I" | "defect", step: string, ok: boolean, evidence?: string) => boolean

// fnBody moved to scripts/canaries/_registry.ts (pure, so the graph canary can read a body without loading these stubs);
// re-exported here for buyer-journey's existing import.
export { fnBody }

/** Drive the verified-closing tail; returns the cleanup of every tenant it seeded. */
export async function driveVerifiedClosing(rule: Rule): Promise<{ cleanup: CanaryCleanup[]; residual: number; mismatches: string[] }> {
  const now = new Date().toISOString(), today = now.slice(0, 10)
  const B_NOCDA = uuid(), B_CDA = uuid(), B_HOLD = uuid(), U = uuid(), AG = uuid(), U2 = uuid(), AG2 = uuid()
  const T_NOCDA = uuid(), T_CDA = uuid(), T_CDA_DONE = uuid(), T_CONT = uuid(), T_UC = uuid(), O_CONT = uuid()
  const contractDate = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10)
  const tx = (id: string, b: string, stage: string | null, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: b, agent_id: AG, stage, status: "clear_to_close", contract_date: contractDate, compliance_passed_at: now, contact_id: null, offer_id: null, notes: CANARY_TAG, ...extra })
  const svc = canaryClient({
    brokerages: [
      { id: B_NOCDA, name: `${CANARY_TAG} close no-CDA`, offers_cda: false, non_cda_payout_default: "direct_deposit" },
      { id: B_CDA, name: `${CANARY_TAG} close CDA`, offers_cda: true },
      { id: B_HOLD, name: `${CANARY_TAG} close hold`, offers_cda: false },
    ],
    transactions: [tx(T_NOCDA, B_NOCDA, "CLOSING_PREP"), tx(T_CDA, B_CDA, "CLOSING_PREP"), tx(T_CDA_DONE, B_CDA, "CLOSING_PREP"), tx(T_CONT, B_NOCDA, "UNDER_CONTRACT", { offer_id: O_CONT }), tx(T_UC, B_NOCDA, "UNDER_CONTRACT")],
    offers: [{ id: O_CONT, brokerage_id: B_NOCDA, contingencies: ["financing", "inspection", "appraisal"], notes: CANARY_TAG }],
    transaction_milestones: [{ id: uuid(), brokerage_id: B_CDA, transaction_id: T_CDA_DONE, milestone_type: "cda_delivered", milestone_name: "Commission Disbursement", status: "completed", completed_at: now, target_date: today }],
  })
  setSvc(svc)
  const { canAdvanceStage, advanceStage } = await import("../../lib/transactions/stage-progression")

  // ── SELLER 10 · the closing gate (canAdvanceStage → CLOSED) ──
  const noCda = await canAdvanceStage(T_NOCDA, "CLOSING_PREP", "CLOSED", B_NOCDA)
  const withCda = await canAdvanceStage(T_CDA, "CLOSING_PREP", "CLOSED", B_CDA)
  const done = await canAdvanceStage(T_CDA_DONE, "CLOSING_PREP", "CLOSED", B_CDA)
  rule("144B", "CDA ONLY IF THE BROKERAGE REQUIRES IT, AT THE CLOSING WRITE (lane 144B req SELLER 10a/b/e): a NO-CDA brokerage's deal closes with no cda_delivered milestone; a CDA brokerage's is REFUSED until its delivered CDA is on file, and a completed cda_delivered milestone (typed by milestone_type) is FOUND — at HEAD the gate looks milestones up by a `name` column transaction_milestones does not have and requires the CDA of every brokerage", noCda.allowed && !withCda.allowed && withCda.blockers.some((b) => /cda/i.test(b)) && done.allowed, `HEAD: no-CDA ${noCda.allowed ? "allowed" : noCda.blockers.join("; ")} | CDA ${withCda.allowed ? "allowed" : withCda.blockers.join("; ")} | CDA done ${done.allowed ? "allowed" : done.blockers.join("; ")}`.slice(0, 400))
  G.__W144J.gateCalls.length = 0
  G.__W144J.closingGate = { allowed: false, blockers: ["Compliance failed: closing_terms.purchase_price - the settlement statement disagrees with the executed terms"] }
  const cc = await canAdvanceStage(T_NOCDA, "CLOSING_PREP", "CLOSED", B_NOCDA)
  G.__W144J.closingGate = { allowed: true, blockers: [] }
  rule("144B", "CLOSING COMPLIANCE IS ASKED AT THE CLOSE (lane 144B req SELLER 10c): a blocking closing-compliance finding written during closing prep refuses CLOSED by name, and it is the SAME gate (canProceedToClosingPrep, stubbed recorder — asserted HIT) that was asked for this transaction", !cc.allowed && cc.blockers.some((b) => /closing_terms\.purchase_price/.test(b)) && G.__W144J.gateCalls.some((x) => x.t === T_NOCDA), `HEAD: ${cc.allowed ? "allowed" : cc.blockers.join("; ").slice(0, 160)}; closing-compliance gate calls ${G.__W144J.gateCalls.length}`)
  const cont = await canAdvanceStage(T_CONT, "UNDER_CONTRACT", "INSPECTION", B_NOCDA)
  const skip = await canAdvanceStage(T_UC, "UNDER_CONTRACT", "CLOSED", B_NOCDA)
  rule("144B", "STAGE ORDER HOLDS AND CONTINGENCY TYPES NEVER FREEZE A DEAL (lane 144B req SELLER 10d/f): UNDER_CONTRACT → CLOSED is refused (a verified closing comes from CLOSING_PREP), while an offer carrying the contingency TYPES [financing, inspection, appraisal] (createOffer's shape) advances to INSPECTION", !skip.allowed && cont.allowed, `skip ${skip.allowed ? "ALLOWED" : "refused"}; contingency deal ${cont.allowed ? "advances" : cont.blockers.join("; ").slice(0, 160)}`)

  // ── SELLER 11a · the verified closing write ──
  const BUYER = uuid(), SELLER = uuid(), L = uuid(), T_CLOSE = uuid(), BUYER_H = uuid(), SELLER_H = uuid(), T_HOLD = uuid()
  const scheduled = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
  const contact = (id: string, b: string, agent: string, type: string, first: string) => ({ id, brokerage_id: b, agent_id: agent, contact_type: type, lifecycle_state: type, first_name: first, last_name: "Journey", email: `${first.toLowerCase()}@wave140-canary.test`, notes: CANARY_TAG })
  ;(svc.tables.users ??= []).push({ id: U, email: "closer@wave140-canary.test", user_type: "agent", brokerage_id: B_NOCDA }, { id: U2, email: "closer2@wave140-canary.test", user_type: "agent", brokerage_id: B_HOLD })
  ;(svc.tables.agents ??= []).push({ id: AG, user_id: U, brokerage_id: B_NOCDA, is_active: true }, { id: AG2, user_id: U2, brokerage_id: B_HOLD, is_active: true })
  ;(svc.tables.contacts ??= []).push(contact(BUYER, B_NOCDA, AG, "buyer", "Blair"), contact(SELLER, B_NOCDA, AG, "seller", "Sloane"), contact(BUYER_H, B_HOLD, AG2, "buyer", "Hana"), contact(SELLER_H, B_HOLD, AG2, "seller", "Hal"))
  ;(svc.tables.listings ??= []).push({ id: L, brokerage_id: B_NOCDA, agent_id: AG, status: "pending", lifecycle_stage: "UNDER_CONTRACT", address: "1 Journey Way", notes: CANARY_TAG })
  ;(svc.tables.transactions ??= []).push(
    tx(T_CLOSE, B_NOCDA, "CLOSING_PREP", { buyer_contact_id: BUYER, seller_contact_id: SELLER, contact_id: BUYER, listing_id: L, deal_type: "dual", close_date: scheduled }),
    { ...tx(T_HOLD, B_HOLD, "CLOSING_PREP", { buyer_contact_id: BUYER_H, seller_contact_id: SELLER_H, contact_id: BUYER_H, deal_type: "dual", close_date: scheduled }), agent_id: AG2 },
  )
  ;(svc.tables.brokerage_settings ??= []).push({ id: uuid(), brokerage_id: B_HOLD, settings: { lifetime_conversion: { require_payout_verified: true } } })
  const closed = await advanceStage({ transactionId: T_CLOSE, targetStage: "CLOSED", brokerageId: B_NOCDA, userId: U, reason: "wave-144 canary close" })
  const row = (svc.tables.transactions ?? []).find((t) => t.id === T_CLOSE) as Record<string, unknown> | undefined
  const events = (svc.tables.lifecycle_events ?? []).filter((e) => e.entity_id === T_CLOSE).map((e) => String(e.event_type))
  rule("144B", "THE VERIFIED CLOSING WRITE (lane 144B req SELLER 11a): the gated stage machine closes the deal (status closed, stage CLOSED), stamps close_date = the day it closed (the contract's scheduled date 40 days ago is REPLACED — the review ask and the lifetime anniversary key on it), emits TRANSACTION_CLOSED + DEAL_CLOSED and marks the listing sold", closed.success && row?.status === "closed" && row?.close_date === today && events.includes("transaction_closed") && events.includes("deal_closed") && (svc.tables.listings ?? []).find((l) => l.id === L)?.status === "sold", `HEAD: ${closed.success ? `closed, close_date ${String(row?.close_date)}, events [${events.join(",")}]` : closed.error}`.slice(0, 300))
  const people = (svc.tables.contacts ?? []) as Array<Record<string, unknown>>
  const b = people.find((x) => x.id === BUYER), s = people.find((x) => x.id === SELLER)
  const held = await advanceStage({ transactionId: T_HOLD, targetStage: "CLOSED", brokerageId: B_HOLD, userId: U2 })
  const hb = people.find((x) => x.id === BUYER_H), hs = people.find((x) => x.id === SELLER_H)
  rule("144B", "BOTH PARTIES → LIFETIME THROUGH THE ONE WRITER (lane 144B req SELLER 13 / BUYER 12–15): after the gated close the BUYER and the SELLER read lifetime_customer on contact_type AND lifecycle_state; a tenant whose policy holds conversion until the payout closes the deal and converts NOBODY", closed.success && b?.contact_type === "lifetime_customer" && s?.contact_type === "lifetime_customer" && b?.lifecycle_state === "lifetime_customer" && held.success && hb?.contact_type === "buyer" && hs?.contact_type === "seller", `HEAD: buyer ${String(b?.contact_type)} seller ${String(s?.contact_type)}; hold tenant ${held.success ? `buyer ${String(hb?.contact_type)} seller ${String(hs?.contact_type)}` : held.error}`.slice(0, 300))

  // ── SELLER 11b · the kernel close-button door reaches the same gate (lane 144I's file) ──
  const closeBody = fnBody(strippedRepo("lib/kernel/transactions.ts") ?? "", "closeTransactionCommand")
  rule("144I", "THE CLOSE-BUTTON DOOR IS GATED (lane 144B req SELLER 11b; Outside-lane 1 → lane 144I): lib/kernel/transactions.ts closeTransactionCommand — shown from ANY stage — runs canAdvanceStage(…, \"CLOSED\") before it writes status closed, so no review ask, lifetime conversion or commission work follows an unverified close", closeBody.length > 0 && /canAdvanceStage\s*\(/.test(closeBody), closeBody ? "HEAD: closeTransactionCommand writes status closed with no canAdvanceStage( call" : "closeTransactionCommand not found")
  // ── SELLER 7b · the coming-soon announcement door (integrator — app/actions/seller-listing/** is in no lane's domain) ──
  const csBody = fnBody(strippedRepo("app/actions/seller-listing/execution-engine.ts") ?? "", "activateComingSoon")
  rule("defect", "THE COMING-SOON ANNOUNCEMENT IS GATED (lane 144B req SELLER 7b; Outside-lane 2 → integrator): app/actions/seller-listing/execution-engine.ts activateComingSoon runs requireListingStage(supabase, listingId, \"COMING_SOON_ACTIVE\") before transitionLifecycle — a listing still at LISTING_AGREEMENT_SIGNED (agreement not through compliance) can never be publicly announced as coming soon", csBody.length > 0 && /requireListingStage\s*\(\s*supabase\s*,\s*listingId\s*,\s*["']COMING_SOON_ACTIVE["']\s*\)/.test(csBody), csBody ? "HEAD: no requireListingStage(…, \"COMING_SOON_ACTIVE\") in activateComingSoon (its siblings gate their stages)" : "activateComingSoon not found")
  // ── SELLER 3 · the lead → contact EVENT on every conversion door ──
  const promote = fnBody(strippedRepo("lib/contact-promotion/promote-lead-to-contact.ts") ?? "", "promoteLeadToContactService")
  rule("144B", "LEAD → CONTACT IS AN EVENT ON EVERY DOOR (lane 144B req SELLER 3): the AI-ISA booking door's converter (promoteLeadToContactService) records LEAD_CONVERTED_TO_CONTACT like the CRM and automatic doors, so the lead.converted webhook and the person-identity link see every conversion", /LEAD_CONVERTED_TO_CONTACT/.test(promote), promote ? "HEAD: promoteLeadToContactService records no LEAD_CONVERTED_TO_CONTACT" : "promoteLeadToContactService not found")

  const out = { cleanup: [] as CanaryCleanup[], residual: 0, mismatches: [] as string[] }
  for (const bid of [B_NOCDA, B_CDA, B_HOLD]) { const cl = await cleanupCanary(svc, bid); out.cleanup.push(...cl.cleanup); out.residual += cl.residual; out.mismatches.push(...cl.mismatches) }
  return out
}
