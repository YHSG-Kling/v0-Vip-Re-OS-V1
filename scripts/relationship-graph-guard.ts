#!/usr/bin/env tsx
/**
 * scripts/relationship-graph-guard.ts   (npm run test:relationship-graph)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RELATIONSHIP GRAPH (wave 102, lane 102B; m698; lib/kernel/relationship-graph.ts).
 *
 * BEHAVIOUR (in-memory supabase — no network, no live rows):
 *   1. upsertRelationship is IDEMPOTENT on (brokerage, from, to, type): a second write is the same
 *      row; higher-confidence evidence replaces, lower never does; symmetric types store once;
 *   2. TENANT ISOLATION: tenant B never sees tenant A's edges (positive control: A does); a write
 *      without a tenant is refused;
 *   3. HOUSEHOLD derivation: two contacts at ONE mailing address with marital evidence →
 *      spouse_partner (confidence carried), address alone → household_member, a different address →
 *      nothing; household() answers from either side;
 *   4. CLOSE OF TRANSACTION derives exactly FOUR edges (bought_from, sold_to, owns, previously_owned)
 *      and re-running derives none again;
 *   5. before m698 is applied (missing table) a write reports degraded and a read is an EMPTY graph.
 * VOCABULARY: RELATIONSHIP_ENTITY_TYPES / RELATIONSHIP_TYPES equal m698's CHECK lists (§6) — with a
 *   mutated-list positive control.
 * MIGRATION (m698 text, SQL comments removed): UNIQUE key, tenant-scoped SELECT policy, no session
 *   write (REVOKE) — each with a mutated-text positive control.
 * CENSUS (stripped source): every survivor writer reaches the ONE kernel writer with the edge type
 *   the lane assigned it; the kernel service is the only relationship_edges inserter; each reader
 *   surface reads the graph — with positive-control fixtures.
 *
 * WAVE 102.1 (lane 102F — 102B's "no deriving writer" items closed on the ONE service):
 *   6. co_buyer: the row's second buyer-side contact (buyer deal only) + buyer/co_buyer roster rows
 *      whose email is a tenant contact → co_buyer (+ owns) at close and roster; idempotent;
 *   7. co_owner: BatchData's OTHER owner name matched to a tenant contact in the same zip (0.75);
 *   8. occupies: the contact's mailing address IS a tenant listing (0.6; 0.7 with a renter/owner signal);
 *   9. R3 backfill: closed transactions missing edges are derived on the weekly cron through the one
 *      derivation — a healed close costs no write, a re-run derives nothing, a missing table degrades;
 *   V. m702 widens the two entity CHECKs by `referral_partner` ONLY (additive; TS list == m698 ∪ m702);
 *   C. the partner-rail lender writes lender_for from a referral_partner; the cron route wires the
 *      backfill and ledgers its summary; R9: contacts.vendor_id writer census (published, UNRESOLVED).
 *
 * WAVE 103 (lane 103D — owner answer 2: contacts.vendor_id → vendors IS a live FK, build its writer on the
 * vendor survivor):
 *   10. lib/kernel/vendor-seat-contact.ts, in memory: planVendorSeatContactLinks (pure: unlinked → link,
 *       this vendor → already, another vendor → never re-pointed), linkVendorSeatContact (tenant-pinned,
 *       case-insensitive email match, link ONLY — no contact created, a foreign vendor refused, a refused
 *       read reported, the update counted, idempotent) with field_provenance.vendor_id stamped through
 *       stampFieldProvenance (source vendor_seat, actor = the accepting user); vendorSeatCorroboration
 *       (pure: the seat's own vendor_for edges corroborate, another vendor's do not). Census: R9 is RESOLVED
 *       — exactly ONE contacts.vendor_id writer (the seat module), called by acceptVendorInviteAction after
 *       the seat's role assignment with the invitation's tenant / vendor / email; the contact brief reads
 *       it ("Is a vendor: <category>") with the vendor's vendor_for edges as corroboration.
 *
 * BLIND SPOTS (published): the survivor writers are proven by census, not executed (their module
 *   graphs pull server-only/cookie edges); the CHECK/RLS/trigger are proven on SQL text, not run
 *   (m698 — APPLIED LIVE 2026-10-05; m702 — APPLIED LIVE 2026-10-05);
 *   a writer reaching relationship_edges through an .rpc() or a dynamic table name is invisible to
 *   the census; evidence confidence values are the lane's defaults, not calibrated; co_owner name
 *   matching is word-set equality (a nickname or a maiden name does not match — a miss, never a
 *   wrong edge); the backfill's "healed" test is a planned-edge set membership, so a close whose
 *   edges were written under a different buyer id (a merged contact) is derived again (idempotent).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  RELATIONSHIP_ENTITY_TYPES, RELATIONSHIP_TYPES, HOUSEHOLD_RELATIONSHIP_TYPES,
  upsertRelationship, neighbors, household,
  planTransactionCloseEdges, deriveTransactionCloseEdges,
  planHouseholdEdges, deriveHouseholdEdges, planRosterEdges,
  representedByOutsideAgent, describeEdge,
  // wave 102.1 (102F)
  coBuyerContactIdsFromTransactionRow, resolveCoBuyerContactIds,
  planCoOwnerEdges, deriveCoOwnerEdges, planOccupancyEdges, deriveOccupancyEdges,
  backfillTransactionCloseEdges,
  // wave 103 (103D)
  vendorSeatCorroboration,
  // wave 105 (105D)
  entityIdForKey, householdNodeId, edgeValidAt, agentVisibleEdges, traverse, rankPaths, endRelationship,
  deriveTeamMembershipEdge, planRecruitEdges, planCompetencyEdges, deriveCompetencyEdges, deriveEducationCompletedEdge,
  deriveOpportunityOwnership, planOpportunityEdges, deriveCampaignInteraction, backfillAgentStructureEdges,
  countRelationships, agentGraphCounts, agentStructureEdges, graphContextFor, RELATIONSHIP_GRAPH_SEAM, TRAVERSE_MAX_DEPTH,
} from "../lib/kernel/relationship-graph"
import { planVendorSeatContactLinks, linkVendorSeatContact, VENDOR_SEAT_PROVENANCE_SOURCE } from "../lib/kernel/vendor-seat-contact"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")
const stripped = (rel: string) => stripComments(read(rel))

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C1 = "aaaaaaaa-0000-4000-8000-000000000001"
const C2 = "aaaaaaaa-0000-4000-8000-000000000002"
const C3 = "aaaaaaaa-0000-4000-8000-000000000003"
const L1 = "bbbbbbbb-0000-4000-8000-000000000001"
const T1 = "cccccccc-0000-4000-8000-000000000001"
const OA = "dddddddd-0000-4000-8000-000000000001"
const U1 = "eeeeeeee-0000-4000-8000-000000000001"
const NOW = "2026-10-05T12:00:00.000Z"
const ev = (confidence: number, source = "test") => ({ source, confidence, observed_at: NOW })

async function main() {
  // ── 1. idempotent upsert ──────────────────────────────────────────────────────────────────
  console.log("\n[1] idempotent upsert")
  {
    const svc = memSupabase({ relationship_edges: [] })
    const first = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: ev(0.6) })
    const second = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: ev(0.6) })
    check("first write creates", first.ok && first.created)
    check("second identical write is the SAME row, not a second one", second.ok && !second.created && first.ok && second.id === first.id && svc.tables.relationship_edges.length === 1)
    const higher = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: ev(0.9, "better") })
    check("higher-confidence evidence replaces", higher.ok && higher.updated && svc.tables.relationship_edges[0].evidence.source === "better")
    const lower = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: ev(0.3, "worse") })
    check("lower-confidence evidence never overwrites", lower.ok && !lower.updated && svc.tables.relationship_edges[0].evidence.source === "better")
    const ab = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C2 }, to: { type: "contact", id: C1 }, type: "spouse_partner", evidence: ev(0.7) })
    const ba = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "contact", id: C2 }, type: "spouse_partner", evidence: ev(0.7) })
    check("a symmetric relation (b→a then a→b) is ONE row, lower id first", ab.ok && ba.ok && ab.id === ba.id && svc.tables.relationship_edges.filter((r) => r.relationship_type === "spouse_partner").length === 1 && svc.tables.relationship_edges.find((r) => r.relationship_type === "spouse_partner")?.from_entity_id === C1)
    const directed = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C2 }, to: { type: "contact", id: C1 }, type: "bought_from", evidence: ev(1) })
    check("a directed relation keeps its direction (orientation is for symmetric types only)", directed.ok && svc.tables.relationship_edges.find((r) => r.relationship_type === "bought_from")?.from_entity_id === C2)
    const selfEdge = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "contact", id: C1 }, type: "owns", evidence: ev(1) })
    check("positive control: a self edge is refused before any write", !selfEdge.ok && !selfEdge.degraded && /itself/.test(selfEdge.error))
    const bad = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "nope" as any, evidence: ev(1) })
    check("an unknown relationship type writes nothing", !bad.ok && svc.tables.relationship_edges.length === 3)
  }

  // ── 2. tenant isolation ────────────────────────────────────────────────────────────────────
  console.log("\n[2] tenant isolation")
  {
    const svc = memSupabase({ relationship_edges: [] })
    await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "agent", id: U1 }, type: "represented_by", evidence: ev(0.9) })
    const asB = await neighbors(svc, { brokerageId: B, entity: { type: "contact", id: C1 } })
    const asA = await neighbors(svc, { brokerageId: A, entity: { type: "contact", id: C1 } })
    check("tenant B sees none of tenant A's edges", asB.ok && asB.edges.length === 0)
    check("positive control: the owning tenant sees the edge", asA.ok && asA.edges.length === 1 && asA.edges[0].relationship_type === "represented_by")
    const noTenant = await upsertRelationship(svc, { brokerageId: "", from: { type: "contact", id: C1 }, to: { type: "agent", id: U1 }, type: "represented_by", evidence: ev(0.9) })
    check("a write without a tenant is refused", !noTenant.ok && svc.tables.relationship_edges.length === 1)
    const sameKeyOtherTenant = await upsertRelationship(svc, { brokerageId: B, from: { type: "contact", id: C1 }, to: { type: "agent", id: U1 }, type: "represented_by", evidence: ev(0.9) })
    check("the UNIQUE key is per tenant: B writes its own row", sameKeyOtherTenant.ok && sameKeyOtherTenant.created && svc.tables.relationship_edges.length === 2)
    const typed = await neighbors(svc, { brokerageId: A, entity: { type: "contact", id: C1 }, types: ["owns"] })
    check("neighbors narrows by type", typed.ok && typed.edges.length === 0)
  }

  // ── 3. household derivation ────────────────────────────────────────────────────────────────
  console.log("\n[3] household derivation (marital status + same mailing address)")
  {
    const spouse = planHouseholdEdges(
      { id: C1, mailing_address: "12 Elm St.", mailing_zip: "78704", marital_status: "Married" },
      [{ id: C2, mailing_address: "12 elm st", mailing_zip: "78704-1234", marital_status: null }, { id: C3, mailing_address: "99 Oak Ave", mailing_zip: "78704", marital_status: "married" }],
      NOW,
    )
    check("two contacts at one address, one with marital evidence → spouse_partner at 0.7", spouse.length === 1 && spouse[0].type === "spouse_partner" && spouse[0].evidence.confidence === 0.7 && spouse[0].to.id === C2)
    check("a different street in the same zip is NOT a household", !spouse.some((e) => e.to.id === C3 || e.from.id === C3))
    const both = planHouseholdEdges({ id: C1, address: "12 Elm St", zip_code: "78704", marital_status: "married" }, [{ id: C2, address: "12 Elm St", zip_code: "78704", marital_status: "partnered" }], NOW)
    check("both partnered → 0.8", both.length === 1 && both[0].evidence.confidence === 0.8)
    const plain = planHouseholdEdges({ id: C1, address: "12 Elm St", zip_code: "78704", marital_status: "single" }, [{ id: C2, address: "12 Elm St", zip_code: "78704", marital_status: null }], NOW)
    check("positive control: address alone → household_member at 0.5, never spouse", plain.length === 1 && plain[0].type === "household_member" && plain[0].evidence.confidence === 0.5)
    check("no address → no household (nothing invented)", planHouseholdEdges({ id: C1, marital_status: "married" }, [{ id: C2, marital_status: "married" }], NOW).length === 0)

    const svc = memSupabase({
      relationship_edges: [],
      contacts: [
        { id: C1, brokerage_id: A, address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null, marital_status: "married" },
        { id: C2, brokerage_id: A, address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null, marital_status: null },
        { id: C3, brokerage_id: B, address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null, marital_status: "married" },
      ],
    })
    const derived = await deriveHouseholdEdges(svc, { brokerageId: A, contactId: C1, now: new Date(NOW) })
    // wave 105 (105D): the same derivation now also plants the household NODE — one spouse edge + two
    // belongs_to_household edges onto ONE deterministic node per (tenant, address cluster).
    const nodeEdges = svc.tables.relationship_edges.filter((r) => r.relationship_type === "belongs_to_household")
    check("deriveHouseholdEdges writes the spouse edge + the household node's two membership edges for the tenant's contacts only", derived.written === 3 && derived.errors.length === 0 && svc.tables.relationship_edges.length === 3 && nodeEdges.length === 2 && new Set(nodeEdges.map((r) => r.to_entity_id)).size === 1 && nodeEdges[0].to_entity_id === householdNodeId(A, "12 elm st|78704") && !svc.tables.relationship_edges.some((r) => r.to_entity_id === C3 || r.from_entity_id === C3))
    const again = await deriveHouseholdEdges(svc, { brokerageId: A, contactId: C2, now: new Date(NOW) })
    check("deriving from the OTHER side finds the same rows (symmetric, stored once; the node id is the same)", again.written === 0 && again.existing === 3 && svc.tables.relationship_edges.length === 3)
    const hh1 = await household(svc, { brokerageId: A, contactId: C1 })
    const hh2 = await household(svc, { brokerageId: A, contactId: C2 })
    check("household() answers from either side and never lists the subject", hh1.ok && hh2.ok && hh1.members.map((m) => m.contactId).join() === C2 && hh2.members.map((m) => m.contactId).join() === C1 && hh1.members[0].type === "spouse_partner")
    check("household() reads only the household types", (HOUSEHOLD_RELATIONSHIP_TYPES as readonly string[]).every((t) => (RELATIONSHIP_TYPES as readonly string[]).includes(t)) && !(HOUSEHOLD_RELATIONSHIP_TYPES as readonly string[]).includes("owns"))
  }

  // ── 4. close of transaction ───────────────────────────────────────────────────────────────
  console.log("\n[4] close of transaction derives four edges")
  {
    const planned = planTransactionCloseEdges({ transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, closeDate: "2026-10-05", observedAt: NOW })
    const types = planned.map((e) => e.type).sort().join(",")
    check("exactly bought_from, owns, previously_owned, sold_to", planned.length === 4 && types === "bought_from,owns,previously_owned,sold_to")
    check("owns runs FROM the close date; previously_owned ends AT it", planned.find((e) => e.type === "owns")?.effectiveFrom === "2026-10-05" && planned.find((e) => e.type === "previously_owned")?.effectiveTo === "2026-10-05")
    check("positive control: no listing → only the two person edges", planTransactionCloseEdges({ transactionId: T1, buyerContactId: C1, sellerContactId: C2, closeDate: "2026-10-05", observedAt: NOW }).length === 2)
    check("a dual-agency row (one contact both sides) proves no self edge", planTransactionCloseEdges({ transactionId: T1, buyerContactId: C1, sellerContactId: C1, listingId: L1, closeDate: "2026-10-05", observedAt: NOW }).every((e) => e.type === "owns"))
    const svc = memSupabase({ relationship_edges: [] })
    const r1 = await deriveTransactionCloseEdges(svc, { brokerageId: A, transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, closeDate: "2026-10-05", actorUserId: U1, now: new Date(NOW) })
    const r2 = await deriveTransactionCloseEdges(svc, { brokerageId: A, transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, closeDate: "2026-10-05", actorUserId: U1, now: new Date(NOW) })
    check("the close writes 4 rows with created_by = the closing user", r1.written === 4 && r1.errors.length === 0 && svc.tables.relationship_edges.length === 4 && svc.tables.relationship_edges.every((r) => r.created_by === U1 && r.brokerage_id === A))
    check("a re-run of the close derives nothing new", r2.written === 0 && r2.existing === 4 && svc.tables.relationship_edges.length === 4)
    const roster = planRosterEdges({ buyerContactId: C1, buyerAgent: { type: "outside_agent", id: OA }, sellerContactId: C2, sellerAgentUserId: U1, observedAt: NOW })
    check("the roster plans represented_by for both sides (outside agent kept as outside_agent)", roster.length === 2 && roster.every((e) => e.type === "represented_by") && roster[0].to.type === "outside_agent" && roster[1].to.type === "agent")
    const rep = await neighbors(svc, { brokerageId: A, entity: { type: "contact", id: C1 }, types: ["represented_by"], direction: "out" })
    check("representedByOutsideAgent is null without such an edge", rep.ok && representedByOutsideAgent(rep.edges, C1) === null)
    await upsertRelationship(svc, { brokerageId: A, ...roster[0] })
    const rep2 = await neighbors(svc, { brokerageId: A, entity: { type: "contact", id: C1 }, types: ["represented_by"], direction: "out" })
    check("positive control: an outside-agent representation is found", rep2.ok && representedByOutsideAgent(rep2.edges, C1)?.to_entity_id === OA)
    check("describeEdge speaks from the contact's side", describeEdge(svc.tables.relationship_edges.find((r) => r.relationship_type === "bought_from") as any, C1).startsWith("bought from contact") && describeEdge(svc.tables.relationship_edges.find((r) => r.relationship_type === "bought_from") as any, C2).startsWith("sold to contact"))
  }

  // ── 5. before m698 ─────────────────────────────────────────────────────────────────────────
  console.log("\n[5] before m698 is applied")
  {
    const svc = memSupabase({ contacts: [] }, { missingTables: ["relationship_edges"] })
    const w = await upsertRelationship(svc, { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: ev(1) })
    const r = await neighbors(svc, { brokerageId: A, entity: { type: "contact", id: C1 } })
    const h = await household(svc, { brokerageId: A, contactId: C1 })
    check("a write reports degraded (not a silent success)", !w.ok && w.degraded)
    check("a read is an EMPTY graph flagged degraded, never a refusal", r.ok && r.degraded && r.edges.length === 0 && h.ok && h.degraded && h.members.length === 0)
    const refused = memSupabase({ relationship_edges: [] }, { refuse: { relationship_edges: "permission denied" } })
    const rr = await neighbors(refused, { brokerageId: A, entity: { type: "contact", id: C1 } })
    check("positive control: a real refusal IS a refusal", !rr.ok && !rr.degraded && /refused/.test(rr.error ?? ""))
  }

  // ── 6. co_buyer ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6] co_buyer — a second buyer-side contact on the deal (102F)")
  {
    const C4 = "aaaaaaaa-0000-4000-8000-000000000004"
    check("a buyer deal's client (contact_id) who is neither buyer nor seller is a co-buyer",
      coBuyerContactIdsFromTransactionRow({ deal_type: "buyer", contact_id: C3, buyer_contact_id: C1, seller_contact_id: C2 }).join() === C3)
    check("positive control: on a seller / dual deal the client column names nobody; the buyer twice names nobody",
      coBuyerContactIdsFromTransactionRow({ deal_type: "seller", contact_id: C3, buyer_contact_id: C1, seller_contact_id: C2 }).length === 0
      && coBuyerContactIdsFromTransactionRow({ deal_type: "dual", contact_id: C3, buyer_contact_id: C1 }).length === 0
      && coBuyerContactIdsFromTransactionRow({ deal_type: "buyer", contact_id: C1, buyer_contact_id: C1 }).length === 0)
    const planned = planTransactionCloseEdges({ transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, coBuyerContactIds: [C3, C1, C2], closeDate: "2026-10-05", observedAt: NOW })
    const types = planned.map((e) => e.type).sort().join(",")
    check("one co-buyer adds exactly co_buyer (buyer↔co-buyer) + owns (co-buyer → home); buyer/seller ids in the list are ignored",
      planned.length === 6 && types === "bought_from,co_buyer,owns,owns,previously_owned,sold_to" && planned.find((e) => e.type === "co_buyer")?.evidence.confidence === 0.9)
    check("positive control: no co-buyers → the four close edges exactly as before", planTransactionCloseEdges({ transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, closeDate: "2026-10-05", observedAt: NOW }).length === 4)
    const svc = memSupabase({
      relationship_edges: [],
      transaction_participants: [
        { brokerage_id: A, transaction_id: T1, role: "buyer", email: "Pat@Example.com" },
        { brokerage_id: A, transaction_id: T1, role: "co_buyer", email: "sam@example.com" },
        { brokerage_id: A, transaction_id: T1, role: "seller", email: "seller@example.com" },
        { brokerage_id: B, transaction_id: T1, role: "co_buyer", email: "other@example.com" },
      ],
      contacts: [
        { id: C1, brokerage_id: A, email: "pat@example.com" },
        { id: C4, brokerage_id: A, email: "sam@example.com" },
        { id: C2, brokerage_id: A, email: "seller@example.com" },
        { id: C3, brokerage_id: B, email: "other@example.com" },
      ],
    })
    const co = await resolveCoBuyerContactIds(svc, { brokerageId: A, transactionId: T1, tx: { deal_type: "buyer", contact_id: C3, buyer_contact_id: C1, seller_contact_id: C2 } })
    check("the roster's co_buyer row resolves by email (case-insensitive) to the tenant's contact; the buyer's own row and the seller never do; the row's client joins the list",
      co.errors.length === 0 && co.ids.join() === [C3, C4].sort().join())
    const closed = await deriveTransactionCloseEdges(svc, { brokerageId: A, transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, coBuyerContactIds: co.ids, closeDate: "2026-10-05", now: new Date(NOW) })
    const again = await deriveTransactionCloseEdges(svc, { brokerageId: A, transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, coBuyerContactIds: co.ids, closeDate: "2026-10-05", now: new Date(NOW) })
    check("two co-buyers close: 4 + co_buyer×3 (buyer↔each, pair) + owns×2 = 9 rows, re-run derives nothing", closed.written === 9 && again.written === 0 && again.existing === 9 && svc.tables.relationship_edges.length === 9)
    const hh = await household(svc, { brokerageId: A, contactId: C1 })
    check("household() of the buyer lists both co-buyers", hh.ok && hh.members.map((m) => m.contactId).sort().join() === [C3, C4].sort().join() && hh.members.every((m) => m.type === "co_buyer"))
    const refused = memSupabase({ contacts: [], transaction_participants: [] }, { refuse: { transaction_participants: "permission denied" } })
    const r = await resolveCoBuyerContactIds(refused, { brokerageId: A, transactionId: T1, tx: { deal_type: "buyer", contact_id: C3, buyer_contact_id: C1 } })
    check("a refused roster read is REPORTED (the row's own co-buyer still resolves)", r.errors.length === 1 && /refused/.test(r.errors[0]) && r.ids.join() === C3)
  }

  // ── 7. co_owner ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7] co_owner — the OTHER owner name on the contact's home, matched to a tenant contact (102F)")
  {
    const subject = { id: C1, first_name: "Maria", last_name: "Lopez", address: "12 Elm St", zip_code: "78704" }
    const planned = planCoOwnerEdges(subject, ["LOPEZ MARIA", "LOPEZ JUAN C"], [
      { id: C2, first_name: "Juan", last_name: "Lopez", zip_code: "78704" },
      { id: C3, first_name: "Juan", last_name: "Perez", zip_code: "78704" },
    ], NOW)
    check("the second owner name matches the contact with the same name words (initials ignored) → co_owner at 0.75; a different surname never matches",
      planned.length === 1 && planned[0].type === "co_owner" && planned[0].evidence.confidence === 0.75 && planned[0].evidence.source === "batchdata_owner_names" && [planned[0].from.id, planned[0].to.id].includes(C2) && ![planned[0].from.id, planned[0].to.id].includes(C3))
    check("positive control: the subject's OWN name never becomes a co-owner edge; one owner name → nothing",
      planCoOwnerEdges(subject, ["Maria Lopez"], [{ id: C2, first_name: "Maria", last_name: "Lopez" }], NOW).length === 0)
    const svc = memSupabase({
      relationship_edges: [],
      contacts: [
        { id: C1, brokerage_id: A, first_name: "Maria", last_name: "Lopez", address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null },
        { id: C2, brokerage_id: A, first_name: "Juan", last_name: "Lopez", address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null },
        { id: C3, brokerage_id: B, first_name: "Juan", last_name: "Lopez", address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null },
      ],
    })
    const d = await deriveCoOwnerEdges(svc, { brokerageId: A, contactId: C1, ownerNames: ["LOPEZ MARIA", "LOPEZ JUAN"], now: new Date(NOW) })
    const d2 = await deriveCoOwnerEdges(svc, { brokerageId: A, contactId: C2, ownerNames: ["LOPEZ JUAN", "LOPEZ MARIA"], now: new Date(NOW) })
    check("deriveCoOwnerEdges writes ONE co_owner row for the tenant's contact only (tenant B's namesake untouched); from the other side it is the same row",
      d.written === 1 && d.errors.length === 0 && d2.written === 0 && d2.existing === 1 && svc.tables.relationship_edges.length === 1 && !svc.tables.relationship_edges.some((r) => r.from_entity_id === C3 || r.to_entity_id === C3))
    check("a single owner name derives nothing (no second owner to name)", (await deriveCoOwnerEdges(svc, { brokerageId: A, contactId: C1, ownerNames: ["LOPEZ MARIA"] })).planned === 0)
  }

  // ── 8. occupies ───────────────────────────────────────────────────────────────────────────
  console.log("\n[8] occupies — the contact's mailing address IS a listing the tenant holds (102F)")
  {
    const L2 = "bbbbbbbb-0000-4000-8000-000000000002"
    const listings = [{ id: L1, address: "12 Elm St.", zip: "78704" }, { id: L2, address: "99 Oak Ave", zip: "78704" }]
    const renter = planOccupancyEdges({ id: C1, mailing_address: "12 elm st", mailing_zip: "78704-1234", home_owner_status: "renter" }, listings, NOW, "rental_graduation")
    const plain = planOccupancyEdges({ id: C1, address: "12 Elm St", zip_code: "78704" }, listings, NOW, "contact_enrichment")
    check("a renter at the listing's address → occupies at 0.7 (the residence signal), source carried", renter.length === 1 && renter[0].type === "occupies" && renter[0].to.id === L1 && renter[0].evidence.confidence === 0.7 && renter[0].evidence.source === "rental_graduation")
    check("address alone → occupies at 0.6; the other listing in the zip is NOT occupied", plain.length === 1 && plain[0].evidence.confidence === 0.6 && !plain.some((e) => e.to.id === L2))
    check("positive control: no address → nothing", planOccupancyEdges({ id: C1, home_owner_status: "renter" }, listings, NOW, "x").length === 0)
    const svc = memSupabase({
      relationship_edges: [],
      contacts: [{ id: C1, brokerage_id: A, address: "12 Elm St", zip_code: "78704", mailing_address: null, mailing_zip: null, home_owner_status: "renter" }],
      listings: [{ id: L1, brokerage_id: A, address: "12 Elm St", zip: "78704", deleted_at: null }, { id: L2, brokerage_id: B, address: "12 Elm St", zip: "78704", deleted_at: null }],
    })
    const d = await deriveOccupancyEdges(svc, { brokerageId: A, contactId: C1, source: "contact_enrichment", now: new Date(NOW) })
    const d2 = await deriveOccupancyEdges(svc, { brokerageId: A, contactId: C1, source: "rental_graduation", now: new Date(NOW) })
    check("deriveOccupancyEdges writes contact → the TENANT's listing only (B's listing at the same address is never an edge); a re-run is the same row",
      d.written === 1 && d.errors.length === 0 && d2.written === 0 && d2.existing === 1 && svc.tables.relationship_edges.length === 1 && svc.tables.relationship_edges[0].to_entity_id === L1)
  }

  // ── 9. R3 backfill ────────────────────────────────────────────────────────────────────────
  console.log("\n[9] R3 — self-healing backfill of closed transactions on the weekly cron (102F)")
  {
    const T2 = "cccccccc-0000-4000-8000-000000000002", T3 = "cccccccc-0000-4000-8000-000000000003", T4 = "cccccccc-0000-4000-8000-000000000004"
    const C4 = "aaaaaaaa-0000-4000-8000-000000000004", L2 = "bbbbbbbb-0000-4000-8000-000000000002"
    const svc = memSupabase({
      relationship_edges: [],
      transaction_participants: [],
      contacts: [],
      transactions: [
        { id: T1, brokerage_id: A, status: "closed", close_date: "2026-09-01", listing_id: L1, buyer_contact_id: C1, seller_contact_id: C2, contact_id: C1, deal_type: "buyer" },
        { id: T2, brokerage_id: A, status: "closed", close_date: "2026-08-01", listing_id: L2, buyer_contact_id: C3, seller_contact_id: C4, contact_id: C3, deal_type: "seller" },
        { id: T3, brokerage_id: A, status: "active", close_date: null, listing_id: L2, buyer_contact_id: C3, seller_contact_id: C4, contact_id: C3, deal_type: "buyer" },
        { id: T4, brokerage_id: B, status: "closed", close_date: "2026-09-01", listing_id: L1, buyer_contact_id: C1, seller_contact_id: C2, contact_id: C1, deal_type: "buyer" },
      ],
    })
    // T1 was derived at its close (the four edges exist); T2 predates m698 (none).
    await deriveTransactionCloseEdges(svc, { brokerageId: A, transactionId: T1, buyerContactId: C1, sellerContactId: C2, listingId: L1, closeDate: "2026-09-01", now: new Date(NOW) })
    const before = svc.tables.relationship_edges.length
    const bf = await backfillTransactionCloseEdges(svc, { brokerageId: A, now: new Date(NOW) })
    check("scans the tenant's CLOSED transactions only (not active, not tenant B's): 2 scanned, the already-derived close is HEALED without a write, the other is derived (4 written)",
      bf.scanned === 2 && bf.healed === 1 && bf.derived === 1 && bf.written === 4 && bf.errors.length === 0 && !bf.degraded && svc.tables.relationship_edges.length === before + 4)
    check("the backfilled close's owns edge runs from ITS close date, under tenant A", svc.tables.relationship_edges.some((r) => r.relationship_type === "owns" && r.from_entity_id === C3 && r.to_entity_id === L2 && r.effective_from === "2026-08-01" && r.brokerage_id === A))
    const bf2 = await backfillTransactionCloseEdges(svc, { brokerageId: A, now: new Date(NOW) })
    check("a re-run heals both and writes nothing (idempotent, self-healing)", bf2.scanned === 2 && bf2.healed === 2 && bf2.derived === 0 && bf2.written === 0 && svc.tables.relationship_edges.length === before + 4)
    check("positive control: tenant B's own run derives ITS close (no cross-tenant healing)", (await backfillTransactionCloseEdges(svc, { brokerageId: B, now: new Date(NOW) })).written === 4 && svc.tables.relationship_edges.filter((r) => r.brokerage_id === B).length === 4)
    const gone = memSupabase({ transactions: [{ id: T1, brokerage_id: A, status: "closed", close_date: "2026-09-01", listing_id: L1, buyer_contact_id: C1, seller_contact_id: C2 }] }, { missingTables: ["relationship_edges"] })
    const bfGone = await backfillTransactionCloseEdges(gone, { brokerageId: A })
    check("before m698 (missing table) the backfill reports degraded and heals nothing — never a silent success", bfGone.degraded && bfGone.written === 0 && bfGone.errors.length === 1)
    check("limit is honoured (bounded batch)", (await backfillTransactionCloseEdges(svc, { brokerageId: A, limit: 1, now: new Date(NOW) })).scanned === 1)
    check("no tenant → refused", (await backfillTransactionCloseEdges(svc, { brokerageId: "" })).errors.join() === "tenant scope required")
  }

  // ── vocabulary vs m698 (+ m702's additive widening) ───────────────────────────────────────
  console.log("\n[V] one vocabulary — TS constants equal m698's CHECK lists ∪ m702's additive widening")
  {
    const sql = read("supabase/migrations/m698-relationship-edges.sql").replace(/--[^\n]*/g, "")
    const M702 = "supabase/migrations/m702-relationship-edges-admit-referral-partner.sql"
    const sql702 = read(M702).replace(/--[^\n]*/g, "")
    const listIn = (text: string, name: string) => {
      const m = text.match(new RegExp(`${name}_check\\s*CHECK\\s*\\(${name === "relationship_edges_relationship_type" ? "relationship_type" : name.endsWith("from_entity_type") ? "from_entity_type" : "to_entity_type"}\\s+IN\\s*\\(([^)]*)\\)`))
      return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : null
    }
    const list = (name: string) => listIn(sql, name)
    const fromL = list("relationship_edges_from_entity_type"), toL = list("relationship_edges_to_entity_type"), relL = list("relationship_edges_relationship_type")
    const from702 = listIn(sql702, "relationship_edges_from_entity_type"), to702 = listIn(sql702, "relationship_edges_to_entity_type")
    // The RULE: the live list is m698's, widened by whatever a later ADDITIVE migration re-states; the
    // TS mirror equals that union. m702 may only ADD (every m698 value survives, in order).
    const additive = (base: string[] | null, next: string[] | null) => !!base && !!next && next.length > base.length && base.every((v, i) => next[i] === v)
    check("m702 only WIDENS m698's two entity lists (every m698 value survives, in order; at least one added)", additive(fromL, from702) && additive(toL, to702))
    check("m702 adds exactly `referral_partner` to both sides", !!from702 && !!to702 && from702.slice(fromL!.length).join() === "referral_partner" && to702.slice(toL!.length).join() === "referral_partner" && from702.join() === to702.join())
    // WAVE 105 (105D): m715 widens all THREE lists additively on top of m702 / m698. The RULE: the TS
    // mirror equals the LATEST additive re-statement, and every re-statement only appends.
    const M715 = "supabase/migrations/m715-relationship-graph-agent-and-person-widening.sql"
    const sql715 = read(M715).replace(/--[^\n]*/g, "")
    const from715 = listIn(sql715, "relationship_edges_from_entity_type"), to715 = listIn(sql715, "relationship_edges_to_entity_type"), rel715 = listIn(sql715, "relationship_edges_relationship_type")
    check("m715 only WIDENS m702's two entity lists and m698's relationship list (every prior value survives, in order; at least one added)", additive(from702, from715) && additive(to702, to715) && additive(relL, rel715))
    check("m715 adds exactly team, territory, campaign, competency, education_module to both entity sides (no `opportunity` entity — it is a relationship onto lead/contact)", !!from715 && !!to715 && from715.slice(from702!.length).join() === "team,territory,campaign,competency,education_module" && to715.join() === from715.join() && !from715.includes("opportunity"))
    check("m715 adds exactly the ten agent/person relationship types", !!rel715 && rel715.slice(relL!.length).join() === "belongs_to_household,has_opportunity,interacted_with_campaign,member_of_team,serves_territory,recruited_by,has_competency,completed_education,earns_residual,owns_opportunity")
    check("from/to entity CHECK lists (m698 ∪ m702 ∪ m715) == RELATIONSHIP_ENTITY_TYPES", !!from715 && !!to715 && from715.join() === RELATIONSHIP_ENTITY_TYPES.join() && to715.join() === RELATIONSHIP_ENTITY_TYPES.join())
    check("relationship_type CHECK list (m698 ∪ m715) == RELATIONSHIP_TYPES", !!rel715 && rel715.join() === RELATIONSHIP_TYPES.join())
    check("positive control: m702 / m698 alone no longer equal the TS lists (the widening is real)", !!from702 && from702.join() !== RELATIONSHIP_ENTITY_TYPES.join() && !!relL && relL.join() !== RELATIONSHIP_TYPES.join())
    check("positive control: the additive finder rejects a REWRITE (a dropped value) and a no-op", !additive(fromL, fromL!.filter((v) => v !== "lead").concat("referral_partner")) && !additive(fromL, fromL))
    check("m702 touches no other constraint, row, policy or index", !/relationship_type_check|INSERT|UPDATE |DELETE|CREATE POLICY|CREATE INDEX|DROP TABLE/.test(sql702))
    check("m715 touches no row, policy, index, column or table (three CHECK re-statements + a COMMENT only)", !/INSERT|UPDATE |DELETE|CREATE POLICY|CREATE INDEX|DROP TABLE|ADD COLUMN|RENAME/.test(sql715) && (sql715.match(/ADD CONSTRAINT/g) ?? []).length === 3)
    check("m715 documents the edge CONTRACT (source / confidence / valid_from = effective_from / valid_to = effective_to / tenant = brokerage_id) in its header", /valid_from\s*=\s*effective_from/.test(read(M715)) && /valid_to\s*=\s*effective_to/.test(read(M715)) && /tenant\s*=\s*brokerage_id/.test(read(M715)) && /source\s*=\s*evidence->>'source'/.test(read(M715)))
    check("m702 header line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(read(M702)))
    check("m715 header line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(read(M715)))
    check("positive control: a mutated list differs", !!rel715 && [...rel715, "friend_of"].join() !== RELATIONSHIP_TYPES.join())
    // CLAUDE.md §2: the status line is a RULE (one provenance stamp), never a pin on the pre-apply waypoint.
    check("m698 header line 1 carries one provenance stamp (the lane stamp | APPLIED LIVE <date>)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}\b)/.test(read("supabase/migrations/m698-relationship-edges.sql")))
    const uniq = /UNIQUE \(brokerage_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type\)/.test(sql)
    const sel = /CREATE POLICY relationship_edges_select[\s\S]*?FOR SELECT TO authenticated[\s\S]*?USING \(is_platform_admin\(\) OR has_brokerage_access\(brokerage_id\)\)/.test(sql)
    const noWrite = /REVOKE INSERT, UPDATE, DELETE ON public\.relationship_edges FROM anon, authenticated/.test(sql) && !/FOR (INSERT|UPDATE|DELETE)/.test(sql)
    check("UNIQUE (brokerage, from, to, type)", uniq)
    check("tenant-scoped SELECT policy; no session write policy, writes revoked", sel && noWrite)
    check("positive control: mutated SQL fails the same finders", !/UNIQUE \(brokerage_id, from_entity_type, from_entity_id, to_entity_type, to_entity_id, relationship_type\)/.test(sql.replace("relationship_type)", "relationship_type, id)")) && /FOR (INSERT|UPDATE|DELETE)/.test(sql + "\nCREATE POLICY x ON y FOR INSERT"))
    check("RLS enabled", /ALTER TABLE public\.relationship_edges ENABLE ROW LEVEL SECURITY/.test(sql))
  }

  // ── census ────────────────────────────────────────────────────────────────────────────────
  // ── 10. contacts.vendor_id — THE writer on the seat survivor (wave 103, lane 103D; owner answer 2) ──
  console.log("\n[10] contacts.vendor_id: the seat link (link only, tenant-pinned, provenance-stamped) + vendor_for corroboration")
  {
    const V1 = "ffffffff-0000-4000-8000-000000000001"
    const V2 = "ffffffff-0000-4000-8000-000000000002"
    const VB = "ffffffff-0000-4000-8000-00000000000b"
    const C4 = "aaaaaaaa-0000-4000-8000-000000000004"
    const C5 = "aaaaaaaa-0000-4000-8000-000000000005"
    const plan = planVendorSeatContactLinks([{ id: C1, vendor_id: null }, { id: C2, vendor_id: V1 }, { id: C3, vendor_id: V2 }, { id: "", vendor_id: null }], V1)
    check("PURE plan: an unlinked row is linked, a row already on THIS vendor is reported as already, a row on ANOTHER vendor is never re-pointed, a blank id is skipped", plan.link.join() === C1 && plan.already.join() === C2 && plan.otherVendor.join() === C3)
    check("positive control: nothing to link → empty plan", planVendorSeatContactLinks([], V1).link.length === 0)
    const seed = () => ({
      vendors: [{ id: V1, brokerage_id: A, category: "plumber", name: "Pipes Co" }, { id: VB, brokerage_id: B, category: "roofer", name: "Roofs" }],
      contacts: [
        { id: C1, brokerage_id: A, email: "Vendor@Pipes.Example", vendor_id: null, enrichment_profile: { field_provenance: { email: { source: "staff" } } } },
        { id: C2, brokerage_id: A, email: "vendor@pipes.example", vendor_id: V2, enrichment_profile: null },
        { id: C3, brokerage_id: B, email: "vendor@pipes.example", vendor_id: null, enrichment_profile: null },
        { id: C4, brokerage_id: A, email: "someone.else@pipes.example", vendor_id: null, enrichment_profile: null },
      ],
    })
    const svc = memSupabase(seed())
    const r = await linkVendorSeatContact(svc, { brokerageId: A, vendorId: V1, email: " vendor@pipes.example ", actorUserId: U1 })
    const row = (id: string) => (svc.tables.contacts as any[]).find((c) => c.id === id)
    check("the tenant's contact with the seat's email is LINKED (case-insensitive match; the other address is not); tenant B's namesake row is untouched", r.ok && r.linked.join() === C1 && row(C1).vendor_id === V1 && row(C3).vendor_id === null && row(C4).vendor_id === null)
    check("a row already on ANOTHER vendor is reported, never re-pointed; the vendor's category comes back for the reader", r.ok && r.otherVendor.join() === C2 && row(C2).vendor_id === V2 && r.category === "plumber" && r.errors.length === 0)
    const fp = row(C1).enrichment_profile?.field_provenance
    check(`provenance through THE one writer: field_provenance.vendor_id {source ${VENDOR_SEAT_PROVENANCE_SOURCE}, capability vendor.seat_link, purpose self_service, actor = the accepting user}; the prior email stamp survives the merge`, fp?.vendor_id?.source === VENDOR_SEAT_PROVENANCE_SOURCE && fp?.vendor_id?.capability === "vendor.seat_link" && fp?.vendor_id?.purpose === "self_service" && fp?.vendor_id?.actor === U1 && typeof fp?.vendor_id?.retrievedAt === "string" && fp?.email?.source === "staff")
    check("the update is tenant-pinned and counted (one contacts update, matched 1)", svc.writes.filter((w) => w.table === "contacts" && w.op === "update").length === 1 && svc.writes.find((w) => w.table === "contacts")!.matched === 1)
    const again = await linkVendorSeatContact(svc, { brokerageId: A, vendorId: V1, email: "vendor@pipes.example", actorUserId: U1 })
    check("a re-run links nothing new (already), writes nothing (idempotent)", again.ok && again.linked.length === 0 && again.already.join() === C1 && svc.writes.filter((w) => w.table === "contacts" && w.op === "update").length === 1)
    check("no contact is ever CREATED by the link (contacts count unchanged)", (svc.tables.contacts as any[]).length === 4 && !svc.writes.some((w) => w.table === "contacts" && w.op === "insert"))
    const foreign = await linkVendorSeatContact(memSupabase(seed()), { brokerageId: A, vendorId: VB, email: "vendor@pipes.example", actorUserId: U1 })
    check("fail closed: a vendor outside the tenant is refused before any read of contacts (vendor_not_in_tenant)", !foreign.ok && foreign.reason === "vendor_not_in_tenant")
    const noTenant = await linkVendorSeatContact(memSupabase(seed()), { brokerageId: "", vendorId: V1, email: "x@y.z", actorUserId: U1 })
    const noEmail = await linkVendorSeatContact(memSupabase(seed()), { brokerageId: A, vendorId: V1, email: "  ", actorUserId: U1 })
    check("no tenant → refused; no email → refused (nothing matched on a blank)", !noTenant.ok && noTenant.reason === "no_tenant" && !noEmail.ok && noEmail.reason === "no_email")
    const refused = await linkVendorSeatContact(memSupabase(seed(), { refuse: { contacts: "permission denied for table contacts" } }), { brokerageId: A, vendorId: V1, email: "vendor@pipes.example", actorUserId: U1 })
    check("a refused contacts read is READ and reported (read_refused), never a silent 'no match'", !refused.ok && refused.reason === "read_refused" && /permission denied/.test(refused.error ?? ""))
    // vendor_for corroboration — the seat's own edges, read for the VENDOR entity
    const edges: any[] = [
      { id: "e1", brokerage_id: A, from_entity_type: "vendor", from_entity_id: V1, to_entity_type: "contact", to_entity_id: C4, relationship_type: "vendor_for", evidence: ev(0.9, "vendor_booking"), effective_from: null, effective_to: null, created_by: null },
      { id: "e2", brokerage_id: A, from_entity_type: "vendor", from_entity_id: V1, to_entity_type: "contact", to_entity_id: C5, relationship_type: "vendor_for", evidence: ev(0.9, "vendor_booking"), effective_from: null, effective_to: null, created_by: null },
      { id: "e3", brokerage_id: A, from_entity_type: "vendor", from_entity_id: V1, to_entity_type: "contact", to_entity_id: C5, relationship_type: "lender_for", evidence: ev(0.9), effective_from: null, effective_to: null, created_by: null },
      { id: "e4", brokerage_id: A, from_entity_type: "vendor", from_entity_id: V2, to_entity_type: "contact", to_entity_id: C4, relationship_type: "vendor_for", evidence: ev(0.9), effective_from: null, effective_to: null, created_by: null },
    ]
    const corr = vendorSeatCorroboration(edges, V1)
    check("vendorSeatCorroboration: the seat's OWN vendor_for edges corroborate (2 served contacts, sorted, deduplicated); another vendor's edge and a lender_for edge do not count", corr.corroborated && corr.served.join() === [C4, C5].sort().join() && corr.edges.length === 2)
    check("positive control: no seat → nothing corroborates; a vendor with no edges → not corroborated", !vendorSeatCorroboration(edges, null).corroborated && !vendorSeatCorroboration(edges, VB).corroborated && vendorSeatCorroboration(edges, VB).served.length === 0)
  }

  // ── 11. WAVE 105 (105D) — the knowledge graph: ids, household node, traversal, the new derivations ──
  console.log("\n[11] wave 105 — deterministic ids, household node, validity window, traversal, derivations, backfill")
  {
    const U2 = "eeeeeeee-0000-4000-8000-000000000002", U3 = "eeeeeeee-0000-4000-8000-000000000003"
    const AG1 = "99999999-0000-4000-8000-000000000001", AG2 = "99999999-0000-4000-8000-000000000002"
    const TEAM = "77777777-0000-4000-8000-000000000001", TERR = "66666666-0000-4000-8000-000000000001"
    const LEAD = "55555555-0000-4000-8000-000000000001", CAMP = "44444444-0000-4000-8000-000000000001", MOD = "33333333-0000-4000-8000-000000000001"
    const L2 = "bbbbbbbb-0000-4000-8000-000000000002"
    // deterministic ids
    const k1 = entityIdForKey("competency", "closing"), k2 = entityIdForKey("competency", "closing"), k3 = entityIdForKey("competency", "closing ")
    check("entityIdForKey is deterministic (same key → same id), uuid-v5-shaped, and key-sensitive", k1 === k2 && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k1) && k1 !== k3 && entityIdForKey("household", "closing") !== k1)
    check("positive control: the household node id is per tenant (same address, two tenants → two nodes)", householdNodeId(A, "12 elm st|78704") !== householdNodeId(B, "12 elm st|78704") && householdNodeId(A, "12 elm st|78704") === householdNodeId(A, "12 elm st|78704"))
    // household node
    const hh = planHouseholdEdges({ id: C1, address: "12 Elm St", zip_code: "78704", marital_status: "married" }, [{ id: C2, address: "12 Elm St", zip_code: "78704" }, { id: C3, address: "99 Oak Ave", zip_code: "78704" }], NOW, { brokerageId: A })
    const belongs = hh.filter((e) => e.type === "belongs_to_household")
    check("a cluster of two contacts at one address → ONE household node, both belong_to_household (0.6), the subject included; the other street does not", belongs.length === 2 && new Set(belongs.map((e) => e.to.id)).size === 1 && belongs.every((e) => e.to.type === "household" && e.evidence.confidence === 0.6) && belongs.map((e) => e.from.id).sort().join() === [C1, C2].sort().join() && !belongs.some((e) => e.from.id === C3))
    check("positive control: without a tenant (the 102F call shape) no node is planned; a lone contact at an address plans no node", planHouseholdEdges({ id: C1, address: "12 Elm St", zip_code: "78704" }, [{ id: C2, address: "12 Elm St", zip_code: "78704" }], NOW).every((e) => e.type !== "belongs_to_household") && planHouseholdEdges({ id: C1, address: "12 Elm St", zip_code: "78704" }, [], NOW, { brokerageId: A }).length === 0)
    // validity window
    check("edgeValidAt honours valid_from / valid_to at their four edges (open both ways, before from, after to, on the boundary days)",
      edgeValidAt({ effective_from: null, effective_to: null }, "2026-10-06") && !edgeValidAt({ effective_from: "2026-10-07", effective_to: null }, "2026-10-06") && !edgeValidAt({ effective_from: null, effective_to: "2026-10-05" }, "2026-10-06") && edgeValidAt({ effective_from: "2026-10-06", effective_to: "2026-10-06" }, "2026-10-06T23:00:00Z"))
    check("agentVisibleEdges drops every edge with a lead endpoint and keeps the contact ones (§5)", agentVisibleEdges([{ from_entity_type: "contact", to_entity_type: "lead" }, { from_entity_type: "agent", to_entity_type: "contact" }, { from_entity_type: "lead", to_entity_type: "campaign" }]).length === 1)
    check("evidence.confidence is REQUIRED by the writer (the m715 contract) — a missing confidence is refused before any write", /confidence is required/.test(((await upsertRelationship(memSupabase({ relationship_edges: [] }), { brokerageId: A, from: { type: "contact", id: C1 }, to: { type: "listing", id: L1 }, type: "owns", evidence: { source: "x", observed_at: NOW } as any })) as any).error ?? ""))
    // traversal: C1 -spouse(0.8)- C2 -owns(1.0)-> L1 ; C2 -represented_by(0.9)-> U1 ; cycle C1-C2-C3-C1 ; expired C1->L2 ; lead edge C1 -> LEAD ; tenant B edge from C1
    const svc = memSupabase({ relationship_edges: [] })
    const w = async (brokerageId: string, from: any, to: any, type: any, confidence: number, extra: any = {}) => upsertRelationship(svc, { brokerageId, from, to, type, evidence: ev(confidence), ...extra })
    await w(A, { type: "contact", id: C1 }, { type: "contact", id: C2 }, "spouse_partner", 0.8)
    await w(A, { type: "contact", id: C2 }, { type: "listing", id: L1 }, "owns", 1)
    await w(A, { type: "contact", id: C2 }, { type: "agent", id: U1 }, "represented_by", 0.9)
    await w(A, { type: "contact", id: C2 }, { type: "contact", id: C3 }, "household_member", 0.5)
    await w(A, { type: "contact", id: C3 }, { type: "contact", id: C1 }, "co_buyer", 0.9)
    await w(A, { type: "contact", id: C1 }, { type: "listing", id: L2 }, "previously_owned", 1, { effectiveTo: "2020-01-01" })
    await w(A, { type: "contact", id: C1 }, { type: "lead", id: LEAD }, "has_opportunity", 0.8)
    await w(B, { type: "contact", id: C1 }, { type: "listing", id: L1 }, "owns", 1)
    const d1 = await traverse(svc, { brokerageId: A, start: { type: "contact", id: C1 }, depth: 1, at: "2026-10-06" })
    const d2 = await traverse(svc, { brokerageId: A, start: { type: "contact", id: C1 }, depth: 2, at: "2026-10-06" })
    const d3 = await traverse(svc, { brokerageId: A, start: { type: "contact", id: C1 }, depth: 9, at: "2026-10-06" })
    const ids = (t: any) => t.nodes.map((n: any) => `${n.entity.type}:${n.entity.id}`).sort().join()
    check("depth 1 reaches the direct neighbours only (C2, C3, the lead) — the expired edge to L2 is NOT followed at `at`", d1.ok && ids(d1) === [`contact:${C1}`, `contact:${C2}`, `contact:${C3}`, `lead:${LEAD}`].sort().join())
    check("depth 2 reaches L1 and U1 through C2; the cycle C1→C2→C3→C1 terminates with every node ONCE", d2.ok && ids(d2) === [`contact:${C1}`, `contact:${C2}`, `contact:${C3}`, `lead:${LEAD}`, `listing:${L1}`, `agent:${U1}`].sort().join() && d2.nodes.filter((n) => n.entity.id === C1).length === 1)
    check("depth is capped at TRAVERSE_MAX_DEPTH (3); a deeper request yields the same graph and the start node is depth 0 at confidence 1", TRAVERSE_MAX_DEPTH === 3 && d3.ok && ids(d3) === ids(d2) && d3.nodes[0].depth === 0 && d3.nodes[0].confidence === 1)
    check("confidence is MULTIPLIED along the path (C1→C2 0.8 × C2→L1 1.0 = 0.8; C1→C2→U1 = 0.72)", d2.nodes.find((n) => n.entity.id === L1)?.confidence === 0.8 && d2.nodes.find((n) => n.entity.id === U1)?.confidence === 0.72)
    check("the better path wins: C3 is reached directly at 0.9 (co_buyer), not via C2 at 0.4", d2.nodes.find((n) => n.entity.id === C3)?.confidence === 0.9 && d2.nodes.find((n) => n.entity.id === C3)?.depth === 1)
    check("positive control: at a date inside the old window the expired edge IS followed", (await traverse(svc, { brokerageId: A, start: { type: "contact", id: C1 }, depth: 1, at: "2019-06-01" })).nodes.some((n) => n.entity.id === L2))
    check("tenant isolation: tenant B's traversal from C1 sees only ITS edge (L1), never A's spouse / co-buyer", ids(await traverse(svc, { brokerageId: B, start: { type: "contact", id: C1 }, depth: 3 })) === [`contact:${C1}`, `listing:${L1}`].sort().join())
    const fan = await traverse(svc, { brokerageId: A, start: { type: "contact", id: C1 }, depth: 1, maxFanOut: 1, at: "2026-10-06" })
    check("bounded fan-out: maxFanOut 1 expands one edge per node and publishes truncated", fan.ok && fan.truncated && fan.nodes.length === 2)
    check("no tenant → refused; no start → refused", !(await traverse(svc, { brokerageId: "", start: { type: "contact", id: C1 } })).ok && !(await traverse(svc, { brokerageId: A, start: { type: "contact", id: "" } })).ok)
    const ranked = rankPaths(d2.nodes, 3)
    // ties at 0.8: C2 (1 hop) and the lead (1 hop) outrank L1 (2 hops); contact sorts before lead on the stable key
    check("rankPaths: highest confidence first, fewest hops next, stable key last, start excluded, limit honoured", ranked.length === 3 && ranked[0].entity.id === C3 && ranked[1].entity.id === C2 && ranked[2].entity.id === LEAD && rankPaths(d2.nodes, 4)[3].entity.id === L1 && !ranked.some((n) => n.depth === 0) && rankPaths(d2.nodes, 0).length === 0)
    const ctx = await graphContextFor(svc, { brokerageId: A, entity: { type: "contact", id: C1 }, depth: 2, at: "2026-10-06" })
    check("graphContextFor (the 105C seam) is agent-safe by default: the lead node is absent (4 of 5 reachable nodes), lines are compact and ranked", ctx.ok && !ctx.nodes.some((n) => n.entity.type === "lead") && ctx.lines.length === 4 && /^contact [0-9a-f]{8} — co_buyer \(1 hop, 90%\)$/.test(ctx.lines[0]))
    check("positive control: agentSafe false hands the lead desk the lead node", (await graphContextFor(svc, { brokerageId: A, entity: { type: "contact", id: C1 }, depth: 1, at: "2026-10-06", agentSafe: false })).nodes.some((n) => n.entity.type === "lead"))
    check("RELATIONSHIP_GRAPH_SEAM exposes neighbors / traverse / graphContextFor / rankPaths / agentVisibleEdges (export only)", RELATIONSHIP_GRAPH_SEAM.neighbors === neighbors && RELATIONSHIP_GRAPH_SEAM.traverse === traverse && RELATIONSHIP_GRAPH_SEAM.graphContextFor === graphContextFor && RELATIONSHIP_GRAPH_SEAM.rankPaths === rankPaths && RELATIONSHIP_GRAPH_SEAM.agentVisibleEdges === agentVisibleEdges)
    const gone = await traverse(memSupabase({}, { missingTables: ["relationship_edges"] }), { brokerageId: A, start: { type: "contact", id: C1 } })
    check("before m698 (missing table) a traversal is the start node alone, flagged degraded, never a refusal", gone.ok && gone.degraded && gone.nodes.length === 1)
    // endRelationship
    const closed = await endRelationship(svc, { brokerageId: A, from: { type: "contact", id: C2 }, to: { type: "listing", id: L1 }, type: "owns", effectiveTo: "2026-10-06" })
    check("endRelationship closes the open window (valid_to = the day), matched 1, never deletes; a LATER close matches 0 (already closed earlier — a window is never re-opened)", closed.ok && closed.matched === 1 && svc.tables.relationship_edges.find((r) => r.relationship_type === "owns" && r.brokerage_id === A)?.effective_to === "2026-10-06" && (await endRelationship(svc, { brokerageId: A, from: { type: "contact", id: C2 }, to: { type: "listing", id: L1 }, type: "owns", effectiveTo: "2026-10-07" })).matched === 0 && svc.tables.relationship_edges.filter((r) => r.relationship_type === "owns" && r.brokerage_id === A).length === 1)
    // team membership (agents.id → users.id cross) + structure backfill
    const st = memSupabase({
      relationship_edges: [],
      agents: [{ id: AG1, brokerage_id: A, user_id: U2, team_id: TEAM, is_active: true }, { id: AG2, brokerage_id: A, user_id: U3, team_id: null, is_active: true }, { id: "ag-b", brokerage_id: B, user_id: "u-b", team_id: TEAM, is_active: true }],
      farm_territories: [{ id: TERR, brokerage_id: A, agent_id: AG2, is_active: true }, { id: "t2", brokerage_id: A, agent_id: null, is_active: true }, { id: "t3", brokerage_id: B, agent_id: "ag-b", is_active: true }],
    })
    const tm = await deriveTeamMembershipEdge(st, { brokerageId: A, teamId: TEAM, agentsId: AG1, source: "team_members", effectiveFrom: "2026-10-06", actorUserId: U1, now: new Date(NOW) })
    check("deriveTeamMembershipEdge crosses agents.id → users.id and writes agent(user) → team member_of_team at 0.95 for the roster source, valid from the day, created_by the actor", tm.written === 1 && tm.errors.length === 0 && st.tables.relationship_edges[0].from_entity_id === U2 && st.tables.relationship_edges[0].to_entity_id === TEAM && st.tables.relationship_edges[0].evidence.confidence === 0.95 && st.tables.relationship_edges[0].effective_from === "2026-10-06" && st.tables.relationship_edges[0].created_by === U1)
    check("positive control: an unknown agents.id derives nothing (no edge invented)", (await deriveTeamMembershipEdge(st, { brokerageId: A, teamId: TEAM, agentsId: "nope", source: "x" })).written === 0 && st.tables.relationship_edges.length === 1)
    const bf1 = await backfillAgentStructureEdges(st, { brokerageId: A, now: new Date(NOW) })
    const bf2 = await backfillAgentStructureEdges(st, { brokerageId: A, now: new Date(NOW) })
    check("backfillAgentStructureEdges: the team edge already derived is EXISTING (no write), AG2's territory becomes serves_territory (agents.id crossed), an unassigned territory and tenant B's rows plan nothing; a re-run writes nothing (idempotent)",
      bf1.planned === 2 && bf1.written === 1 && bf1.existing === 1 && bf1.errors.length === 0 && bf2.written === 0 && bf2.existing === 2 && st.tables.relationship_edges.length === 2 && st.tables.relationship_edges.some((r) => r.relationship_type === "serves_territory" && r.from_entity_id === U3 && r.to_entity_id === TERR && r.brokerage_id === A) && !st.tables.relationship_edges.some((r) => r.brokerage_id === B))
    check("no tenant → refused", (await backfillAgentStructureEdges(st, { brokerageId: "" })).errors.join() === "tenant scope required")
    // recruit edges
    const rec = planRecruitEdges({ recruitUserId: U2, recruiterUserId: U1, residualPlanted: true, observedAt: NOW, provisionedOn: "2026-10-06" })
    check("planRecruitEdges: recruited_by (recruit → recruiter, recruits.recruiter_agent_id, 1.0) + earns_residual (recruiter → recruit, agent_relationships, 1.0) when the tree edge was planted", rec.length === 2 && rec[0].type === "recruited_by" && rec[0].from.id === U2 && rec[0].to.id === U1 && rec[0].evidence.source === "recruits.recruiter_agent_id" && rec[1].type === "earns_residual" && rec[1].from.id === U1 && rec[1].to.id === U2 && rec[1].evidence.source === "agent_relationships" && rec[1].effectiveFrom === "2026-10-06")
    check("positive control: no planted tree edge → recruited_by only; self-recruit → nothing", planRecruitEdges({ recruitUserId: U2, recruiterUserId: U1, residualPlanted: false, observedAt: NOW }).map((e) => e.type).join() === "recruited_by" && planRecruitEdges({ recruitUserId: U1, recruiterUserId: U1, residualPlanted: true, observedAt: NOW }).length === 0)
    // competency
    const comp = planCompetencyEdges(U1, [{ skill: "closing", score: 80, confidence: "high" }, { skill: "coursework", score: 60, confidence: "low" }, { skill: "call_quality", score: 59, confidence: "high" }, { skill: "compliance_ce", score: null, confidence: "none" }], { threshold: 60, observedAt: NOW })
    check("planCompetencyEdges: skills AT or ABOVE the threshold become has_competency (high → 0.9, low → 0.6); below-threshold and unproven skills never do; node id deterministic from the skill key", comp.length === 2 && comp.map((e) => e.evidence.confidence).join() === "0.9,0.6" && comp[0].to.id === entityIdForKey("competency", "closing") && comp.every((e) => e.type === "has_competency" && e.evidence.source === "scoreCompetency"))
    const cs = memSupabase({ relationship_edges: [] })
    const c1 = await deriveCompetencyEdges(cs, { brokerageId: A, agentUserId: U1, skills: [{ skill: "closing", score: 80, confidence: "high" }], threshold: 60, now: new Date(NOW) })
    const c2 = await deriveCompetencyEdges(cs, { brokerageId: A, agentUserId: U1, skills: [{ skill: "closing", score: 85, confidence: "high" }], threshold: 60, now: new Date(NOW) })
    check("deriveCompetencyEdges writes once and is idempotent on the deterministic node", c1.written === 1 && c2.written === 0 && c2.existing === 1 && cs.tables.relationship_edges.length === 1)
    // education
    const ed = memSupabase({ relationship_edges: [] })
    const e1 = await deriveEducationCompletedEdge(ed, { brokerageId: A, learner: { type: "agent", id: U1 }, moduleId: MOD, source: "academy_quiz_pass", completedAt: "2026-10-06T10:00:00Z", actorUserId: U1, now: new Date(NOW) })
    const e2 = await deriveEducationCompletedEdge(ed, { brokerageId: A, learner: { type: "contact", id: C1 }, moduleId: MOD, source: "client_education", now: new Date(NOW) })
    check("deriveEducationCompletedEdge: agent → education_module and contact → education_module, valid from the completion day, source carried", e1.written === 1 && e2.written === 1 && ed.tables.relationship_edges.every((r) => r.relationship_type === "completed_education" && r.to_entity_type === "education_module" && r.to_entity_id === MOD) && ed.tables.relationship_edges[0].effective_from === "2026-10-06" && ed.tables.relationship_edges[1].evidence.source === "client_education")
    check("positive control: no module → nothing", (await deriveEducationCompletedEdge(ed, { brokerageId: A, learner: { type: "agent", id: U1 }, moduleId: "", source: "x" })).planned === 0)
    // opportunity ownership (hand-over closes the old edge)
    const op = memSupabase({ relationship_edges: [], agents: [{ id: AG1, brokerage_id: A, user_id: U2 }, { id: AG2, brokerage_id: A, user_id: U3 }] })
    const o1 = await deriveOpportunityOwnership(op, { brokerageId: A, opportunity: { type: "contact", id: C1 }, toAgentsId: AG1, source: "contact_reassignment", now: new Date("2026-09-01T00:00:00Z") })
    const o2 = await deriveOpportunityOwnership(op, { brokerageId: A, opportunity: { type: "contact", id: C1 }, toAgentsId: AG2, fromAgentsId: AG1, source: "contact_reassignment", now: new Date(NOW) })
    const own = (uid: string) => op.tables.relationship_edges.find((r) => r.relationship_type === "owns_opportunity" && r.from_entity_id === uid)
    check("deriveOpportunityOwnership: the first owner (users id crossed from agents.id) owns_opportunity from its day; the hand-over CLOSES it (valid_to = the day, closed 1) and plants the new owner's edge", o1.written === 1 && o1.closed === 0 && o2.written === 1 && o2.closed === 1 && own(U2)?.effective_from === "2026-09-01" && own(U2)?.effective_to === "2026-10-05" && own(U3)?.effective_from === "2026-10-05" && own(U3)?.effective_to === null)
    check("a release (no target) closes only; a lead opportunity is typed lead", (await deriveOpportunityOwnership(op, { brokerageId: A, opportunity: { type: "contact", id: C1 }, toAgentsId: null, fromAgentsId: AG2, source: "x", now: new Date("2026-10-07T00:00:00Z") })).closed === 1 && (await deriveOpportunityOwnership(op, { brokerageId: A, opportunity: { type: "lead", id: LEAD }, toAgentsId: AG1, source: "lead_handoff", now: new Date(NOW) })).written === 1 && op.tables.relationship_edges.some((r) => r.to_entity_type === "lead" && r.to_entity_id === LEAD))
    // has_opportunity + campaign interaction
    check("planOpportunityEdges: contact + lead → has_opportunity (0.8); a half pair → nothing", planOpportunityEdges({ contactId: C1, leadId: LEAD, source: "sequence_enrollment", observedAt: NOW }).map((e) => `${e.type}:${e.from.type}>${e.to.type}:${e.evidence.confidence}`).join() === "has_opportunity:contact>lead:0.8" && planOpportunityEdges({ contactId: C1, source: "x", observedAt: NOW }).length === 0 && planOpportunityEdges({ leadId: LEAD, source: "x", observedAt: NOW }).length === 0)
    const cm = memSupabase({ relationship_edges: [] })
    const ci = await deriveCampaignInteraction(cm, { brokerageId: A, campaignId: CAMP, contactIds: [C2, C1, C1, ""], source: "marketing_campaign_touchpoints", now: new Date(NOW) })
    check("deriveCampaignInteraction: one interacted_with_campaign edge per distinct contact (0.7), blanks dropped, re-run existing", ci.written === 2 && (await deriveCampaignInteraction(cm, { brokerageId: A, campaignId: CAMP, contactIds: [C1], source: "x" })).existing === 1 && cm.tables.relationship_edges.every((r) => r.relationship_type === "interacted_with_campaign" && r.to_entity_type === "campaign" && r.evidence.confidence === 0.7))
    check("positive control: no campaign → nothing", (await deriveCampaignInteraction(cm, { brokerageId: A, campaignId: "", contactIds: [C1], source: "x" })).planned === 0)
    // scorecard counts + command-center count
    const counts = agentGraphCounts(st.tables.relationship_edges as any, U3)
    check("agentGraphCounts counts the agent's OWN outgoing structure edges only", counts.serves_territory === 1 && !counts.member_of_team && Object.keys(agentGraphCounts(st.tables.relationship_edges as any, U2)).join() === "member_of_team")
    const ase = await agentStructureEdges(st, { brokerageId: A, agentUserIds: [U2, U3] })
    check("agentStructureEdges reads the roster's structure edges in one tenant-scoped read; tenant B reads none", ase.ok && ase.edges.length === 2 && (await agentStructureEdges(st, { brokerageId: B, agentUserIds: [U2, U3] })).edges.length === 0)
    const cnt = await countRelationships(memSupabase({}, { missingTables: ["relationship_edges"] }), { brokerageId: A })
    check("countRelationships before m698 is 0 flagged degraded; a refusal is a refusal; no tenant → refused", cnt.degraded && cnt.count === 0 && /refused/.test((await countRelationships(memSupabase({ relationship_edges: [] }, { refuse: { relationship_edges: "permission denied" } }), { brokerageId: A })).error ?? "") && !!(await countRelationships(st, { brokerageId: "" })).error)
  }

  console.log("\n[C] census — survivor writers reach the one kernel writer (stripped source)")
  {
    const writers: Array<[string, RegExp]> = [
      ["lib/kernel/transactions.ts", /deriveTransactionCloseEdges\(/],
      ["lib/transactions/participant-populator.ts", /planRosterEdges\(/],
      ["lib/offers/outside-agent-record.ts", /type: "represented_by"/],
      ["lib/referrals/referral-record.ts", /type: "referred_by"/],
      ["lib/referrals/agent-referral.ts", /type: "referred_by"/],
      ["lib/kernel/lender-linkage.ts", /type: "lender_for"/], // wave 108: moved with recordLenderReferral (buyer-financial connectBuyerToLender + the lender_preapproval_handoff capability share it)
      ["app/actions/contact-vendor-booking.ts", /type: "vendor_for"/],
      ["app/api/recruiting/provision-agent/route.ts", /type: "sponsor_of"/],
      ["lib/enrichment/household-financials.ts", /deriveHouseholdEdges\(/],
      ["lib/enrichment/contact-enrichment-core.ts", /deriveHouseholdEdges\(/],
      // wave 102.1 (102F)
      ["lib/kernel/transactions.ts", /resolveCoBuyerContactIds\(/],
      ["lib/transactions/participant-populator.ts", /type: "co_buyer"/],
      ["lib/lead-pipeline/enrichment-orchestrator.ts", /deriveCoOwnerEdges\(/],
      ["lib/enrichment/contact-enrichment-core.ts", /deriveOccupancyEdges\(/],
      ["lib/lead-pipeline/rental-graduation-sourcer.ts", /deriveOccupancyEdges\(/],
      ["lib/kernel/lender-linkage.ts", /type: "referral_partner"/],
      ["app/api/cron/source-conversion-learning/route.ts", /backfillTransactionCloseEdges\(/],
      // wave 105 (105D) — every NEW relationship type has a deriving writer at its survivor
      ["lib/kernel/users.ts", /deriveTeamMembershipEdge\(/],
      ["app/actions/admin/agent-profile.ts", /deriveTeamMembershipEdge\(/],
      ["app/actions/admin/team-members.ts", /deriveTeamMembershipEdge\(/],
      ["app/api/recruiting/provision-agent/route.ts", /planRecruitEdges\(/],
      ["lib/learning-router/resolve-agent-learning-context.ts", /deriveCompetencyEdges\(/],
      ["app/actions/academy-learning.ts", /deriveEducationCompletedEdge\(/],
      ["lib/kernel/education.ts", /deriveEducationCompletedEdge\(/],
      ["app/actions/leads.ts", /deriveOpportunityOwnership\(/],
      ["app/actions/contact-reassignment.ts", /deriveOpportunityOwnership\(/],
      ["lib/campaigns/enroll-in-sequence.ts", /planOpportunityEdges\(/],
      ["lib/marketing/touchpoint-recorder.ts", /deriveCampaignInteraction\(/],
      ["app/api/cron/source-conversion-learning/route.ts", /backfillAgentStructureEdges\(/],
    ]
    for (const [file, re] of writers) {
      const src = stripped(file)
      check(`${file} imports @/lib/kernel/relationship-graph and derives ${re.source}`, /@\/lib\/kernel\/relationship-graph/.test(src) && re.test(src))
    }
    // wave 105 — THE RULE: every relationship type m715 adds maps to a derivation in the kernel service
    // whose caller the census above proved. Derived from the TS list, never a hardcoded count.
    {
      const kernel = stripped("lib/kernel/relationship-graph.ts")
      const DERIVATION: Record<string, RegExp> = {
        belongs_to_household: /type: "belongs_to_household"/, has_opportunity: /type: "has_opportunity"/, interacted_with_campaign: /type: "interacted_with_campaign" as const/,
        member_of_team: /type: "member_of_team"/, serves_territory: /type: "serves_territory"/, recruited_by: /type: "recruited_by"/,
        has_competency: /type: "has_competency"/, completed_education: /type: "completed_education"/, earns_residual: /type: "earns_residual"/, owns_opportunity: /type: "owns_opportunity"/,
      }
      const added = (RELATIONSHIP_TYPES as readonly string[]).slice(14)
      const unmapped = added.filter((t) => !DERIVATION[t] || !DERIVATION[t].test(kernel))
      check(`every type m715 adds (${added.length}) is planned by the kernel service (${unmapped.length ? "unmapped: " + unmapped.join(",") : "all mapped"})`, added.length === 10 && unmapped.length === 0)
      check("positive control: an invented type is unmapped", !DERIVATION["friend_of"])
      check("the learning router derives at the curriculum's own bar (COMPETENCY_GAP_SCORE), never a second threshold", /threshold: COMPETENCY_GAP_SCORE/.test(stripped("lib/learning-router/resolve-agent-learning-context.ts")))
      check("the reassignment hands the OLD owner to the derivation so its edge closes; the lead hand-off uses the service client (session writes are revoked)", /fromAgentsId: fromAgentId/.test(stripped("app/actions/contact-reassignment.ts")) && /deriveOpportunityOwnership\(createServiceClient\(\)/.test(stripped("app/actions/leads.ts")))
      check("provision-agent reads the recruiter's users id ONCE and reuses it for sponsor_of (no second agents read)", (stripped("app/api/recruiting/provision-agent/route.ts").match(/from\("agents"\)\.select\("user_id"\)/g) ?? []).length === 1)
      check("the context compiler seam is an EXPORT only — this lane edits no lib/kernel/context-compiler file", /export const RELATIONSHIP_GRAPH_SEAM/.test(kernel) && /export async function graphContextFor/.test(kernel))
      const vocab = stripped("scripts/check-vocabulary-guard.ts")
      check("check-vocabulary-guard mirrors the three graph constants against the live cache + the pending m715 (the pending-vocabulary read)", /constant: "RELATIONSHIP_ENTITY_TYPES"[^\n]*relationship_edges_from_entity_type_check/.test(vocab) && /constant: "RELATIONSHIP_ENTITY_TYPES"[^\n]*relationship_edges_to_entity_type_check/.test(vocab) && /constant: "RELATIONSHIP_TYPES"[^\n]*relationship_edges_relationship_type_check/.test(vocab))
    }
    // 102F — the close passes the resolved co-buyers into the one derivation; the roster derives after
    // the same resolver; the owner names travel from the BatchData client through the one mapper.
    check("closeTransactionCommand passes coBuyerContactIds from resolveCoBuyerContactIds into deriveTransactionCloseEdges", /coBuyerContactIds:\s*coBuyers\.ids/.test(stripped("lib/kernel/transactions.ts")) && /select\("listing_id, buyer_contact_id, seller_contact_id, contact_id, deal_type/.test(stripped("lib/kernel/transactions.ts")))
    check("the BatchData property enrichment carries ownerNames (batchDataOwnerNames) and the ONE mapper keeps them in property_records.batchdata.owner_names",
      /ownerNames:\s*batchDataOwnerNames\(owner\)/.test(stripped("lib/external/batchdata-client.ts")) && /owner_names: e\.ownerNames/.test(stripped("lib/lead-pipeline/enrichment-column-map.ts")))
    check("the weekly cron ledgers the backfill summary (relationship_backfill in the cron success metadata)", /relationship_backfill: relationshipBackfill/.test(stripped("app/api/cron/source-conversion-learning/route.ts")) && /recordCronSuccessAction\(\{[^}]*metadata: summary/.test(stripped("app/api/cron/source-conversion-learning/route.ts")))
    check("the cron that carries the backfill is dispatched weekly (lib/kernel/cron-dispatch.ts)", /\/api\/cron\/source-conversion-learning",\s*schedule: "\d+ \d+ \* \* \d"/.test(stripped("lib/kernel/cron-dispatch.ts")))
    check("the partner rail prefers the vendor endpoint and falls back to the referral_partner (never both, never none when a partner row exists)", /lenderVendorId\s*\?\s*\{ type: "vendor" as const[\s\S]{0,120}referral_partner/.test(stripped("lib/kernel/lender-linkage.ts")) && /recordLenderReferral\(/.test(stripped("app/actions/buyer-financial.ts")))
    // R9 — contacts.vendor_id: the orphan-doctrine census. 102F published 0 writers (UNRESOLVED); the
    // owner ruled (wave 103, answer 2) and lane 103D built THE writer on the seat survivor. The RULE:
    // every contacts writer naming vendor_id is the one kernel seat-link service — never a second
    // path. (Positive control: a fixture is seen.)
    {
      const { execSync: ex } = await import("node:child_process")
      const files = ex(`grep -rl --include=*.ts --include=*.tsx 'from("contacts")' lib app || true`, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
      const vendorIdWriter = (text: string) => /\.from\("contacts"\)[\s\S]{0,400}?\.(insert|update|upsert)\(\s*\{[^)]{0,600}?\bvendor_id\s*:/.test(text)
      const writers = files.filter((f) => vendorIdWriter(stripped(f)))
      console.log(`    R9 census: ${files.length} modules read/write contacts; contacts.vendor_id writers: ${writers.length}${writers.length ? ` (${writers.join(", ")})` : ""}`)
      check("positive control: the R9 finder recognises a fixture contacts writer naming vendor_id", vendorIdWriter(`await svc.from("contacts").update({ vendor_id: v.id }).eq("id", c)`) && !vendorIdWriter(`await svc.from("contacts").select("vendor_id")`))
      check("R9 RESOLVED: contacts.vendor_id has exactly ONE writer and it is lib/kernel/vendor-seat-contact.ts (the seat survivor's link, never a second path)", writers.length === 1 && writers[0] === "lib/kernel/vendor-seat-contact.ts")
      const invite = stripped("app/actions/vendor-invite.ts")
      check("acceptVendorInviteAction (THE seat activation) calls linkVendorSeatContact AFTER the user_role_assignments link, with the invitation's tenant / vendor / email and the accepting user as actor", /from\("user_role_assignments"\)\.insert\(/.test(invite) && invite.indexOf('from("user_role_assignments").insert(') < invite.indexOf("linkVendorSeatContact(svc, {") && /linkVendorSeatContact\(svc, \{\s*brokerageId: invitation\.brokerage_id as string,\s*vendorId: invitation\.vendor_id as string,\s*email: invitation\.email as string,\s*actorUserId: user\.id,/.test(invite))
      check("the seat link never creates a contact (no contacts insert in the seat module) and is link-only in the invite action", !/\.from\("contacts"\)[\s\S]{0,200}?\.insert\(/.test(stripped("lib/kernel/vendor-seat-contact.ts")) && !/\.from\("contacts"\)/.test(invite))
      const brief = stripped("lib/contacts/contact-brief.ts")
      check("the contact brief reads contacts.vendor_id, the vendor's category in the contact's tenant and the seat's own vendor_for edges, and says 'Is a vendor: <category>'", /vendor_id,/.test(brief) && /from\("vendors"\)\.select\("id, name, category"\)\.eq\("id", vendorId\)\.eq\("brokerage_id", brokerageId\)/.test(brief) && /entity: \{ type: "vendor", id: vendorId \}, types: \["vendor_for"\]/.test(brief) && /vendorSeatCorroboration\(own\.edges, vendorId\)/.test(brief) && /`Is a vendor: \$\{vendorSeat\.category/.test(brief))
    }
    const readers: Array<[string, RegExp]> = [
      ["lib/contacts/contact-brief.ts", /neighbors\(/],
      ["lib/contacts/contact-brief.ts", /vendorSeatCorroboration\(/],
      ["lib/ai-isa/lead-action-plan.ts", /representedByOutsideAgent\(/],
      ["lib/ai-isa/lead-action-plan.ts", /householdContactIds/],
      ["lib/kernel/referral-radar.ts", /"referred_by"/],
      ["lib/kernel/portal.ts", /household\(/],
      // wave 105 (105D)
      ["lib/contacts/contact-brief.ts", /agentVisibleEdges\(graph\.edges\)/],
      ["lib/intelligence/agent-scorecard.ts", /agentStructureEdges\(/],
      ["lib/kernel/command-center.ts", /countRelationships\(/],
    ]
    for (const [file, re] of readers) check(`${file} reads the graph (${re.source})`, re.test(stripped(file)))
    check("lead-action-plan turns an outside-agent representation into the already_represented dead end", /outcome: "already_represented", at, source: "relationship_edges\.represented_by"/.test(stripped("lib/ai-isa/lead-action-plan.ts")))
    // The ONE inserter: only the kernel service inserts into relationship_edges.
    const { execSync } = await import("node:child_process")
    const hits = execSync(`grep -rl --include=*.ts --include=*.tsx 'from("relationship_edges")' lib app || true`, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
    const inserters = hits.filter((f) => /\.from\("relationship_edges"\)[\s\S]{0,200}?\.(insert|update|delete|upsert)\(/.test(stripped(f)))
    check(`relationship_edges is written by the kernel service only (${inserters.join(", ") || "none"})`, inserters.length === 1 && inserters[0] === "lib/kernel/relationship-graph.ts")
    check("positive control: the census finder recognises a fixture inserter", /\.from\("relationship_edges"\)[\s\S]{0,200}?\.(insert|update|delete|upsert)\(/.test(`svc.from("relationship_edges").insert({})`))
    check("positive control: a tombstone comment is NOT a call site after stripping", !/deriveHouseholdEdges\(/.test(stripComments(`// deriveHouseholdEdges(svc, x)\n/* deriveHouseholdEdges( */\nconst y = 1`)))
    const reg = stripped("lib/kernel/manager-registry.ts")
    check("TABLE_MANAGER names relationship_edges and MAINTENANCE_DOMAINS registers test:relationship-graph", /relationship_edges: "data_steward"/.test(reg) && /proof: "test:relationship-graph"/.test(reg))
    const pkg = JSON.parse(read("package.json"))
    // The RULE is "in the guard chain, after test:scrapers" — not "immediately after": sibling wave proofs
    // (test:person-identity) share that slot (CLAUDE.md §2, assert the rule not the waypoint).
    check("package.json registers the proof in the guard chain after test:scrapers", typeof pkg.scripts["test:relationship-graph"] === "string" && pkg.scripts.guard.indexOf("npm run test:relationship-graph") > pkg.scripts.guard.indexOf("npm run test:scrapers") && pkg.scripts.guard.indexOf("npm run test:scrapers") >= 0)
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail ? "\n  " + fails.join("\n  ") : ""}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
