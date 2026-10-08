#!/usr/bin/env tsx
/**
 * scripts/mission-context-guard.ts   (npm run test:mission-context) — wave 105, lane 105C.
 * ─────────────────────────────────────────────────────────────────────────────
 * SHARED WORKING CONTEXT + CONTEXT COMPILER — in-memory client + recorder seams, no network.
 * Proves lib/kernel/mission-context.ts and the working context on lib/kernel/missions.ts:
 *   A. every slice present with its READER named; memory read once (handed into the NBA reader);
 *      effective authority = manager rung ∧ mission ceiling; the compile is BOOKED (0 cost / 0 tokens)
 *   B. the token budget holds (never over; truncation marked; newest events survive) + positive control
 *   C. a refused read → published blind spot on the slice AND in the section (never silent)
 *   D. tenant isolation — a foreign tenant reads not_found
 *   E. the agent audience sees no budget / cost
 *   F. working context: latest wins, the one writer appends evidence + a mission_events row,
 *      transitions record / clear waiting_on, progress records the unmet criteria
 *   G. census (stripped source): the compiler names no table a survivor reader already reads (+ control)
 *   H. wiring (stripped source) + registration (MAINTENANCE_DOMAINS, package.json, chain)
 * Rules asserted, not waypoints: no migration pin, no literal counts of the survivors' tables.
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { estimateTokens } from "../lib/ai/cost-tracking"
import {
  compileManagerContext, renderManagerContextSection, contextBlocks, mountToolsFromContext, 
  TRUNCATED_MARKER, CONTACT_CONTEXT_COLUMNS, type MissionContextDeps, type ManagerContext,
} from "../lib/kernel/mission-context"
import {
  currentWorkingContext, updateMissionWorkingContext, transitionMission, recordMissionProgress, WORKING_CONTEXT_EVIDENCE_KIND, type MissionDeps, type MissionRow,
} from "../lib/kernel/missions"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (the missions proof's, with the filters this module uses) ──
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}) {
  const t = (name: string) => (tables[name] ??= [])
  return {
    tables,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      const run = (): { data: any; error: any } => {
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...r }))
          for (const r of rows) t(table).push(r)
          return { data: rows, error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const C1 = "cccccccc-1111-4111-8111-cccccccccccc"
const A1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
const M1 = "mmmmmmmm-1111-4111-8111-mmmmmmmmmmmm"
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString()

function fixture(): ReturnType<typeof memClient> {
  const mission: MissionRow = {
    id: M1, brokerage_id: T1, objective: "List 42 Elm St by the end of the quarter", mission_type: "transaction", owner_manager: "ai_isa", participating_managers: ["deal_coordinator"],
    subject_type: "contact", subject_id: C1, state: "ACTIVE", priority: "high", success_criteria: [{ metric: "listing_signed", op: ">=", target: 1 }],
    budget: { usd: 50, tokens: null }, spent_usd: 12.5, spent_tokens: 300, authority_ceiling: 4, deadline: iso(-60 * 24 * 10), dependencies: [], blockers: [],
    evidence: [
      { kind: WORKING_CONTEXT_EVIDENCE_KIND, objective_now: "book the listing appointment", waiting_on: { who: "seller", what: "availability for Thursday", since: iso(30) }, updated_at: iso(30), updated_by: "manager:ai_isa" },
      { kind: WORKING_CONTEXT_EVIDENCE_KIND, objective_now: "stale older revision", updated_at: iso(120), updated_by: "system" },
      { kind: "other", note: "not a working context" },
    ],
    progress: {}, actions: [], outcomes: [], created_by: null, parent_mission: null, state_changed_at: iso(60), completed_at: null, created_at: iso(500), updated_at: iso(30),
  }
  return memClient({
    missions: [mission],
    contacts: [{ id: C1, brokerage_id: T1, first_name: "Dana", last_name: "Seller", contact_type: "seller", contact_persona: "motivated_seller", agent_id: A1, team_id: null, timeline: "3-6", ai_outreach_paused: false, metadata: {} }],
    listings: [{ id: "l1", brokerage_id: T1, seller_contact_id: C1, address: "42 Elm St", city: "Austin", state: "TX", list_price: 650000, status: "draft", lifecycle_stage: "pre_listing", created_at: iso(10) }],
    buyer_fatigue_scores: [{ brokerage_id: T1, contact_id: C1, risk_level: "moderate", fatigue_score: 41, last_calculated_at: iso(90) }],
    mission_events: Array.from({ length: 6 }, (_, i) => ({ brokerage_id: T1, mission_id: M1, event_kind: "transition", from_state: "PLANNING", to_state: "ACTIVE", reason: `event-${i}`, created_at: iso(10 * (i + 1)) })),
    lifecycle_events: [{ brokerage_id: T1, entity_type: "contact", entity_id: C1, event_type: "listing.appointment_set", metadata: { reason: "newest-lifecycle" }, created_at: iso(1) }],
    manager_delegations: [
      { id: "d1", mission_id: M1, brokerage_id: T1, requesting_manager: "ai_isa", assigned_manager: "listing_concierge", requested_capability: "listing_appointment_prep", objective: "prep the seller appointment", status: "ACCEPTED", deadline: null, budget: {}, spent_usd: 0, created_at: iso(3) },
      { id: "d2", mission_id: M1, brokerage_id: T1, requesting_manager: "ai_isa", assigned_manager: "asset_manager", requested_capability: "cma_generate", objective: "done", status: "RETURNED", deadline: null, budget: {}, spent_usd: 0, created_at: iso(40) },
      { id: "d3", mission_id: "other-mission", brokerage_id: T1, requesting_manager: "ai_isa", assigned_manager: "asset_manager", requested_capability: "cma_generate", objective: "elsewhere", status: "REQUESTED", deadline: null, budget: {}, spent_usd: 0, created_at: iso(2) },
    ],
    manager_signals: [
      { id: "s1", brokerage_id: T1, entity_type: "mission", entity_id: M1, from_manager: "ai_isa", to_manager: "deal_coordinator", signal_type: "delegation_request", status: "open", message: "pull the comps", created_at: iso(5) },
      { id: "s2", brokerage_id: T1, entity_type: "mission", entity_id: M1, from_manager: "ai_isa", to_manager: "asset_manager", signal_type: "contact_reel_handoff", status: "consumed", message: "done", created_at: iso(50) },
    ],
    ai_tool_usage: [],
  })
}

/** Recorder seams for the survivors a proof must not hit (they open their own clients / read many tables). */
function seams(over: Partial<MissionContextDeps> = {}) {
  const seen: Record<string, unknown[]> = { nba: [], identity: [], capacity: [], policy: [] }
  const memory = { spine: { summary: "Dana wants to list before the school year" }, block: "Summary: Dana wants to list before the school year\n- timeline: 3-6 months" }
  const deps: MissionContextDeps = {
    identity: async (b, id) => { seen.identity.push({ b, id }); return { personId: "pppppppp-1111-4111-8111-pppppppppppp", evidenceCount: 3, error: null } },
    memory: async () => memory,
    nba: async (b, contact, mem) => { seen.nba.push({ b, contactId: contact.id, memory: mem }); return { ok: true, context: { appointmentAt: new Date(Date.now() + 86_400_000), callbackRequested: false, deadEnds: [], memoryFacts: [], householdContactIds: ["h2"] } } },
    policy: async (b, manager) => { seen.policy.push({ b, manager }); return { isaPolicyRef: "ai_isa_settings@3", managerPolicyRef: `authority_level:${manager}@1`, brandBlock: "BRAND: warm, concise.", voice: { systemBlock: "BRAND: warm, concise.", tagline: null } as any, error: null } },
    capacity: async (b, agentId) => { seen.capacity.push({ b, agentId }); return { band: "available", load: 14, fatigueTier: "healthy", error: null } },
    authority: async () => 6,
    ...over,
  }
  return { deps, seen, memory }
}

const base = { brokerageId: T1, missionId: M1, manager: "ai_isa" as const }
const SLICES = ["mission", "working", "person", "property", "opportunity", "memory", "policy", "fatigue", "capacity", "events", "delegations", "tools", "budget"] as const

async function main() {
  // ─── A. every slice, its reader, memory once, authority, booking ────────────────────────────
  console.log("\nA. every slice present with its reader named")
  {
    const c = fixture(); const s = seams()
    const r = await compileManagerContext({ ...base, tokenBudget: 4000, client: c as any, deps: s.deps, toolRegistry: { lookup_contact: {}, send_email: {}, rentcast_property: {} } })
    check("A1 compile ok", r.ok, r.ok ? undefined : r.reason)
    if (!r.ok) throw new Error(r.reason)
    const ctx = r.context
    const missing = SLICES.filter((k) => !(ctx[k] as any)?.reader || (ctx[k] as any)?.data === null)
    check("A2 all thirteen slices carry data and name their reader", missing.length === 0, `missing: ${missing.join(", ")}`)
    check("A3 every slice carries a freshness stamp", SLICES.every((k) => typeof (ctx[k] as any)?.freshness === "string"))
    check("A4 the working context is the LATEST revision (latest wins, order in the array ignored)", ctx.working.data?.objective_now === "book the listing appointment" && ctx.working.data?.waiting_on?.who === "seller")
    check("A5 the memory spine is read ONCE and handed into the NBA reader", s.seen.nba.length === 1 && (s.seen.nba[0] as any).memory === s.memory)
    check("A6 effective authority = manager rung ∧ mission ceiling (6 ∧ 4 = 4); tools mounted at that rung", ctx.tools.data?.effective === 4 && Array.isArray(ctx.tools.data?.available) && Object.keys(mountToolsFromContext(ctx, { lookup_contact: {} })).length === 1)
    check("A7 budget = cap − spent from the row", ctx.budget?.data?.usdRemaining === 37.5 && ctx.budget?.data?.exhausted === false)
    check("A8 events newest first across both ledgers (lifecycle row on top)", ctx.events.data?.[0]?.summary === "newest-lifecycle" && ctx.events.data?.[1]?.summary === "PLANNING→ACTIVE event-0")
    check("A9 the open delegation OBJECT (m712) and the OPEN signal are pending; the RETURNED object, the other mission's object and the consumed signal are dropped", ctx.delegations.data?.length === 2 && ctx.delegations.data?.[0]?.kind === "listing_appointment_prep" && ctx.delegations.data?.[0]?.to === "listing_concierge" && ctx.delegations.data?.[1]?.to === "deal_coordinator")
    check("A10 the compile is BOOKED on ai_tool_usage — feature mission_context, 0 tokens / 0 cost, manager named", c.tables.ai_tool_usage.length === 1 && c.tables.ai_tool_usage[0].feature === "mission_context" && c.tables.ai_tool_usage[0].cost_cents === 0 && c.tables.ai_tool_usage[0].tokens_used === 0 && c.tables.ai_tool_usage[0].manager === "ai_isa" && c.tables.ai_tool_usage[0].brokerage_id === T1)
    check("A11 the section names every reader beside its slice", ["getMission", "loadContactNbaContext", "loadContactMemoryForPrompt", "resolvePolicyRef", "capacityFor", "selectToolsForPersona", "manager_signals"].every((n) => r.section.includes(n)))
    check("A12 no blind spots on a clean compile", ctx.blindSpots.length === 0, JSON.stringify(ctx.blindSpots))
    check("A13 the delegations slice names the delegation OBJECTS reader (manager-delegation.ts pendingDelegationsFor) beside the signal channel", /pendingDelegationsFor/.test(ctx.delegations.reader) && /manager_signals/.test(ctx.delegations.reader))
  }

  // ─── B. the token budget ────────────────────────────────────────────────────────────────────
  console.log("\nB. the token budget holds")
  {
    const c = fixture(); const s = seams()
    const big = await compileManagerContext({ ...base, tokenBudget: 100_000, client: c as any, deps: s.deps })
    const small = await compileManagerContext({ ...base, tokenBudget: 120, client: c as any, deps: s.deps })
    if (!big.ok || !small.ok) throw new Error("compile failed in B")
    check("B1 a generous budget is not truncated and reports its true token count", !big.truncated && big.tokens === estimateTokens(big.section) && !big.section.includes(TRUNCATED_MARKER))
    check("B2 a tight budget never exceeds it and carries an honest marker", small.truncated && small.tokens <= 120 && small.section.includes(TRUNCATED_MARKER))
    check("B3 the mission header survives every truncation (the floor)", small.section.startsWith("MISSION ("))
    const mid = renderManagerContextSection(big.context, big.tokens - 12)
    check("B4 most-recent-first: the OLDEST event is cut before the newest", mid.truncated && !mid.section.includes("event-5") && mid.section.includes("newest-lifecycle"))
    check("B5 positive control: contextBlocks orders events newest first and the renderer cuts the LAST line", contextBlocks(big.context).find((b) => b.name === "events")!.lines.at(-1)!.includes("event-5"))
    const r = await compileManagerContext({ ...base, tokenBudget: 0, client: c as any, deps: s.deps })
    check("B6 a non-positive budget is refused, never rendered unbounded", !r.ok)
  }

  // ─── C. refused reads are blind spots ───────────────────────────────────────────────────────
  console.log("\nC. refused slice → published blind spot")
  {
    const c = fixture()
    const s = seams({ nba: async () => ({ ok: false, error: "touch / appointment / callback read refused: boom" }), fatigue: async () => ({ riskLevel: null, score: null, at: null, found: false, error: "buyer_fatigue_scores read refused: rls" }) })
    const r = await compileManagerContext({ ...base, tokenBudget: 4000, client: c as any, deps: s.deps })
    if (!r.ok) throw new Error(r.reason)
    check("C1 the refused slices carry their refusal and null data", r.context.opportunity.refused?.includes("boom") === true && r.context.opportunity.data === null && r.context.fatigue.refused?.includes("rls") === true)
    check("C2 blindSpots names each refused slice WITH its reader", r.context.blindSpots.some((b) => b.slice === "opportunity" && b.reader.includes("loadContactNbaContext")) && r.context.blindSpots.some((b) => b.slice === "fatigue"))
    check("C3 the rendered section publishes the blind spots (never a silent blank)", r.section.includes("BLIND SPOTS") && r.section.includes("boom") && r.section.includes("(unreadable — "))
    check("C4 the booking records the blind-spot count", c.tables.ai_tool_usage[0]?.context_json?.blind_spots === 2)
    const s2 = seams({ authority: async () => { throw new Error("ladder down") } })
    const r2 = await compileManagerContext({ ...base, tokenBudget: 4000, client: fixture() as any, deps: s2.deps })
    check("C5 an unreadable authority ladder FAILS CLOSED to rung 0 and is a blind spot", r2.ok && r2.context.tools.data?.effective === 0 && r2.context.blindSpots.some((b) => b.slice === "tools"))
  }

  // ─── D. tenant isolation ────────────────────────────────────────────────────────────────────
  console.log("\nD. tenant isolation")
  {
    const c = fixture(); const s = seams()
    const r = await compileManagerContext({ brokerageId: T2, missionId: M1, manager: "ai_isa", tokenBudget: 4000, client: c as any, deps: s.deps })
    check("D1 a foreign tenant reads not_found — no slice compiled, nothing booked", !r.ok && r.reason === "not_found" && c.tables.ai_tool_usage.length === 0 && s.seen.nba.length === 0)
    const r2 = await compileManagerContext({ brokerageId: "", missionId: M1, manager: "ai_isa", tokenBudget: 4000, client: c as any, deps: s.deps })
    check("D2 no tenant → refused", !r2.ok)
    const s3 = seams()
    const c3 = fixture(); c3.tables.contacts[0].brokerage_id = T2
    const r3 = await compileManagerContext({ ...base, tokenBudget: 4000, client: c3 as any, deps: s3.deps })
    check("D3 a contact of another tenant is not found (tenant-pinned row read) and is a blind spot", r3.ok && r3.context.person.data === null && r3.context.blindSpots.some((b) => b.slice === "person") && s3.seen.nba.length === 0)
  }

  // ─── E. agents see no cost ──────────────────────────────────────────────────────────────────
  console.log("\nE. the agent audience sees no cost")
  {
    const c = fixture(); const s = seams()
    const r = await compileManagerContext({ ...base, audience: "agent", tokenBudget: 4000, client: c as any, deps: s.deps })
    if (!r.ok) throw new Error(r.reason)
    check("E1 budget slice is null and the section carries no BUDGET line / spend figure (the listing price is not cost)", r.context.budget === null && !r.section.includes("BUDGET (") && !r.section.includes("spent") && !r.section.includes("$12.50"))
    const m = await compileManagerContext({ ...base, tokenBudget: 4000, client: c as any, deps: s.deps })
    check("E2 positive control: the manager audience does see the budget", m.ok && m.section.includes("BUDGET (") && m.section.includes("$12.50"))
  }

  // ─── F. the working context on the mission row ──────────────────────────────────────────────
  console.log("\nF. working context — latest wins, one writer, transitions and progress revise it")
  {
    check("F1 currentWorkingContext ignores non-working evidence and picks the newest by updated_at", currentWorkingContext({ evidence: [{ kind: "x" }, { kind: WORKING_CONTEXT_EVIDENCE_KIND, objective_now: "old", updated_at: "2026-01-01T00:00:00Z", updated_by: "s" }, { kind: WORKING_CONTEXT_EVIDENCE_KIND, objective_now: "new", updated_at: "2026-02-01T00:00:00Z", updated_by: "s" }] })?.objective_now === "new" && currentWorkingContext({ evidence: [] }) === null)
    const c = fixture()
    const recorded: any[] = []
    const deps: MissionDeps = { ledger: async (ctx) => { recorded.push(ctx); return "ledger-1" }, emit: async () => {}, signal: async () => {}, afford: async () => ({ allowed: true, reason: "active" }), authority: async () => 6 as any }
    const w = await updateMissionWorkingContext({ brokerageId: T1, missionId: M1, actor: { type: "manager", id: "ai_isa" }, patch: { open_requests: [{ id: "d1", to: "deal_coordinator", what: "pull comps", since: iso(0) }] } }, c as any, deps)
    const row = c.tables.missions[0] as MissionRow
    check("F2 the writer merges onto the latest revision, appends it (never rewrites) and derives budget_remaining", w.ok && w.working?.objective_now === "book the listing appointment" && w.working?.open_requests?.length === 1 && w.working?.budget_remaining_usd === 37.5 && row.evidence.filter((e) => e.kind === WORKING_CONTEXT_EVIDENCE_KIND).length === 3 && currentWorkingContext(row)?.open_requests?.length === 1)
    check("F3 every revision leaves a mission_events `evidence` row naming the patch keys", c.tables.mission_events.some((e) => e.event_kind === "evidence" && e.evidence?.patch_keys?.[0] === "open_requests" && e.actor_id === "ai_isa"))
    const foreign = await updateMissionWorkingContext({ brokerageId: T2, missionId: M1, patch: { notes: ["x"] } }, c as any, deps)
    check("F4 a foreign tenant cannot revise it (not_found)", !foreign.ok && foreign.reason === "not_found")
    const hold = await transitionMission({ brokerageId: T1, missionId: M1, to: "WAITING", reason: "seller travelling until Monday", actor: { type: "manager", id: "ai_isa" } }, c as any, deps)
    check("F5 ACTIVE → WAITING records who is waited on (the transition reason)", hold.ok && currentWorkingContext(c.tables.missions[0] as MissionRow)?.waiting_on?.what === "seller travelling until Monday")
    const back = await transitionMission({ brokerageId: T1, missionId: M1, to: "ACTIVE", reason: "seller back", actor: { type: "manager", id: "ai_isa" } }, c as any, deps)
    check("F6 WAITING → ACTIVE clears waiting_on (open requests kept)", back.ok && currentWorkingContext(c.tables.missions[0] as MissionRow)?.waiting_on === null && currentWorkingContext(c.tables.missions[0] as MissionRow)?.open_requests?.length === 1)
    const prog = await recordMissionProgress({ brokerageId: T1, missionId: M1, progress: { showings: 2 } }, c as any, deps)
    check("F7 progress revises objective_now with the still-unmet criteria", prog.ok && (currentWorkingContext(c.tables.missions[0] as MissionRow)?.objective_now ?? "").includes("listing_signed >= 1"))
  }

  // ─── G. census: the compiler re-queries none of the survivors' tables ───────────────────────
  console.log("\nG. census — no slice re-queries a table its reader already reads")
  {
    const compiler = blankStrings(src("lib/kernel/mission-context.ts"))
    const raw = src("lib/kernel/mission-context.ts")
    const tablesOf = (s: string) => [...s.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1])
    const named = new Set(tablesOf(raw))
    // The survivors' tables (each reader's own `.from(` set, read from THEIR stripped source — never a hand list).
    const survivorFiles = ["lib/ai-isa/lead-action-plan.ts", "lib/kernel/conversation-memory.ts", "lib/kernel/person-identity.ts", "lib/lead-assignment/capacity-pick.ts", "lib/kernel/relationship-graph.ts", "lib/kernel/tenant-policy.ts", "lib/managers/autonomy-gate.ts"]
    const survivorTables = new Set(survivorFiles.flatMap((f) => tablesOf(src(f))))
    // The compiler's OWN reads: the contact row (once — engage-contact and the concierge no longer read it), the
    // listing, the fatigue score row, the two evidence ledgers, the signal channel and the cost ledger.
    const own = new Set(["contacts", "listings", "buyer_fatigue_scores", "mission_events", "lifecycle_events", "manager_signals", "ai_tool_usage"])
    const overlap = [...named].filter((t) => survivorTables.has(t) && !own.has(t))
    check(`G1 compiler tables ⊆ its own set — none of the ${survivorTables.size} survivor tables re-queried (overlap: ${overlap.join(",") || "none"})`, overlap.length === 0 && [...named].every((t) => own.has(t)))
    check("G2 `contacts` is read by the compiler ONCE (the row every consumer shares)", tablesOf(raw).filter((t) => t === "contacts").length === 1)
    check("G3 positive control: a fixture re-querying `activities` is caught", tablesOf('svc.from("activities").select("x")').some((t) => survivorTables.has(t)) && survivorTables.has("activities"))
    check("G4 the stripped source names every survivor reader", ["loadContactMemoryForPrompt", "loadContactNbaContext", "loadBrandPlaybookContext", "resolvePolicyRef", "personForContact", "capacityFor", "resolveAgentAuthorityLevel", "selectToolsForPersona", "getMission", "currentWorkingContext", "activeMissionsFor", "pendingDelegationsFor"].every((n) => compiler.includes(n)))
    check("G5 memory is handed INTO the NBA reader (preloaded.memory) and the survivor honours it", compiler.includes("preloaded: { memory }") && src("lib/ai-isa/lead-action-plan.ts").includes("input.preloaded"))
    check("G6 the compiler never imports server-only (the proof drives it in memory)", !compiler.includes('"server-only"'))
  }

  // ─── H. wiring + registration ───────────────────────────────────────────────────────────────
  console.log("\nH. wiring + registration")
  {
    const engage = src("app/actions/ai-isa/engage-contact.ts")
    check("H1 engage-contact compiles the context when a mission is in play and consumes its person / opportunity / memory / voice slices", engage.includes("missionInPlayFor") && engage.includes("compileManagerContext") && engage.includes("compiled.context.person.data?.row") && engage.includes("compiled.context.opportunity.data") && engage.includes("preloaded: { memory: compiled.context.memory.data }") && engage.includes("preloadedVoice ?? await loadBrandVoicePrompt"))
    check("H2 engage-contact reads the SAME contact columns the compiler reads (one column list)", engage.includes("CONTACT_CONTEXT_COLUMNS") && !/select\(\s*`id, first_name, last_name, email, phone,/.test(engage) && CONTACT_CONTEXT_COLUMNS.includes("qualification_summary"))
    const concierge = src("lib/agents/listing-concierge.ts")
    check("H3 the listing concierge compiles the context and takes contact + listing from it; the section rides the kickoff", concierge.includes("compileManagerContext") && concierge.includes("compiled.context.person.data?.row") && concierge.includes("compiled.context.property.data") && concierge.includes("compiled.section"))
    const inbound = src("app/actions/ai-isa/handle-inbound-email.ts")
    check("H4 the AI tool mount receives available tools from the context", inbound.includes("mountToolsFromContext(compiled.context, toolRegistry)"))
    const missions = src("lib/kernel/missions.ts")
    check("H5 updateMissionWorkingContext is wired to transitions and progress (the one writer, ≥ 3 call sites)", (missions.match(/updateMissionWorkingContext\(/g) ?? []).length >= 4 && missions.includes("export async function updateMissionWorkingContext"))
    const dom = MAINTENANCE_DOMAINS.shared_working_context
    check("H6 MAINTENANCE_DOMAINS.shared_working_context — owner + co-owners named in the prose", !!dom && dom.manager in MANAGERS && dom.proof === "test:mission-context" && (dom.coOwners ?? []).length === 2 && (dom.coOwners ?? []).every((k) => dom.what.includes(k)))
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    check("H7 package.json registers the proof after test:scrapers", pkg.scripts["test:mission-context"] === "tsx scripts/mission-context-guard.ts" && /test:scrapers(\s*&&\s*npm run test:[a-z-]+)*\s*&&\s*npm run test:mission-context(\s|&|$)/.test(pkg.scripts.guard))
    const { readdirSync } = await import("node:fs")
    check("H8 no migration — the working context rides missions.evidence (no m714 file; no `working_context` column named by a writer)", !readdirSync("supabase/migrations").some((f) => f.startsWith("m714")) && !/update\(\{[^}]*working_context/.test(missions))
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed${fails.length ? `\n  failed: ${fails.join("\n          ")}` : ""}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
