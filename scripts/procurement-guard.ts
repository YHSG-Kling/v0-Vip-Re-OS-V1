#!/usr/bin/env tsx
/**
 * scripts/procurement-guard.ts  (npm run test:procurement) — wave 107, lane 107B.
 *
 * Proves MARKETPLACE PROCUREMENT INTELLIGENCE (lib/kernel/procurement.ts) on the survivors:
 *   S   survivors reused: the request IS a vendor_bookings row, booked by updateVendorBookingStatus,
 *       approved through the agent_client_messages queue, rated through recalculateVendorRatingsCore;
 *   R   ranking: every factor named with a score + reason, deterministic, eligibility excludes with a
 *       reason (category, territory, subscription, quality floor), a positive control flips the winner;
 *   A   approval required by default (no booking until the agent approves; reject declines);
 *   P   autonomy: OFF by default; ON books under the cap within allowed categories with the policy
 *       ref; over the cap / other category / unknown price → approval (each refusal named);
 *   V   vendor isolation: a vendor sees only requests it is asked about and only its OWN quote; a
 *       non-candidate cannot quote;
 *   T   tenant isolation: a foreign listing / vendor / request is never read or written;
 *   L   the loop: completion → review → vendor_ratings → the next request's quality factor moves;
 *   W   wiring + registration from STRIPPED source, each with a positive control; the m723 CHECK
 *       lists exactly the vendor_bookings status vocabulary the code transitions use.
 * In-memory client only; no database, no network, no model call.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  PROCUREMENT_FACTORS, PROCUREMENT_FACTOR_WEIGHTS, PROCUREMENT_REQUEST_FIELDS, PROCUREMENT_AUTONOMY_POLICY_KEY,
  rankVendorsForRequest, resolveProcurementAutonomy, procurementAutonomyDecision, gatherProcurementFacts,
  requestProcurement, approveProcurementRequest, declineProcurementRequest, submitProcurementQuote,
  vendorProcurementView,
} from "../lib/kernel/procurement"
import { updateVendorBookingStatus } from "../lib/kernel/vendors"
import { recalculateVendorRatingsCore } from "../lib/vendor-marketplace/vendor-ratings"
import { approveClientMessage, rejectClientMessage } from "../lib/agents/agent-client-messages"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const LISTING = uuid(1), LISTING_OTHER = uuid(2)
const V_FAST = uuid(11), V_CHEAP = uuid(12), V_FAR = uuid(13), V_LAPSED = uuid(14), V_BAD = uuid(15), V_STAGER = uuid(16), V_FOREIGN = uuid(19)
const AGENT_USER = uuid(21), AGENT_ROW = uuid(31)
const NOW = new Date("2026-10-06T12:00:00.000Z")
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10)
const allow = async () => ({ allowed: true, reason: "test_allow" })

function seed(settings: Record<string, unknown> = {}) {
  const hist = (vendorId: string, n: number, cost: number, late = false) => Array.from({ length: n }, (_, i) => ({
    id: `h-${vendorId}-${i}`, brokerage_id: B, vendor_id: vendorId, service_type: "photography", status: "completed",
    scheduled_date: ago(30 + i), completed_at: late ? ago(20 + i) : ago(30 + i), cost, created_at: ago(30 + i), agent_rating: null,
  }))
  return memSupabase({
    brokerage_settings: [{ brokerage_id: B, settings }],
    listings: [{ id: LISTING, brokerage_id: B, state: "TX", zip: "77001", agent_id: AGENT_ROW }, { id: LISTING_OTHER, brokerage_id: OTHER, state: "TX", zip: "77001" }],
    agents: [{ id: AGENT_ROW, user_id: AGENT_USER }],
    vendors: [
      { id: V_FAST, brokerage_id: B, name: "Fast Photo", category: "photographer", status: "active", platform_vendor_id: null, estimated_turnaround_days: 1 },
      { id: V_CHEAP, brokerage_id: B, name: "Cheap Photo", category: "photographer", status: "active", platform_vendor_id: "pv-cheap", estimated_turnaround_days: 9 },
      { id: V_FAR, brokerage_id: B, name: "Far Photo", category: "photographer", status: "active", platform_vendor_id: "pv-far", estimated_turnaround_days: 1 },
      { id: V_LAPSED, brokerage_id: B, name: "Lapsed Photo", category: "photographer", status: "active", platform_vendor_id: "pv-lapsed", estimated_turnaround_days: 1 },
      { id: V_BAD, brokerage_id: B, name: "Bad Photo", category: "photographer", status: "active", platform_vendor_id: null, estimated_turnaround_days: 1 },
      { id: V_STAGER, brokerage_id: B, name: "A Stager", category: "stager", status: "active", platform_vendor_id: null, estimated_turnaround_days: 1 },
      { id: V_FOREIGN, brokerage_id: OTHER, name: "Foreign Photo", category: "photographer", status: "active", platform_vendor_id: null, estimated_turnaround_days: 0 },
    ],
    vendor_subscriptions: [
      { brokerage_id: B, vendor_id: V_CHEAP, status: "active" }, { brokerage_id: B, vendor_id: V_FAR, status: "active" },
      { brokerage_id: B, vendor_id: V_LAPSED, status: "canceled" },
    ],
    vendor_service_areas: [
      { platform_vendor_id: "pv-cheap", state: "TX", zip_code: null, trade_category: "photographer", status: "active", license: null, notes: null },
      { platform_vendor_id: "pv-far", state: "LA", zip_code: null, trade_category: "photographer", status: "active", license: null, notes: null },
      { platform_vendor_id: "pv-lapsed", state: "TX", zip_code: null, trade_category: "photographer", status: "active", license: null, notes: null },
    ],
    vendor_ratings: [
      { vendor_id: V_FAST, brokerage_id: B, avg_agent_rating: 4, avg_client_rating: null, total_bookings: 3, one_star_count: 0 },
      { vendor_id: V_CHEAP, brokerage_id: B, avg_agent_rating: 4, avg_client_rating: null, total_bookings: 3, one_star_count: 0 },
      { vendor_id: V_BAD, brokerage_id: B, avg_agent_rating: 2, avg_client_rating: 2, total_bookings: 6, one_star_count: 3 },
    ],
    vendor_bookings: [...hist(V_FAST, 3, 300), ...hist(V_CHEAP, 3, 150, true)],
    vendor_booking_quotes: [], vendor_invoices: [], agent_client_messages: [], agent_action_ledger: [], lifecycle_events: [], notifications: [],
  }, { stampCreatedAt: true })
}

async function main() {
  console.log("procurement-guard — marketplace procurement on the survivors (wave 107B)\n")

  // ── R: ranking ─────────────────────────────────────────────────────────────
  const mem0 = seed()
  const facts = await gatherProcurementFacts(mem0 as any, { brokerageId: B, serviceType: "photography", jobState: "TX", jobZip: "77001", neededBy: day(3), budget: 400, now: NOW })
  const rk = rankVendorsForRequest(facts)
  check("R1 every ranked vendor carries all six factors with a score in [0,1] and a reason", rk.ranked.length > 0 && rk.ranked.every((r) => PROCUREMENT_FACTORS.every((k) => r.factors[k] && r.factors[k].score >= 0 && r.factors[k].score <= 1 && r.factors[k].reason.length > 0)), JSON.stringify(rk.ranked.map((r) => r.name)))
  check("R2 weights sum to 1 over the owner's factors (availability, price, quality, SLA, history + preference)", Math.abs(Object.values(PROCUREMENT_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9 && ["availability", "price", "quality", "sla", "history"].every((k) => (PROCUREMENT_FACTORS as readonly string[]).includes(k)))
  const exReason = (id: string) => rk.excluded.find((e) => e.vendorId === id)?.reason ?? ""
  check("R3 eligibility excludes with a NAMED reason: territory (LA-only vendor on a TX job)", /territory/.test(exReason(V_FAR)), exReason(V_FAR))
  check("R4 eligibility: a marketplace vendor without an ACTIVE subscription is excluded", /subscription canceled/.test(exReason(V_LAPSED)), exReason(V_LAPSED))
  check("R5 eligibility: the rating-governance floor excludes a suppressed vendor", /quality floor/.test(exReason(V_BAD)), exReason(V_BAD))
  check("R6 eligibility: category — the stager and the foreign tenant's photographer are never candidates", !facts.candidates.some((c) => c.vendorId === V_STAGER || c.vendorId === V_FOREIGN))
  check("R7 Fast Photo (on time, meets needed-by) outranks Cheap Photo (late history, 9-day turnaround)", rk.ranked[0]?.vendorId === V_FAST, JSON.stringify(rk.ranked.map((r) => [r.name, r.total])))
  check("R8 deterministic: the same facts rank identically", JSON.stringify(rankVendorsForRequest(facts)) === JSON.stringify(rk))
  const flipped = rankVendorsForRequest({ ...facts, preferredVendorIds: [V_CHEAP], candidates: facts.candidates.map((c) => c.vendorId === V_CHEAP ? { ...c, quote: { amount: 100, availableOn: day(2), status: "submitted", notes: null } } : c) })
  check("R9 POSITIVE CONTROL: Cheap quoting $100 available in time + named preferred flips the winner to Cheap", flipped.ranked[0]?.vendorId === V_CHEAP, JSON.stringify(flipped.ranked.map((r) => [r.name, r.total])))
  const noEvidence = rankVendorsForRequest({ ...facts, neededBy: null, candidates: facts.candidates.map((c) => ({ ...c, rating: null, sla: null, history: { completed: 0, noShows: 0, costs: [] } })) })
  check("R10 no evidence scores NEUTRAL and says so — never a silent promotion", noEvidence.ranked.every((r) => r.factors.quality.score === 0.5 && /no ratings/.test(r.factors.quality.reason) && r.factors.availability.score === 0.5))

  // ── A: approval required by default; S: survivors ──────────────────────────
  const mem = seed()
  const req = await requestProcurement(mem as any, { brokerageId: B, serviceType: "photography", listingId: LISTING, neededBy: day(3), budget: 400, requestedByUserId: AGENT_USER, now: NOW }, { access: allow })
  const reqRow = mem.tables.vendor_bookings.find((b) => b.id === (req.ok ? req.bookingId : ""))
  check("S1 the request IS a vendor_bookings row (status requested, owner fields on it) — no parallel request table", !!reqRow && reqRow.status === "requested" && reqRow.needed_by === day(3) && reqRow.budget === 400 && reqRow.vendor_id === V_FAST && !!reqRow.recommendation && !Object.keys(mem.tables).some((t) => /procurement_request/.test(t)), JSON.stringify(reqRow))
  check("A1 default policy: approval PENDING, nothing booked", req.ok && req.approval === "pending" && reqRow?.approval_status === "pending" && /off/.test(req.ok ? req.autonomy : ""), JSON.stringify(req))
  const prop = mem.tables.agent_client_messages.find((m) => m.entity_type === "vendor_booking" && m.entity_id === reqRow?.id)
  check("S2 the approval rides the EXISTING queue (agent_client_messages proposed, audience agent, linked on the request)", !!prop && prop.status === "proposed" && prop.audience === "agent" && reqRow?.approval_message_id === prop.id)
  check("A2 the responsible agent was alerted for approval (the queue's own notification)", mem.tables.notifications.some((n) => n.user_id === AGENT_USER && n.type === "approval_needed"))
  check("S3 one ledger row (procurement.recommend) + one auditOnly event", mem.tables.agent_action_ledger.filter((l) => l.action === "vendor.procurement.recommend").length === 1 && mem.tables.lifecycle_events.filter((e) => e.event_type === "procurement.recommended").length === 1, JSON.stringify(mem.tables.agent_action_ledger.map((l) => l.action)))
  const denied = await requestProcurement(seed() as any, { brokerageId: B, serviceType: "photography", listingId: LISTING }, { access: async () => ({ allowed: false, reason: "past_due" }) })
  check("A3 entitlement fails closed (mayUseAndAfford seam refuses → nothing written)", !denied.ok && /entitlement refused/.test(denied.error))

  // ── V: vendor isolation (quotes while requested) ───────────────────────────
  const bid = req.ok ? req.bookingId : ""
  const q1 = await submitProcurementQuote(mem as any, { vendorId: V_CHEAP, brokerageId: B, userId: uuid(41) }, { bookingId: bid, amount: 180, availableOn: day(2) })
  const q2 = await submitProcurementQuote(mem as any, { vendorId: V_FAST, brokerageId: B, userId: uuid(42) }, { bookingId: bid, amount: 320, availableOn: day(1) })
  check("V1 ranked candidates may quote on the request", q1.ok && q2.ok, JSON.stringify([q1, q2]))
  const qBad = await submitProcurementQuote(mem as any, { vendorId: V_STAGER, brokerageId: B, userId: uuid(43) }, { bookingId: bid, amount: 1 })
  check("V2 a vendor NOT asked about the request cannot quote (not found in your scope)", !qBad.ok && /not found in your scope/.test(qBad.error ?? ""))
  const viewCheap = await vendorProcurementView(mem as any, { vendorId: V_CHEAP, brokerageId: B })
  const leaked = JSON.stringify(viewCheap)
  check("V3 a vendor sees ONLY its own quote — never the competitor's amount, the budget or the scores", viewCheap.ok && viewCheap.requests.length === 1 && viewCheap.requests[0].myQuote?.amount === 180 && !leaked.includes("320") && !leaked.includes("budget") && !leaked.includes("total"), leaked)
  const viewStager = await vendorProcurementView(mem as any, { vendorId: V_STAGER, brokerageId: B })
  check("V4 a vendor not asked sees no request", viewStager.ok && viewStager.requests.length === 0)

  // ── T: tenant isolation ────────────────────────────────────────────────────
  const foreign = await requestProcurement(mem as any, { brokerageId: B, serviceType: "photography", listingId: LISTING_OTHER }, { access: allow })
  check("T1 a foreign tenant's listing is not found — no request written", !foreign.ok && /not found in this brokerage/.test(foreign.error))
  const crossApprove = await approveProcurementRequest(mem as any, { brokerageId: OTHER, bookingId: bid, approverUserId: uuid(99) })
  check("T2 another tenant cannot approve this request", !crossApprove.ok && reqRow?.status === "requested")
  const crossQuote = await submitProcurementQuote(mem as any, { vendorId: V_FOREIGN, brokerageId: OTHER, userId: uuid(44) }, { bookingId: bid, amount: 1 })
  check("T3 a foreign vendor seat cannot quote on this tenant's request", !crossQuote.ok)
  const crossView = await vendorProcurementView(mem as any, { vendorId: V_FAST, brokerageId: OTHER })
  check("T4 a vendor seat scoped to another tenant sees none of this tenant's requests", crossView.ok && crossView.requests.length === 0)

  // ── A: the agent approves through the EXISTING queue → book (existing writer) ──
  const sent = await approveClientMessage(prop!.id, AGENT_USER, undefined, mem as any)
  check("A4 approving the proposal BOOKS the request through updateVendorBookingStatus (requested → booked)", reqRow?.status === "booked" && reqRow?.approval_status === "approved" && reqRow?.approved_by === AGENT_USER, JSON.stringify({ sent, status: reqRow?.status, a: reqRow?.approval_status }))
  check("A5 the booking is ledgered as a HUMAN decision (procurement.book, HUMAN_REQUESTED) with the kernel event", mem.tables.agent_action_ledger.some((l) => l.action === "vendor.procurement.book" && l.reason_code === "HUMAN_REQUESTED") && mem.tables.lifecycle_events.some((e) => e.event_type === "procurement.booked"), JSON.stringify(mem.tables.agent_action_ledger.map((l) => [l.action, l.reason_code])))
  const lateQuote = await submitProcurementQuote(mem as any, { vendorId: V_CHEAP, brokerageId: B, userId: uuid(41) }, { bookingId: bid, amount: 170 })
  check("V5 quotes close once the request is booked", !lateQuote.ok && /quotes are closed/.test(lateQuote.error ?? ""))

  // reject path → decline
  const mem2 = seed()
  const req2 = await requestProcurement(mem2 as any, { brokerageId: B, serviceType: "photography", listingId: LISTING, requestedByUserId: AGENT_USER, now: NOW }, { access: allow })
  const prop2 = mem2.tables.agent_client_messages.find((m) => m.entity_id === (req2.ok ? req2.bookingId : ""))
  await rejectClientMessage(prop2!.id, AGENT_USER, mem2 as any, "too expensive")
  const row2 = mem2.tables.vendor_bookings.find((b) => b.id === (req2.ok ? req2.bookingId : ""))
  check("A6 rejecting the proposal DECLINES the request (requested → cancelled, approval declined)", row2?.status === "cancelled" && row2?.approval_status === "declined", JSON.stringify(row2))
  const declineAgain = await declineProcurementRequest(mem2 as any, { brokerageId: B, bookingId: row2!.id, approverUserId: AGENT_USER, reason: null })
  check("A7 a non-requested booking is not a procurement decision (notProcurement — the queue keeps its own path)", !declineAgain.ok && declineAgain.notProcurement === true)

  // ── P: autonomy policy ─────────────────────────────────────────────────────
  check("P1 the policy key is registered as versioned tenant policy and defaults OFF", !!TENANT_POLICY_SETTINGS_KEYS[PROCUREMENT_AUTONOMY_POLICY_KEY] && resolveProcurementAutonomy({}).enabled === false && resolveProcurementAutonomy({ procurement_autonomy: "yes" }).enabled === false)
  const pol = resolveProcurementAutonomy({ procurement_autonomy: { enabled: true, max_auto_approve_usd: 350, allowed_service_categories: ["photography"] } })
  check("P2 the policy normalises categories through the ONE vendor vocabulary (photography → photographer)", pol.allowedServiceCategories.join() === "photographer")
  check("P3 under the cap in an allowed category → auto", procurementAutonomyDecision(pol, { category: "photographer", amountUsd: 300 }).auto === true)
  check("P4 over the cap → approval (named)", !procurementAutonomyDecision(pol, { category: "photographer", amountUsd: 351 }).auto && /over the \$350/.test(procurementAutonomyDecision(pol, { category: "photographer", amountUsd: 351 }).reason))
  check("P5 another category → approval; unknown price → approval (never auto-books)", !procurementAutonomyDecision(pol, { category: "stager", amountUsd: 10 }).auto && !procurementAutonomyDecision(pol, { category: "photographer", amountUsd: null }).auto)
  const mem3 = seed({ procurement_autonomy: { enabled: true, max_auto_approve_usd: 350, allowed_service_categories: ["photographer"] } })
  // Wave 108F: the monthly auto-book envelope is granted here (its caps are test:autonomous-budgeting's).
  const auto = await requestProcurement(mem3 as any, { brokerageId: B, serviceType: "photography", listingId: LISTING, neededBy: day(3), budget: 400, now: NOW }, { access: allow, envelope: async () => ({ allowed: true, reason: "granted (fixture)" }) })
  const row3 = mem3.tables.vendor_bookings.find((b) => b.id === (auto.ok ? auto.bookingId : ""))
  check("P6 autonomy ON + $300 ≤ $350 cap: books with NO human and no approval proposal", auto.ok && auto.approval === "auto_approved" && row3?.status === "booked" && row3?.approved_by === null && mem3.tables.agent_client_messages.length === 0, JSON.stringify({ auto, row3 }))
  const bookLedger = mem3.tables.agent_action_ledger.find((l) => l.action === "vendor.procurement.book")
  check("P7 the autonomous booking is ledgered with the POLICY ref (which policy permitted)", !!bookLedger && String(bookLedger.policy_ref ?? "").startsWith(PROCUREMENT_AUTONOMY_POLICY_KEY) && bookLedger.actor_type === "manager", JSON.stringify(bookLedger))
  const mem4 = seed({ procurement_autonomy: { enabled: true, max_auto_approve_usd: 100, allowed_service_categories: ["photographer"] } })
  const capped = await requestProcurement(mem4 as any, { brokerageId: B, serviceType: "photography", listingId: LISTING, neededBy: day(3), budget: 400, now: NOW }, { access: allow })
  check("P8 POSITIVE CONTROL: the same request over a $100 cap waits for approval", capped.ok && capped.approval === "pending" && mem4.tables.vendor_bookings.find((b) => b.id === (capped.ok ? capped.bookingId : ""))?.status === "requested")

  // ── L: completion → review → quality factor ────────────────────────────────
  const before = rankVendorsForRequest(await gatherProcurementFacts(mem as any, { brokerageId: B, serviceType: "photography", jobState: "TX", jobZip: "77001", now: NOW })).ranked.find((r) => r.vendorId === V_FAST)!.factors.quality.score
  // Completion and review ride the SURVIVOR writers (no procurement-owned door): the booking writer's
  // transitions, then the agent rating rateVendorBooking writes, rolled up by the ONE core.
  const c1 = await updateVendorBookingStatus({ bookingId: bid, brokerageId: B, agentUserId: AGENT_USER, toStatus: "confirmed", client: mem as any })
  const c2 = await updateVendorBookingStatus({ bookingId: bid, brokerageId: B, agentUserId: AGENT_USER, toStatus: "completed", client: mem as any })
  check("L1 completion through the existing writer (booked → confirmed → completed, completed_at stamped)", c1.success && c2.success && reqRow?.status === "completed" && !!reqRow?.completed_at, JSON.stringify([c1, c2]))
  const skip = await updateVendorBookingStatus({ bookingId: row2!.id, brokerageId: B, agentUserId: AGENT_USER, toStatus: "completed", client: mem2 as any })
  check("L2 a declined (cancelled) request cannot be completed — the transition graph holds", !skip.success)
  reqRow!.agent_rating = 3
  await recalculateVendorRatingsCore(mem as any, V_FAST, B)
  const after = rankVendorsForRequest(await gatherProcurementFacts(mem as any, { brokerageId: B, serviceType: "photography", jobState: "TX", jobZip: "77001", now: NOW })).ranked.find((r) => r.vendorId === V_FAST)?.factors.quality.score
  check("L3 the review rolls up through recalculateVendorRatingsCore into vendor_ratings", mem.tables.vendor_ratings.some((r) => r.vendor_id === V_FAST && r.avg_agent_rating === 3), JSON.stringify(mem.tables.vendor_ratings.filter((r) => r.vendor_id === V_FAST)))
  check("L4 the loop closes: the next request's QUALITY factor for that vendor moved down", after !== undefined && after < before, `${before} → ${after}`)
  const owner = ["service", "property", "territory", "needed_by", "budget", "requirements", "preferred_vendors", "quotes", "selected_vendor", "approval", "payment", "completion", "review"]
  check("L5 every one of the owner's thirteen PROCUREMENT_REQUEST fields names its survivor home", JSON.stringify(Object.keys(PROCUREMENT_REQUEST_FIELDS).sort()) === JSON.stringify([...owner].sort()))
  const m723 = readFileSync(join(ROOT, "supabase/migrations/m723-procurement-request-is-the-vendor-booking-extended.sql"), "utf8")
  const snap = readFileSync(join(ROOT, "scripts/schema-snapshot.ts"), "utf8")
  const cols = Object.values(PROCUREMENT_REQUEST_FIELDS).flatMap((v) => [...v.matchAll(/(vendor_bookings|vendor_invoices)\.(\w+)/g)].map((m) => [m[1], m[2]] as const))
  const known = (t: string, c: string) => new RegExp(`\\b${t}: \\[[^\\]]*"${c}"`).test(snap) || new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(m723)
  check("L6 payment rides the existing invoice rail (vendor_invoices.booking_id is a live column) and every mapped column is live or added by m723", known("vendor_invoices", "booking_id") && cols.length >= 10 && cols.every(([t, c]) => known(t, c)), JSON.stringify(cols.filter(([t, c]) => !known(t, c))))
  check("L7 POSITIVE CONTROL: the column finder rejects a column that exists nowhere", !known("vendor_bookings", "no_such_column"))

  // ── W: wiring + registration (stripped source) ─────────────────────────────
  const orch = src("lib/orchestrator/internal.ts")
  const sliceOf = (body: string, fn: string) => { const i = body.indexOf(`async function ${fn}(`); return i < 0 ? "" : body.slice(i, body.indexOf("\nasync function ", i + 10)) }
  check("W1 the Listing Concierge's media need (handleListingSigned) requests photography procurement", /requestProcurement\(createServiceClient\(\), \{[\s\S]*serviceType: "photography"/.test(sliceOf(orch, "handleListingSigned")))
  check("W2 POSITIVE CONTROL: the slicer finds nothing in a handler that does not procure", !/requestProcurement/.test(sliceOf(orch, "handleListingLive")) && sliceOf(orch, "handleListingLive").length > 0)
  const acm = src("lib/agents/agent-client-messages.ts")
  check("W3 the approval queue books / declines procurement requests", /approveProcurementRequest\(supabase/.test(acm) && /declineProcurementRequest\(supabase/.test(acm))
  const portal = src("app/actions/vendor-portal.ts")
  const qa = portal.slice(portal.indexOf("export async function submitVendorQuoteAction("))
  check("W4 the vendor quote door gates with requireVendorActor BEFORE the service client", qa.indexOf("requireVendorActor(") > 0 && qa.indexOf("requireVendorActor(") < qa.indexOf("createServiceClient()"))
  check("W5 the vendor jobs surface calls the quote door and lists the vendor's requests", /submitVendorQuoteAction\(/.test(src("app/vendor/jobs/jobs-client.tsx")) && /getMyProcurementRequestsAction\(\)/.test(src("app/vendor/jobs/page.tsx")))
  check("W6 MAINTENANCE_DOMAINS owns marketplace_procurement with this proof and named co-owners; the quote table has a steward", MAINTENANCE_DOMAINS.marketplace_procurement?.proof === "test:procurement" && (MAINTENANCE_DOMAINS.marketplace_procurement?.coOwners?.length ?? 0) >= 2 && (TABLE_MANAGER as Record<string, string>).vendor_booking_quotes === "data_steward")
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  check("W7 registered as test:procurement and a member of the guard chain", pkg.scripts["test:procurement"]?.includes("procurement-guard") === true && new RegExp("npm run test:procurement(\\s|&|$)").test(pkg.scripts.guard))
  const migDir = join(ROOT, "supabase/migrations")
  const latestCheck = (constraint: string): string[] | null => {
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (const f of [...files].reverse()) {
      const body = readFileSync(join(migDir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      const mm = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(body)
      if (mm) return [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    }
    return null
  }
  const vendorsSrc = src("lib/kernel/vendors.ts")
  const graph = /BOOKING_STATUS_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(vendorsSrc)?.[1] ?? ""
  const states = [...new Set([...graph.matchAll(/(\w+)\s*:/g), ...graph.matchAll(/"(\w+)"/g)].map((m) => m[1]))].sort()
  check("W8 the latest migration defining vendor_bookings_status_check lists exactly the states the booking writer transitions", JSON.stringify(latestCheck("vendor_bookings_status_check")) === JSON.stringify(states), JSON.stringify([latestCheck("vendor_bookings_status_check"), states]))
  check("W9 POSITIVE CONTROL: the migration finder returns null for an unknown constraint", latestCheck("no_such_constraint_check") === null)
  const decls = ["lib/kernel", "lib/vendors", "lib/vendor-marketplace", "app/actions"].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`)).filter((f) => /function rankVendorsForRequest\(/.test(src(f)))
  check("W10 ONE ranking: rankVendorsForRequest is defined once (stripped census)", decls.join() === "lib/kernel/procurement.ts", decls.join())

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { for (const f of fails) console.log(`   - ${f}`); console.log(" ❌ PROCUREMENT_FAIL"); process.exit(1) }
  console.log(" ✅ PROCUREMENT_OK")
}

main().catch((e) => { console.error(e); process.exit(1) })
