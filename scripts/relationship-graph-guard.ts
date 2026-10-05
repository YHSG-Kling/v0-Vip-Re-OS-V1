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
 * BLIND SPOTS (published): the survivor writers are proven by census, not executed (their module
 *   graphs pull server-only/cookie edges); the CHECK/RLS/trigger are proven on SQL text, not run
 *   (m698 — APPLIED LIVE 2026-10-05); a writer reaching relationship_edges through an .rpc() or a
 *   dynamic table name is invisible to the census; evidence confidence values are the lane's
 *   defaults, not calibrated.
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
} from "../lib/kernel/relationship-graph"

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
    check("deriveHouseholdEdges writes the spouse edge for the tenant's contacts only", derived.written === 1 && derived.errors.length === 0 && svc.tables.relationship_edges.length === 1 && !svc.tables.relationship_edges.some((r) => r.to_entity_id === C3 || r.from_entity_id === C3))
    const again = await deriveHouseholdEdges(svc, { brokerageId: A, contactId: C2, now: new Date(NOW) })
    check("deriving from the OTHER side finds the same row (symmetric, stored once)", again.written === 0 && again.existing === 1 && svc.tables.relationship_edges.length === 1)
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

  // ── vocabulary vs m698 ────────────────────────────────────────────────────────────────────
  console.log("\n[V] one vocabulary — TS constants equal m698's CHECK lists")
  {
    const sql = read("supabase/migrations/m698-relationship-edges.sql").replace(/--[^\n]*/g, "")
    const list = (name: string) => {
      const m = sql.match(new RegExp(`${name}_check\\s*CHECK\\s*\\(${name === "relationship_edges_relationship_type" ? "relationship_type" : name.endsWith("from_entity_type") ? "from_entity_type" : "to_entity_type"}\\s+IN\\s*\\(([^)]*)\\)`))
      return m ? m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : null
    }
    const fromL = list("relationship_edges_from_entity_type"), toL = list("relationship_edges_to_entity_type"), relL = list("relationship_edges_relationship_type")
    check("from/to entity CHECK lists == RELATIONSHIP_ENTITY_TYPES", !!fromL && !!toL && fromL.join() === RELATIONSHIP_ENTITY_TYPES.join() && toL.join() === RELATIONSHIP_ENTITY_TYPES.join())
    check("relationship_type CHECK list == RELATIONSHIP_TYPES (14)", !!relL && relL.join() === RELATIONSHIP_TYPES.join() && relL.length === 14)
    check("positive control: a mutated list differs", !!relL && [...relL, "friend_of"].join() !== RELATIONSHIP_TYPES.join())
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
  console.log("\n[C] census — survivor writers reach the one kernel writer (stripped source)")
  {
    const writers: Array<[string, RegExp]> = [
      ["lib/kernel/transactions.ts", /deriveTransactionCloseEdges\(/],
      ["lib/transactions/participant-populator.ts", /planRosterEdges\(/],
      ["lib/offers/outside-agent-record.ts", /type: "represented_by"/],
      ["lib/referrals/referral-record.ts", /type: "referred_by"/],
      ["lib/referrals/agent-referral.ts", /type: "referred_by"/],
      ["app/actions/buyer-financial.ts", /type: "lender_for"/],
      ["app/actions/contact-vendor-booking.ts", /type: "vendor_for"/],
      ["app/api/recruiting/provision-agent/route.ts", /type: "sponsor_of"/],
      ["lib/enrichment/household-financials.ts", /deriveHouseholdEdges\(/],
      ["lib/enrichment/contact-enrichment-core.ts", /deriveHouseholdEdges\(/],
    ]
    for (const [file, re] of writers) {
      const src = stripped(file)
      check(`${file} imports @/lib/kernel/relationship-graph and derives ${re.source}`, /@\/lib\/kernel\/relationship-graph/.test(src) && re.test(src))
    }
    const readers: Array<[string, RegExp]> = [
      ["lib/contacts/contact-brief.ts", /neighbors\(/],
      ["lib/ai-isa/lead-action-plan.ts", /representedByOutsideAgent\(/],
      ["lib/ai-isa/lead-action-plan.ts", /householdContactIds/],
      ["lib/kernel/referral-radar.ts", /"referred_by"/],
      ["lib/kernel/portal.ts", /household\(/],
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
