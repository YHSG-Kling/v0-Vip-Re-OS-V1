#!/usr/bin/env tsx
/**
 * scripts/reactor-reaction-decisions-guard.ts — `npm run test:reactor-reaction-decisions` (wave 155, lane 155R20; arbitration G04).
 *
 * THE KERNEL REACTION DECIDES, AND LEAVES ONE RECEIPT, AT THE ONE PLACE IT FANS OUT. Every typed kernel event passes
 * lib/kernel/notification-engine.ts processKernelEvent (emitKernelEvent, the lifecycle logger and ~20 direct callers): the staff
 * bell, then the agentic reactor. 25 events whose reaction wrote / sent with no decision and no evidence of their own (the census
 * had credited them with the reactor's receipts; that credit was withdrawn by lane 155R16) are closed by the SURVIVOR pattern of
 * lane 155R17: the EXISTING autonomy gate (lib/managers/autonomy-gate.ts autonomyDecision over the platform halt and the per-tenant
 * pause) asked before the reaction, and ONE withActionLedger receipt `kernel.reaction.<event>` around it.
 *
 *   A  STATIC (stripped source, each rule with a positive control): every one of the 25 events has its consumer site in the gated
 *      fan-out; the decision precedes the receipt and the reactor; a held decision returns before dispatchKernelEvent; the action's
 *      third segment is the event; no model is called there; processKernelEvent gained no optional gate / ledger parameter (lesson 5).
 *   B  DRIVEN (SIMULATED — in-memory PostgREST via scripts/canaries/_harness.ts; the reactor is a counting stub; fetch refused and
 *      counted): per event family — the reaction asks the gate and leaves ONE receipt; a halted tenant (and a halted platform) gets
 *      NO reactor dispatch and ONE `skipped / autonomy_held` row; a refusing ledger changes nothing; a replay of the SAME lifecycle
 *      event adds nothing; with no lifecycle event there is no key (two calls → two receipts, lesson 6).
 *   C  ROUND TRIPS — counted `.from()` calls per table, ledger present / absent, gate cache cold / warm.
 *
 * RED AT 76fa3d53: part A's gate / receipt / order rules fail (no autonomyDecision, no withActionLedger in the fan-out); part B writes
 * no `kernel.reaction.*` receipt and a paused tenant's event still reaches the reactor.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings, blankComments } from "./strip-comments"
import { stubModule, setSvc, canaryClient } from "./canaries/_harness"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

/** The 25 G04 events this lane closed, by family (the family's FIRST event is its representative for the halt / ledger / replay canaries). */
const FAMILIES: Record<string, { entityType: string; events: string[] }> = {
  deal: { entityType: "transaction", events: ["offer_received", "contract_signed", "deal_closed", "inspection_due", "financing_due", "appraisal_due", "walkthrough_due", "cd_due", "cd_received"] },
  task: { entityType: "task", events: ["task_assigned", "task_overdue"] },
  contact: { entityType: "contact", events: ["message_from_contact", "compliance_violation"] },
  listing: { entityType: "listing_stage_machine", events: ["listing_media_scheduled", "listing_repair_required", "listing_repair_completed", "listing_repair_failed", "listing_coming_soon_assets_prepared", "listing_drip_completed", "listing_mls_submitted_to_admin", "listing_open_house_completed", "listing_showing_completed"] },
  vendor: { entityType: "vendor_booking", events: ["vendor_booking_created", "vendor_booking_declined", "vendor_booking_completed"] },
}
const ALL_EVENTS = Object.values(FAMILIES).flatMap((f) => f.events)
const NE = "lib/kernel/notification-engine.ts"

/** PURE — the body of a top-level function in comment- and string-blanked source. */
function bodyOf(code: string, fn: string): string {
  const at = code.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${fn}\\b`)); if (at < 0) return ""
  const next = code.slice(at + 10).search(/\n(?:export\s+)?(?:async\s+)?function\s|\n(?:export\s+)?const\s|\ninterface\s/)
  return code.slice(at, next < 0 ? code.length : at + 10 + next)
}
/** PURE — the fan-out rule: the decision is asked, then ONE receipt wraps the reaction; a held decision returns before the reactor. */
function fanOutRule(code: string): { decides: boolean; receiptAfterDecision: boolean; heldBeforeReactor: boolean } {
  const pke = bodyOf(code, "processKernelEvent"), react = bodyOf(code, "reactToKernelEvent")
  const d = pke.search(/\bautonomyDecision\s*\(/), r = pke.search(/\bwithActionLedger\s*</), call = pke.search(/\breactToKernelEvent\s*\(/)
  const held = react.search(/if\s*\(\s*!\s*reactorAllowed\s*\)\s*return\b/), disp = react.search(/\bdispatchKernelEvent\s*\(/)
  return { decides: d >= 0, receiptAfterDecision: d >= 0 && r > d && call > d, heldBeforeReactor: held >= 0 && disp > held }
}
const MODEL_RE = /\b(?:generateAIResponse|generateText|streamText|generateObject|generatePersonaCopy|runPipelineSimple|anthropic\.messages|callModel)\s*\(/

function partA(KernelEvent: Record<string, string>): void {
  console.log("\nPART A — static (stripped source)")
  const raw = src(NE)
  const code = blankStrings(stripComments(raw))
  const keyOf = new Map(Object.entries(KernelEvent).map(([k, v]) => [v, k]))
  const missingSite = ALL_EVENTS.filter((e) => { const k = keyOf.get(e); return !k || !new RegExp(`\\[\\s*KernelEvent\\.${k}\\s*\\]\\s*:`).test(code) })
  check(`A1 every one of the ${ALL_EVENTS.length} events has its consumer site in the gated fan-out (${NE})`, missingSite.length === 0, missingSite.join(", "))
  check("A1 CONTROL: an event the file does not name is not found (the finder is not vacuous)", !new RegExp(`\\[\\s*KernelEvent\\.__NO_SUCH__\\s*\\]\\s*:`).test(code))
  const rule = fanOutRule(code)
  check("A2 processKernelEvent asks the EXISTING autonomy gate (autonomyDecision over loadPlatformHalt + loadTenantAutonomyHalt)", rule.decides && /\bloadPlatformHalt\s*\(/.test(bodyOf(code, "processKernelEvent")) && /\bloadTenantAutonomyHalt\s*\(/.test(bodyOf(code, "processKernelEvent")))
  check("A2 …then ONE withActionLedger receipt wraps the reaction (decision first)", rule.receiptAfterDecision)
  check("A2 …and a held decision returns BEFORE dispatchKernelEvent", rule.heldBeforeReactor)
  const neg = fanOutRule(`export async function processKernelEvent(p) { await withActionLedger<void>({}, react, {}); const d = autonomyDecision({}) }\nasync function reactToKernelEvent(s, p, reactorAllowed) { await dispatchKernelEvent(p); if (!reactorAllowed) return x }`)
  check("A2 POSITIVE CONTROL: a receipt opened before the decision, and a dispatch before the hold, are both caught", !neg.receiptAfterDecision && !neg.heldBeforeReactor)
  check("A2 CONTROL: a decision named only in a comment is not a decision", !fanOutRule(blankStrings(stripComments(`export async function processKernelEvent(p) { // autonomyDecision(\n }`))).decides)
  check("A3 the receipt's action is `kernel.reaction.<event>` (the event is the third segment)", /action:\s*`kernel\.reaction\.\$\{params\.event\}`/.test(blankComments(raw)))
  check("A4 no model is called in the fan-out (a routine permitted reaction stops at the first rung)", !MODEL_RE.test(code))
  check("A4 POSITIVE CONTROL: a planted model call is caught", MODEL_RE.test(`const x = await generateText({ prompt })`))
  const sig = (code.match(/export\s+async\s+function\s+processKernelEvent\s*\(\s*params\s*:\s*\{([\s\S]*?)\}\s*\)\s*:/) ?? [, ""])[1]
  const SNEAK = /\b(?:ledger|gate|decision|autonomy|receipt)\w*\??\s*:/i
  check("A5 lesson 5: processKernelEvent gained NO optional gate / ledger parameter (every reader of it is not made a writer)", sig.length > 0 && !SNEAK.test(sig), sig.length ? "" : "signature not found")
  check("A5 POSITIVE CONTROL: a planted `ledger?:` parameter is caught", SNEAK.test(` event: KernelEvent\n ledger?: LedgerClient\n`))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART B / C — seams installed before any module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const g = globalThis as unknown as { __R20: { dispatched: Array<Record<string, unknown>> }; fetch: unknown }
g.__R20 = { dispatched: [] }
stubModule("@/lib/kernel/event-reactor", "export const dispatchKernelEvent = async (p) => { globalThis.__R20.dispatched.push(p); return { sequencesEnrolled: false, portalUpdated: false } }")
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f")

type Rows = Record<string, Record<string, unknown>[]>
let n = 0
const id = (p: string) => `${p}${String(++n).padStart(4, "0")}-0000-4000-8000-0000000000f9`.slice(0, 36)
const U_AGENT = "a1550000-0000-4000-8000-0000000000f9", AG = "a2550000-0000-4000-8000-0000000000f9"
const ENTITY: Record<string, string> = { transaction: "d1550000-0000-4000-8000-0000000000f9", task: "d2550000-0000-4000-8000-0000000000f9", contact: "c1550000-0000-4000-8000-0000000000f9", listing_stage_machine: "d3550000-0000-4000-8000-0000000000f9", vendor_booking: "d4550000-0000-4000-8000-0000000000f9" }
function world(b: string, extra: Rows = {}): Rows {
  return {
    brokerages: [{ id: b, name: "R20 Realty" }],
    users: [{ id: U_AGENT, brokerage_id: b, user_type: "agent", email: "agent@wave140-canary.test" }],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: b }],
    transactions: [{ id: ENTITY.transaction, brokerage_id: b, agent_id: AG }],
    contacts: [{ id: ENTITY.contact, brokerage_id: b, agent_id: AG }],
    listings: [{ id: ENTITY.listing_stage_machine, brokerage_id: b, agent_id: AG }],
    notification_rules: [], notifications: [], agent_action_ledger: [], feature_access_overrides: [], platform_settings: [],
    ...extra,
  }
}
const haltRow = (b: string) => ({ brokerage_id: b, feature_key: "autonomy", user_id: null, team_id: null, override_type: "disable", disabled_reason: "paused by staff", created_at: new Date().toISOString() })
/** The in-memory client wrapped so every `.from(table)` is counted (the round-trip measurement). */
function counted(svc: ReturnType<typeof canaryClient>): { proxy: ReturnType<typeof canaryClient>; calls: string[] } {
  const calls: string[] = []
  const proxy = new Proxy(svc, { get(t, k, r) { if (k === "from") return (tbl: string) => { calls.push(tbl); return t.from(tbl) }; return Reflect.get(t, k, r) } })
  return { proxy, calls }
}
const ledgerRows = (svc: { tables: Rows }, event?: string) => (svc.tables.agent_action_ledger ?? []).filter((r) => String(r.action).startsWith("kernel.reaction.") && (!event || r.action === `kernel.reaction.${event}`))
const bells = (svc: { tables: Rows }) => (svc.tables.notifications ?? []).length

async function partB(): Promise<void> {
  console.log("\nPART B — driven through the REAL processKernelEvent (SIMULATED; the reactor is a counting stub; fetch refused and counted)")
  delete process.env.ANTHROPIC_API_KEY
  let fetches = 0
  g.fetch = async () => { fetches++; return new Response("refused in test", { status: 503 }) }
  const { processKernelEvent } = await import("../lib/kernel/notification-engine")
  const { __clearPlatformHaltCache } = await import("../lib/platform/platform-controls")
  const fire = (event: string, b: string, entityType: string, lifecycleEventId?: string) =>
    processKernelEvent({ event, brokerageId: b, entityType, entityId: ENTITY[entityType], lifecycleEventId } as never).then(() => null, (e: unknown) => String(e))

  // B1 — every one of the 25: the gate is asked, ONE receipt, the reactor dispatched once.
  const B1 = id("b155"); __clearPlatformHaltCache()
  const w1 = canaryClient(world(B1)); setSvc(w1)
  const bad: string[] = []
  for (const [fam, f] of Object.entries(FAMILIES)) for (const e of f.events) {
    g.__R20.dispatched.length = 0
    const threw = await fire(e, B1, f.entityType)
    const rows = ledgerRows(w1, e)
    const r = rows[0] ?? {}
    const okRow = rows.length === 1 && r.status === "executed" && r.outcome === "reacted" && r.actor_manager_key === "data_steward" && r.risk_class === "COMMUNICATION" && r.brokerage_id === B1 && r.subject_id === ENTITY[f.entityType] && !r.idempotency_key
    if (threw || !okRow || g.__R20.dispatched.length !== 1) bad.push(`${fam}/${e}: threw=${threw} rows=${rows.length} ${JSON.stringify([r.status, r.outcome, r.actor_manager_key, r.risk_class])} dispatched=${g.__R20.dispatched.length}`)
  }
  check(`B1 each of the ${ALL_EVENTS.length} events: ONE receipt kernel.reaction.<event> (data_steward, COMMUNICATION, the event's tenant + subject, executed / reacted, no key) and ONE reactor dispatch`, bad.length === 0, bad.join("\n      "))
  const dealBell = ledgerRows(w1, "inspection_due")[0]?.detail as Record<string, unknown> | undefined
  check("B1 the receipt names what the reaction did (detail.notified, detail.reactor, detail.autonomy)", !!dealBell && typeof dealBell.notified === "number" && dealBell.reactor === "dispatched" && dealBell.autonomy === "allow", JSON.stringify(dealBell))

  // B2 — a PAUSED tenant: no reactor dispatch, ONE refusal row per event (each family's representative).
  for (const [fam, f] of Object.entries(FAMILIES)) {
    const BH = id("b355"); const e = f.events[0]
    const w = canaryClient(world(BH, { feature_access_overrides: [haltRow(BH)] })); setSvc(w)
    g.__R20.dispatched.length = 0
    await fire(e, BH, f.entityType)
    const rows = ledgerRows(w, e)
    check(`B2 ${fam}/${e}: a tenant paused by platform staff gets NO reactor dispatch and ONE skipped / autonomy_held row`, g.__R20.dispatched.length === 0 && rows.length === 1 && rows[0].status === "skipped" && rows[0].outcome === "autonomy_held" && /paused by staff/.test(String(rows[0].error ?? "")), JSON.stringify({ dispatched: g.__R20.dispatched.length, rows: rows.map((r) => [r.status, r.outcome, r.error]) }))
  }
  // B2b — the bell under a hold (owner decision 1, default: the tenant's own staff are still told; the AUTONOMOUS reaction is held).
  {
    const BA = id("ba55"), BH = id("b355")
    const wa = canaryClient(world(BA)); setSvc(wa); await fire("inspection_due", BA, "transaction")
    const wh = canaryClient(world(BH, { feature_access_overrides: [haltRow(BH)] })); setSvc(wh); await fire("inspection_due", BH, "transaction")
    check("B2b under a hold the staff bell still rings exactly as when allowed (the humans are the fallback), and the receipt records it", bells(wa) > 0 && bells(wh) === bells(wa) && (ledgerRows(wh)[0]?.detail as Record<string, unknown>)?.notified === bells(wh), `allowed ${bells(wa)} · held ${bells(wh)}`)
  }
  // B2c — the PLATFORM halt (emergency mode) holds every tenant.
  {
    const BP = id("b655"); __clearPlatformHaltCache()
    const w = canaryClient(world(BP, { platform_settings: [{ id: id("a555"), ai_enabled: true, emergency_mode: true, created_at: "2026-01-01T00:00:00Z" }] })); setSvc(w)
    g.__R20.dispatched.length = 0
    await fire("offer_received", BP, "transaction")
    const rows = ledgerRows(w)
    check("B2c the platform's emergency mode holds the reaction for any tenant (NO dispatch, ONE skipped / autonomy_held row)", g.__R20.dispatched.length === 0 && rows.length === 1 && rows[0].outcome === "autonomy_held", JSON.stringify(rows.map((r) => [r.status, r.outcome])))
    __clearPlatformHaltCache()
  }
  // B3 — a REFUSING ledger changes nothing (with and without a lifecycle key).
  for (const [fam, f] of Object.entries(FAMILIES)) {
    const BR = id("b755"); const e = f.events[0]
    for (const lc of [undefined, id("e155")]) {
      const w = canaryClient(world(BR), { refuse: { agent_action_ledger: "permission denied for table agent_action_ledger" } }); setSvc(w)
      g.__R20.dispatched.length = 0
      const threw = await fire(e, BR, f.entityType, lc)
      check(`B3 ${fam}/${e}${lc ? " (keyed)" : ""}: a refusing ledger changes nothing — the reaction runs once, nothing is receipted, nothing throws`, g.__R20.dispatched.length === 1 && (w.tables.agent_action_ledger ?? []).length === 0 && !threw, JSON.stringify({ dispatched: g.__R20.dispatched.length, threw }))
    }
  }
  // B4 — a replay of the SAME lifecycle event adds nothing; with no lifecycle event there is no key (lesson 6).
  for (const [fam, f] of Object.entries(FAMILIES)) {
    const BK = id("b855"); const e = f.events[0]; const LC = id("e255")
    const w = canaryClient(world(BK)); setSvc(w)
    g.__R20.dispatched.length = 0
    await fire(e, BK, f.entityType, LC); const bells1 = bells(w)
    await fire(e, BK, f.entityType, LC)
    const rows = ledgerRows(w, e)
    check(`B4 ${fam}/${e}: replaying the SAME lifecycle event adds NOTHING (one receipt keyed by it, one dispatch, no second bell)`, rows.length === 1 && !!rows[0].idempotency_key && String(rows[0].idempotency_key).endsWith(LC) && g.__R20.dispatched.length === 1 && bells(w) === bells1, JSON.stringify({ rows: rows.length, key: rows[0]?.idempotency_key, dispatched: g.__R20.dispatched.length, bells: [bells1, bells(w)] }))
  }
  {
    const BN = id("b955"); const w = canaryClient(world(BN)); setSvc(w)
    g.__R20.dispatched.length = 0
    await fire("task_assigned", BN, "task"); await fire("task_assigned", BN, "task")
    check("B4 CONTROL (lesson 6): with NO lifecycle event the receipt carries no key — two calls are two reactions and two receipts", ledgerRows(w, "task_assigned").length === 2 && g.__R20.dispatched.length === 2 && ledgerRows(w).every((r) => !r.idempotency_key))
  }
  check("SCOPE · zero provider calls across every canary (global fetch counted)", fetches === 0, `fetch calls: ${fetches}`)
}

async function partC(): Promise<string> {
  console.log("\nPART C — round trips per reaction (counted .from() calls; SIMULATED)")
  const { processKernelEvent } = await import("../lib/kernel/notification-engine")
  const { __clearPlatformHaltCache } = await import("../lib/platform/platform-controls")
  const GATE = new Set(["platform_settings", "feature_access_overrides"])
  const split = (calls: string[]) => ({ gate: calls.filter((t) => GATE.has(t)).length, ledger: calls.filter((t) => t === "agent_action_ledger").length, reaction: calls.filter((t) => !GATE.has(t) && t !== "agent_action_ledger").length })
  const run = async (b: string, svc: ReturnType<typeof canaryClient>, lc?: string) => {
    const c = counted(svc); setSvc(c.proxy)
    await processKernelEvent({ event: "inspection_due", brokerageId: b, entityType: "transaction", entityId: ENTITY.transaction, lifecycleEventId: lc } as never).catch(() => null)
    return split(c.calls)
  }
  const B = id("bc55"); __clearPlatformHaltCache()
  const cold = await run(B, canaryClient(world(B)))
  const warm = await run(B, canaryClient(world(B)))
  const BA = id("bd55")
  const absent = await run(BA, canaryClient(world(BA), { missingTables: ["agent_action_ledger"] }))
  const BK = id("be55"); const LC = id("e355"); const wk = canaryClient(world(BK))
  await run(BK, wk, LC); const replay = await run(BK, wk, LC)
  check(`C1 ledger PRESENT, gate cache WARM: exactly claim + settle added (${warm.ledger} ledger, ${warm.gate} gate); the reaction's own ${warm.reaction} unchanged`, warm.ledger === 2 && warm.gate === 0 && warm.reaction === cold.reaction, JSON.stringify(warm))
  check(`C2 gate cache COLD: the two halts cost ${cold.gate} reads (platform_settings + feature_access_overrides), cached 20 s per instance / per tenant`, cold.gate === 2, JSON.stringify(cold))
  check(`C3 ledger ABSENT (m687 not applied): ONE refused claim insert, no settle (${absent.ledger}), the reaction unchanged (${absent.reaction})`, absent.ledger === 1 && absent.reaction === cold.reaction, JSON.stringify(absent))
  check(`C4 a REPLAYED lifecycle event: claim (23505) + re-read of the winner (${replay.ledger}), ZERO reaction round trips (${replay.reaction})`, replay.ledger === 2 && replay.reaction === 0, JSON.stringify(replay))
  return `reaction ${cold.reaction} · +gate cold ${cold.gate} / warm ${warm.gate} · +ledger present ${warm.ledger} / absent ${absent.ledger} · replay ${replay.ledger} ledger + ${replay.reaction} reaction`
}

async function main(): Promise<void> {
  const { KernelEvent } = await import("../lib/kernel/events")
  partA(KernelEvent as unknown as Record<string, string>)
  await partB()
  const rt = await partC()
  console.log(`\nROUND TRIPS (inspection_due on a transaction with one agent): ${rt}`)
  console.log("\nBLIND SPOTS")
  console.log("  · The reactor itself is a counting stub here: what dispatchKernelEvent does once allowed is judged by its own guards (test:event-dispatch, test:ledger-receipts-tail).")
  console.log("  · RLS, triggers and the live CHECKs are not modelled. The gate caches are per process (20 s); a cold instance pays the two halt reads once per tenant.")
  console.log("  · A held reaction is not re-run when the halt lifts (the receipt names the lifecycle event; a replay of that event after the lift re-claims a skipped row and runs).")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ REACTOR_REACTION_DECISIONS_FAIL"); process.exit(1) }
  console.log("✅ REACTOR_REACTION_DECISIONS_PASS — every kernel reaction is decided by the existing halts and leaves one receipt at the one fan-out; a hold, a refusing ledger and a replay each behave")
}

main().catch((e) => { console.error(e); process.exit(1) })
