#!/usr/bin/env tsx
/**
 * scripts/orchestrator-dormant-events-guard.ts — `npm run test:orchestrator-dormant-events` (wave 155, lane 155R24; arbitration
 * G02 · G03 · G04).
 *
 * TEN ORCHESTRATOR CONSUMERS WAITED FOR EVENTS NOTHING EMITS; SIX REACTIONS ACTED WITH NO DECISION OR NO RECEIPT.
 *   A  RETIRED DUPLICATES (CLAUDE.md §1 case 1 — stripped source, each rule with a positive control): eight dotted events whose
 *      moment the kernel bus already reacts to are gone from lib/orchestrator/internal.ts (no EVENT_HANDLERS key, no `case`),
 *      their cores are gone from the handler modules and called nowhere, and EACH TOMBSTONE NAMES A LIVE SURVIVOR LINE: every
 *      `path:line` the tombstone carries resolves to CODE (not a comment) and one of them carries the survivor's token.
 *   B  OWNER-HELD, DORMANT (case 3): transaction.contingency_cleared and transaction.closing_soon are kept (never deleted without
 *      a survivor) and STILL have no emitter anywhere (fixed-string sweep of app/ lib/ supabase/ — comments stripped, so a
 *      tombstone is not an emitter). The day one appears this goes red: the owner question must be answered first.
 *   C  DECIDED AND RECEIPTED (SIMULATED — in-memory PostgREST via scripts/canaries/_harness.ts; the render and the proposal are
 *      counted stubs; the model module is a stub that fails if called; fetch refused and counted): journey.stage_completed /
 *      all_tasks_done, video.script_approved, agent.delegated_to_ai and the TRANSACTION_CLOSED award each leave ONE receipt; a
 *      tenant paused by platform staff and a platform in emergency mode HOLD the act and record `skipped / autonomy_held`; the
 *      agent's bell still rings on a held render. client_education_delivered (inside the reactor, whose producer graph cannot be
 *      stubbed whole) is proven by its ORDER rule on stripped source, with a control.
 *
 * RED AT 15d212bf: part A (all eight keys, cases and cores are live; no 155R24 tombstone), and part C (no journey / render /
 * delegation / close-award receipt, a paused tenant's message posts, its render is commissioned and its close is awarded).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankComments } from "./strip-comments"
import { stubModule, setSvc, canaryClient } from "./canaries/_harness"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const ORCH = "lib/orchestrator/internal.ts", LET = "lib/listing-lifecycle/lifecycle-event-tasks.ts"
const CREDIT = "lib/credit/credit-event-handlers.ts", VIDEO = "lib/video/video-event-reactions.ts"
interface Retired { event: string; konst: string; cores: Array<[string, string]>; tokens: string[] }
/** The eight case-1 retirements: the dotted event, its EVENT_TYPES constant, the cores only it reached, the survivor's tokens. */
const RETIRED: Retired[] = [
  { event: "listing.offer_received", konst: "LISTING_OFFER_RECEIVED", cores: [[LET, "offerReceivedTasks"]], tokens: ["afterInboundOfferRead", "KernelEvent.OFFER_RECEIVED"] },
  { event: "listing.live", konst: "LISTING_LIVE", cores: [[LET, "listingLiveTasks"], [ORCH, "handleListingLive"]], tokens: ["KernelEvent.LISTING_PUBLISHED", "mintTrackedQr"] },
  { event: "lead.created", konst: "LEAD_CREATED", cores: [[ORCH, "handleLeadCreated"]], tokens: ["KernelEvent.CONTACT_CREATED"] },
  { event: "credit.status_updated", konst: "CREDIT_STATUS_UPDATED", cores: [[CREDIT, "reactToCreditPartnerStatus"], [ORCH, "handleCreditStatusUpdated"]], tokens: ["triggerCreditFlowActions"] },
  { event: "credit.target_reached", konst: "CREDIT_TARGET_REACHED", cores: [[CREDIT, "reactToCreditTargetReached"]], tokens: ["triggerCreditFlowActions"] },
  { event: "transaction.close_approaching", konst: "TRANSACTION_CLOSE_APPROACHING", cores: [[LET, "closingApproachingTasks"]], tokens: ["walkthrough_unscheduled", "wire_instructions_missing", "KernelEvent.CD_DUE"] },
  { event: "video.published", konst: "VIDEO_PUBLISHED", cores: [[VIDEO, "reactToVideoPublished"]], tokens: ["\"ai_video_projects\"", "KernelEvent.SOCIAL_POST_PUBLISHED"] },
  { event: "video.high_engagement", konst: "VIDEO_HIGH_ENGAGEMENT", cores: [[VIDEO, "reactToVideoHighEngagement"]], tokens: ["KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED"] },
]
const HELD = [{ event: "transaction.contingency_cleared", konst: "TRANSACTION_CONTINGENCY_CLEARED" }, { event: "transaction.closing_soon", konst: "TRANSACTION_CLOSING_SOON" }]

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** PURE — a live EVENT_HANDLERS key (comments blanked, strings kept: the key IS a string). */
const liveKey = (raw: string, ev: string) => new RegExp(`^\\s*["']${reEsc(ev)}["']\\s*:`, "m").test(blankComments(raw))
/** PURE — a live `case EVENT_TYPES.X:` label. */
const liveCase = (raw: string, k: string) => new RegExp(`\\bcase\\s+EVENT_TYPES\\.${k}\\s*:`).test(stripComments(raw))
/** PURE — a live definition or call of a function name. */
const liveFn = (raw: string, fn: string) => new RegExp(`\\b${fn}\\s*\\(`).test(stripComments(raw))
/** PURE — the comment block (consecutive `//` lines) of the 155R24 tombstone that names `needle`. */
function tombstoneBlock(raw: string, needle: string): string {
  const lines = raw.split("\n")
  for (let at = 0; at < lines.length; at++) {
    if (!/\/\/\s*TOMBSTONE \(wave 155, lane 155R24/.test(lines[at])) continue
    const out = [lines[at]]
    for (let i = at + 1; i < lines.length && /^\s*\/\//.test(lines[i]) && !/TOMBSTONE \(/.test(lines[i]); i++) out.push(lines[i])
    const block = out.join("\n")
    if (block.includes(needle)) return block
  }
  return ""
}
/** PURE over the tree — every `path:line` in a block: does it resolve to CODE, and does any window carry a token? */
function anchorsOf(block: string, tokens: string[], read: (p: string) => string | null): { anchors: string[]; dead: string[]; tokenHit: boolean } {
  const anchors = [...new Set([...block.matchAll(/\b((?:app|lib)\/[\w./[\]-]+\.tsx?):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`))]
  const dead: string[] = []; let tokenHit = false
  for (const a of anchors) {
    const [p, n] = [a.slice(0, a.lastIndexOf(":")), Number(a.slice(a.lastIndexOf(":") + 1))]
    const text = read(p); if (text === null) { dead.push(`${a} (no such file)`); continue }
    const code = stripComments(text).split("\n")
    if (!(code[n - 1] ?? "").trim()) { dead.push(`${a} (not code)`); continue }
    const win = code.slice(Math.max(0, n - 4), n + 3).join("\n")
    if (tokens.some((t) => win.includes(t))) tokenHit = true
  }
  return { anchors, dead, tokenHit }
}
const readOrNull = (p: string) => (existsSync(join(ROOT, p)) ? src(p) : null)

function partA(): void {
  console.log("\nPART A — the eight retired duplicates (stripped source; each tombstone names a live survivor line)")
  const orch = src(ORCH)
  for (const r of RETIRED) {
    check(`A1 ${r.event}: no EVENT_HANDLERS key and no \`case EVENT_TYPES.${r.konst}:\` in ${ORCH}`, !liveKey(orch, r.event) && !liveCase(orch, r.konst))
    const liveCores = r.cores.filter(([f, fn]) => liveFn(src(f), fn))
    check(`A2 ${r.event}: its core(s) ${r.cores.map((c) => c[1]).join(", ")} are gone from their module(s)`, liveCores.length === 0, liveCores.map((c) => c.join("#")).join(", "))
    const block = tombstoneBlock(orch, `"${r.event}"`) || tombstoneBlock(orch, `EVENT_TYPES.${r.konst}`)
    const a = anchorsOf(block, r.tokens, readOrNull)
    check(`A3 ${r.event}: the 155R24 tombstone names survivor line(s) that resolve to live code carrying ${r.tokens.join(" | ")}`, block.length > 0 && a.anchors.length > 0 && a.dead.length === 0 && a.tokenHit, `anchors ${a.anchors.join(", ") || "none"}${a.dead.length ? ` · dead ${a.dead.join(", ")}` : ""}${a.tokenHit ? "" : " · no survivor token near any anchor"}`)
  }
  // A4 — no caller anywhere still names a retired core (stripped source of app/ lib/).
  const callers = new Map<string, string[]>()
  for (const f of walk(["app", "lib"], /\.(ts|tsx)$/)) {
    const code = stripComments(src(f))
    for (const r of RETIRED) for (const [, fn] of r.cores) if (new RegExp(`\\b${fn}\\b`).test(code)) callers.set(fn, [...(callers.get(fn) ?? []), f])
  }
  check("A4 no live reference to any retired core remains in app/ or lib/ (comments stripped — a tombstone is not a call site)", callers.size === 0, [...callers].map(([k, v]) => `${k}: ${v.join(", ")}`).join(" · "))
  // CONTROLS — each finder able to fail.
  check("A CONTROL: a planted registry key and a planted case label are found", liveKey(`const H = {\n  "listing.offer_received": async (e) => x,\n}`, "listing.offer_received") && liveCase("switch (t) { case EVENT_TYPES.LISTING_LIVE: break }", "LISTING_LIVE"))
  check("A CONTROL: the same key / case / core inside a COMMENT is not live (a tombstone is not a consumer)", !liveKey(`// "listing.offer_received": async (e) => x`, "listing.offer_received") && !liveCase("// case EVENT_TYPES.LISTING_LIVE:", "LISTING_LIVE") && !liveFn("// offerReceivedTasks(svc)", "offerReceivedTasks"))
  const fake = anchorsOf(`// TOMBSTONE (wave 155, lane 155R24): x. SURVIVOR: ${ORCH}:1`, ["orchestrateEvent"], readOrNull)
  check("A CONTROL: a tombstone anchored on a COMMENT line (internal.ts:1, the header) is a dead anchor", fake.dead.length === 1 && !fake.tokenHit, JSON.stringify(fake))
  const wrong = anchorsOf(`// SURVIVOR: lib/kernel/event-reactor.ts:1`, ["KernelEvent.CONTACT_CREATED"], readOrNull)
  check("A CONTROL: an anchor whose window lacks the survivor token is not a survivor", !wrong.tokenHit)
}

function walk(dirs: string[], re: RegExp): string[] {
  const out: string[] = []
  const go = (d: string) => {
    for (const n of readdirSync(join(ROOT, d))) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = `${d}/${n}`; const st = statSync(join(ROOT, p))
      if (st.isDirectory()) go(p); else if (re.test(n)) out.push(p)
    }
  }
  for (const d of dirs) if (existsSync(join(ROOT, d))) go(d)
  return out
}
/** PURE — the emitters of a dotted event in a {file: text} map: the literal in live code (comments blanked), or EVENT_TYPES.X. */
function emittersIn(files: Record<string, string>, ev: string, konst: string): string[] {
  const lit = new RegExp(`["'\`]${reEsc(ev)}["'\`]`), named = new RegExp(`\\bEVENT_TYPES\\.${konst}\\b`)
  return Object.entries(files).filter(([f, t]) => {
    if (f === ORCH || f === "lib/events/types.ts") return false
    const code = f.endsWith(".sql") ? t.replace(/--.*$/gm, "") : blankComments(t)
    return lit.test(code) || named.test(code)
  }).map(([f]) => f)
}

function partB(): void {
  console.log("\nPART B — owner-held, dormant (case 3): kept, and still no emitter anywhere")
  const orch = src(ORCH)
  const files: Record<string, string> = {}
  for (const f of [...walk(["app", "lib"], /\.(ts|tsx)$/), ...walk(["supabase"], /\.sql$/)]) files[f] = src(f)
  if (existsSync(join(ROOT, "vercel.json"))) files["vercel.json"] = src("vercel.json")
  for (const h of HELD) {
    check(`B1 ${h.event}: kept dormant (its EVENT_HANDLERS entry and case remain — nothing deleted without a survivor)`, liveKey(orch, h.event) && liveCase(orch, h.konst))
    const em = emittersIn(files, h.event, h.konst)
    check(`B2 ${h.event}: still NO emitter in app/ lib/ supabase/ vercel.json (an emitter would wake an unruled reaction — answer the owner question first)`, em.length === 0, em.join(", "))
  }
  check(`B CONTROL: the sweep covered the tree (${Object.keys(files).length} files, SQL included)`, Object.keys(files).length > 1000 && Object.keys(files).some((f) => f.endsWith(".sql")))
  check("B CONTROL: a planted emitter is found; the same literal in a comment is not", emittersIn({ "lib/x.ts": `await emitEvent({ event_type: "transaction.closing_soon" })` }, "transaction.closing_soon", "TRANSACTION_CLOSING_SOON").length === 1
    && emittersIn({ "lib/x.ts": `// "transaction.closing_soon" was here` }, "transaction.closing_soon", "TRANSACTION_CLOSING_SOON").length === 0
    && emittersIn({ "lib/y.ts": `emitEvent({ event_type: EVENT_TYPES.TRANSACTION_CLOSING_SOON })` }, "transaction.closing_soon", "TRANSACTION_CLOSING_SOON").length === 1)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART C — seams installed BEFORE any module is imported.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const g = globalThis as unknown as { __R24: { renders: number; proposals: number; model: number }; fetch: unknown }
g.__R24 = { renders: 0, proposals: 0, model: 0 }
stubModule("./render-from-approval", "export const renderApprovedVideoScript = async () => { globalThis.__R24.renders++; return { ok: true, status: 'staged', reason: 'staged', warnings: [], videoProjectId: 'f1550000-0000-4000-8000-0000000000f9', agentUserId: null, host: 'avatar' } }")
stubModule("@/lib/agents/agent-client-messages", "export const proposeClientMessage = async () => { globalThis.__R24.proposals++; return { ok: true, id: 'f2550000-0000-4000-8000-0000000000f9' } }")
stubModule("@/lib/ai/models", "export const generateTextRouted = async () => { globalThis.__R24.model++; throw new Error('the model must not be called in this guard') }")
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f")

type Rows = Record<string, Record<string, unknown>[]>
let n = 0
const id = (p: string) => `${p}${String(++n).padStart(4, "0")}-0000-4000-8000-0000000000f9`.slice(0, 36)
const U = "a1240000-0000-4000-8000-0000000000f9", AG = "a2240000-0000-4000-8000-0000000000f9", C = "c1240000-0000-4000-8000-0000000000f9"
const S = "d1240000-0000-4000-8000-0000000000f9", P = "d2240000-0000-4000-8000-0000000000f9", T = "d3240000-0000-4000-8000-0000000000f9"
type Halt = "none" | "tenant" | "platform"
function world(b: string, halt: Halt): Rows {
  return {
    brokerages: [{ id: b, name: "R24 Realty" }],
    users: [{ id: U, brokerage_id: b, user_type: "agent", email: "agent@wave140-canary.test" }],
    agents: [{ id: AG, user_id: U, brokerage_id: b }],
    contacts: [{ id: C, brokerage_id: b, agent_id: AG, first_name: "Pat", last_name: "Buyer", contact_type: "buyer" }],
    video_scripts_library: [{ id: S, brokerage_id: b, approval_status: "approved" }],
    portal_event_stream: [{ id: P, brokerage_id: b, contact_id: C, transaction_id: null, event_type: "inspection_scheduled", agent_copy: "Inspection booked", customer_copy: "Your inspection is booked", agent_action_label: "Reply to the client" }],
    transactions: [{ id: T, brokerage_id: b, agent_id: AG, status: "closed", buyer_contact_id: C }],
    client_portal_messages: [], notifications: [], agent_action_ledger: [],
    feature_access_overrides: halt === "tenant" ? [{ brokerage_id: b, feature_key: "autonomy", user_id: null, team_id: null, override_type: "disable", disabled_reason: "paused by staff", created_at: new Date().toISOString() }] : [],
    platform_settings: halt === "platform" ? [{ id: id("a524"), ai_enabled: true, emergency_mode: true, created_at: "2026-01-01T00:00:00Z" }] : [],
  }
}
const ledger = (w: { tables: Rows }, action: string) => (w.tables.agent_action_ledger ?? []).filter((r) => r.action === action)
function counted(w: ReturnType<typeof canaryClient>): { proxy: ReturnType<typeof canaryClient>; calls: string[]; rpcs: string[] } {
  const calls: string[] = [], rpcs: string[] = []
  const proxy = new Proxy(w, { get(t, k, r) {
    if (k === "from") return (tbl: string) => { calls.push(tbl); return t.from(tbl) }
    if (k === "rpc") return (fn: string, a?: unknown) => { rpcs.push(fn); return (t as unknown as { rpc: (f: string, x?: unknown) => unknown }).rpc(fn, a) }
    return Reflect.get(t, k, r)
  } })
  return { proxy, calls, rpcs }
}
const GATE_OR_LEDGER = new Set(["platform_settings", "feature_access_overrides", "agent_action_ledger"])

async function partC(): Promise<void> {
  console.log("\nPART C — decided and receipted (SIMULATED; render / proposal stubs counted; the model stub fails if called; fetch counted)")
  let fetches = 0
  g.fetch = async () => { fetches++; return new Response("refused in test", { status: 503 }) }
  const { __clearPlatformHaltCache } = await import("../lib/platform/platform-controls")
  const journey = await import("../lib/portal/journey-event-handlers")
  const video = await import("../lib/video/video-event-reactions")
  const deleg = await import("../lib/portal-stream/ai-delegation-reaction")
  const awards = await import("../lib/gamification/lifecycle-awards")
  const fresh = (halt: Halt) => { __clearPlatformHaltCache(); const b = id(halt === "none" ? "b124" : halt === "tenant" ? "b224" : "b324"); const w = canaryClient(world(b, halt)); setSvc(w); return { b, w } }
  const heldOk = (rows: Record<string, unknown>[], why: RegExp) => rows.length === 1 && rows[0].status === "skipped" && rows[0].outcome === "autonomy_held" && why.test(String(rows[0].error ?? ""))

  // C1/C2 — the journey client messages.
  for (const [kind, fn] of [["stage_completed", journey.reactToJourneyStageCompleted], ["all_tasks_done", journey.reactToJourneyAllTasksDone]] as const) {
    const action = `portal.journey.${kind}`
    const a = fresh("none"); const ra = await fn(a.w, a.b, { contact_id: C, stage_name: "Inspection" })
    const rowsA = ledger(a.w, action)
    check(`C ${kind}: allowed → ONE message posted and ONE receipt ${action} (data_steward, COMMUNICATION, executed / message_posted, the contact)`, ra.success && ra.written === 1 && (a.w.tables.client_portal_messages ?? []).length === 1 && rowsA.length === 1 && rowsA[0].status === "executed" && rowsA[0].outcome === "message_posted" && rowsA[0].actor_manager_key === "data_steward" && rowsA[0].risk_class === "COMMUNICATION" && rowsA[0].subject_id === C, JSON.stringify({ ra, msgs: (a.w.tables.client_portal_messages ?? []).length, rows: rowsA.map((r) => [r.status, r.outcome, r.actor_manager_key]) }))
    for (const halt of ["tenant", "platform"] as const) {
      const h = fresh(halt); const rh = await fn(h.w, h.b, { contact_id: C, stage_name: "Inspection" })
      check(`C ${kind}: a ${halt === "tenant" ? "tenant paused by staff" : "platform in emergency mode"} → NOTHING posted, ONE skipped / autonomy_held row, the reaction names the hold (not a failure)`, rh.success && rh.written === 0 && /held/.test(rh.error ?? "") && (h.w.tables.client_portal_messages ?? []).length === 0 && heldOk(ledger(h.w, action), halt === "tenant" ? /paused by staff/ : /./), JSON.stringify({ rh, rows: ledger(h.w, action).map((r) => [r.status, r.outcome, r.error]) }))
    }
  }
  __clearPlatformHaltCache()

  // C3 — video.script_approved: the render commission.
  {
    const a = fresh("none"); g.__R24.renders = 0
    const ra = await video.reactToVideoScriptApproved(a.w, a.b, { script_id: S, user_id: U }, U)
    const rows = ledger(a.w, "video.script.render_commission")
    check("C3 video.script_approved: allowed → ONE commission and ONE receipt video.script.render_commission (asset_manager, executed / render_commissioned)", ra.success && g.__R24.renders === 1 && rows.length === 1 && rows[0].status === "executed" && rows[0].outcome === "render_commissioned" && rows[0].actor_manager_key === "asset_manager", JSON.stringify({ ra, renders: g.__R24.renders, rows: rows.map((r) => [r.status, r.outcome]) }))
    const h = fresh("tenant"); g.__R24.renders = 0
    const rh = await video.reactToVideoScriptApproved(h.w, h.b, { script_id: S, user_id: U }, U)
    const bell = (h.w.tables.notifications ?? []).find((x) => x.type === "video_script_approved")
    check("C3 video.script_approved: a paused tenant → NO commission, ONE skipped / autonomy_held row, and the agent's bell still rings with the reason", g.__R24.renders === 0 && heldOk(ledger(h.w, "video.script.render_commission"), /paused by staff/) && !!bell && /paused/.test(String(bell.body)) && rh.skipped.some((s) => /render held/.test(s)), JSON.stringify({ renders: g.__R24.renders, rows: ledger(h.w, "video.script.render_commission").map((r) => [r.status, r.outcome]), bell: bell?.title }))
    const u = fresh("none"); u.w.tables.video_scripts_library[0].approval_status = "pending_review"; g.__R24.renders = 0
    const ru = await video.reactToVideoScriptApproved(u.w, u.b, { script_id: S }, U)
    check("C3 CONTROL: an event claiming an approval the row does not carry is refused BEFORE the decision (no commission, no receipt)", !ru.success && g.__R24.renders === 0 && ledger(u.w, "video.script.render_commission").length === 0)
  }
  __clearPlatformHaltCache()

  // C4 — agent.delegated_to_ai: the receipt in front of the draft + proposal (the model is injected; the module stub must stay cold).
  {
    const a = fresh("none"); g.__R24.proposals = 0
    let drafts = 0
    const ra = await deleg.reactToAgentDelegatedToAi(a.w, a.b, { portal_event_stream_id: P }, { draft: async () => { drafts++; return "Your inspection is booked for Tuesday. Reply here with any questions." } })
    const rows = ledger(a.w, "portal.delegation.draft")
    check("C4 agent.delegated_to_ai: ONE draft, ONE gated proposal, ONE receipt portal.delegation.draft (campaign_orchestrator, executed / reply_proposed, the card)", ra.success && drafts === 1 && g.__R24.proposals === 1 && rows.length === 1 && rows[0].status === "executed" && rows[0].outcome === "reply_proposed" && rows[0].actor_manager_key === "campaign_orchestrator" && rows[0].subject_id === P, JSON.stringify({ ra, drafts, proposals: g.__R24.proposals, rows: rows.map((r) => [r.status, r.outcome]) }))
    const f = fresh("none"); g.__R24.proposals = 0
    const rf = await deleg.reactToAgentDelegatedToAi(f.w, f.b, { portal_event_stream_id: P }, { draft: async () => "  " })
    const rowsF = ledger(f.w, "portal.delegation.draft")
    check("C4 an empty draft proposes nothing and the receipt says why (failed / reply_not_proposed)", !rf.success && g.__R24.proposals === 0 && rowsF.length === 1 && rowsF[0].status === "failed" && rowsF[0].outcome === "reply_not_proposed")
    check("C4 the model module was never called (the draft seam is injected)", g.__R24.model === 0, `model calls ${g.__R24.model}`)
  }
  __clearPlatformHaltCache()

  // C5 — the TRANSACTION_CLOSED award.
  {
    const p = (b: string) => ({ event: "transaction_closed", brokerageId: b, entityType: "transaction", entityId: T, metadata: null, agentUserId: null })
    const a = fresh("none"); const ca = counted(a.w)
    const oa = await awards.awardLifecycleMilestones(ca.proxy as never, p(a.b) as never)
    check("C5 TRANSACTION_CLOSED allowed → no hold row, no `held` refusal, the award path runs (domain reads past the gate)", ledger(a.w, "gamification.close_award.hold").length === 0 && !oa.refused.some((r) => /TRANSACTION_CLOSED: held/.test(r)) && ca.rpcs.length > 0 && ca.calls.some((t) => !GATE_OR_LEDGER.has(t)), JSON.stringify({ refused: oa.refused.slice(0, 3), tables: [...new Set(ca.calls)] }))
    for (const halt of ["tenant", "platform"] as const) {
      const h = fresh(halt); const ch = counted(h.w)
      const oh = await awards.awardLifecycleMilestones(ch.proxy as never, p(h.b) as never)
      check(`C5 TRANSACTION_CLOSED under a ${halt} halt → NO award (no rpc, no domain read), ONE gamification.close_award.hold skipped / autonomy_held row, the hold in \`refused\``, oh.awarded.length === 0 && ch.rpcs.length === 0 && ch.calls.every((t) => GATE_OR_LEDGER.has(t)) && heldOk(ledger(h.w, "gamification.close_award.hold"), halt === "tenant" ? /paused by staff/ : /./) && oh.refused.some((r) => /TRANSACTION_CLOSED: held/.test(r)), JSON.stringify({ refused: oh.refused, rpcs: ch.rpcs, tables: [...new Set(ch.calls)] }))
    }
    const o = fresh("tenant"); const co = counted(o.w)
    await awards.awardLifecycleMilestones(co.proxy as never, { ...p(o.b), event: "showing_completed", entityType: "showing" } as never)
    check("C5 CONTROL: the hold is the TRANSACTION_CLOSED reaction's only — another award event under the same halt writes no close-award hold row", ledger(o.w, "gamification.close_award.hold").length === 0)
  }
  __clearPlatformHaltCache()
  check("SCOPE · zero provider calls across every canary (global fetch counted)", fetches === 0, `fetch calls: ${fetches}`)
}

/** PURE — the reactor's client_education_delivered order rule: decision, then the receipt, and the stamp refuses a hold first. */
function educationRule(code: string): boolean {
  const at = code.indexOf("params.event === KernelEvent.CLIENT_EDUCATION_DELIVERED"); if (at < 0) return false
  const block = code.slice(at, at + 4000)
  const d = block.search(/\bautonomyDecision\s*\(/), l = block.search(/\bwithActionLedger\s*</)
  // the stamp refuses a hold FIRST; runStamp may be DEFINED before the decision, but is never invoked or handed off before it
  const stamp = /const runStamp = async \(\): Promise<void> => \{\s*if \(!eduDecision\.allow\) (?:return;|\{[\s\S]{0,200}?\breturn\s*\};?)\s*r = await stampEducationDelivered\(/.test(block)
  const firstUse = block.search(/\brunStamp\s*(?:\(|,)/)
  return d >= 0 && l > d && stamp && firstUse > d && /outcome: "autonomy_held"/.test(block)
}
function partD(): void {
  console.log("\nPART D — client_education_delivered (the reactor branch; order rule on stripped source)")
  check("D1 the stamp's receipt is opened AFTER the autonomy decision, the stamp returns on a hold, and a hold settles skipped / autonomy_held", educationRule(stripComments(src("lib/kernel/event-reactor.ts"))))
  const ok = `if (params.event === KernelEvent.CLIENT_EDUCATION_DELIVERED) { const runStamp = async (): Promise<void> => { if (!eduDecision.allow) { r = { ok: false }; return }; r = await stampEducationDelivered(svc) }; const eduDecision = autonomyDecision({}); await withActionLedger<void>({}, runStamp, { settle: () => ({ outcome: "autonomy_held" }) }) }`
  check("D CONTROL: the rule accepts the correct shape (it is not vacuously false)", educationRule(ok))
  check("D CONTROL: a receipt opened before the decision fails the rule", !educationRule(ok.replace("const eduDecision = autonomyDecision({}); await withActionLedger<void>({}, runStamp,", "await withActionLedger<void>({}, runStamp, {}); const eduDecision = autonomyDecision({}); (")))
  check("D CONTROL: the stamp invoked before the decision fails the rule", !educationRule(ok.replace("const eduDecision = autonomyDecision({});", "await runStamp(); const eduDecision = autonomyDecision({});")))
  check("D CONTROL: a stamp that does not refuse a hold first fails the rule", !educationRule(ok.replace("if (!eduDecision.allow) { r = { ok: false }; return }; ", "")))
  check("D CONTROL: a decision named only in a comment is not a decision", !educationRule(stripComments(`if (params.event === KernelEvent.CLIENT_EDUCATION_DELIVERED) { // autonomyDecision(\n await withActionLedger<void>({}) }`)))
}

async function main(): Promise<void> {
  partA()
  partB()
  await partC()
  partD()
  console.log("\nBLIND SPOTS")
  console.log("  · RLS, triggers and live CHECKs are not modelled; the render and the client-message proposal are counted stubs (their own guards judge them).")
  console.log("  · client_education_delivered is proven by order on stripped source, not driven (its producer graph is imported by name across the tree).")
  console.log("  · A held act is not re-run when the halt lifts (the same default the kernel fan-out states — lane 155R20 owner decision 2).")
  console.log("  · Part B proves 'no emitter' in this repository only; a provider console or an external caller cannot post an orchestrator event (emitEvent is session-gated).")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { for (const f of failures) console.log(`  ✗ ${f}`); console.log("❌ ORCHESTRATOR_DORMANT_EVENTS_FAIL"); process.exit(1) }
  console.log("✅ ORCHESTRATOR_DORMANT_EVENTS_PASS — eight dormant duplicates retired onto live survivors, two held dormant with no emitter, six reactions decided and receipted")
}

main().catch((e) => { console.error(e); process.exit(1) })
