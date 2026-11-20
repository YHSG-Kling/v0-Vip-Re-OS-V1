#!/usr/bin/env tsx
/**
 * scripts/deal-desk-guard.ts — test:deal-desk
 *
 * ONE DEAL DESK. Who may WORK one deal (move its stage, complete or schedule a milestone, edit its details) is decided in ONE
 * place: lib/transactions/role-guard.ts decideDealDesk — the stage machine's own gate (lane 93A), generalised in wave 155.
 *
 * WHY THIS GUARD EXISTS. Two deal gates had drifted from that rule:
 *   · app/actions/transaction-milestones.ts took the tenant from the request BODY and proved the deal with a read on the caller's
 *     row-security client. Any seat that could READ the deal passed, and the transactions SELECT policies admit a vendor seat
 *     assigned to it — so an assigned lender / title / inspector seat could complete or reschedule that deal's milestones.
 *   · app/actions/transactions.ts requireTransactionActor admitted the agent on the deal or the whole tenant-admin roster: it
 *     refused the coordinator who normally enters title, escrow and deadline details, and admitted a team lead on every deal.
 *
 * §A  THE DECISION, DRIVEN — decideDealDesk against the in-memory client (scripts/in-memory-supabase.ts), one check per seat:
 *     brokerage tier (broker, compliance officer, coordinator), deal tier (an agent on any side; a team lead for the team they
 *     lead), and every refusal (an agent off the deal, another team's lead, vendor, contact, isa, no user_type, another tenant,
 *     a deal with no agent, a REFUSED read — fail closed).
 * §B  EVERY MILESTONE DOOR, DRIVEN — the exported actions of app/actions/transaction-milestones.ts are DERIVED from its source
 *     (comment-stripped, scripts/strip-comments.ts), never listed. For each door and each seat that must be refused: the call is
 *     refused, the database is not written (0 writes) and no milestone / event / lender-state seam is reached (0 calls). For
 *     each desk door and each seat that works the deal: the call succeeds and its writes carry the SESSION's tenant.
 *     Every refusal check here is RED on the code before this change when run with DEAL_DESK_ROOT=<a checkout of that code>.
 * §C  THE SOURCE RULES (comment-stripped): every exported milestone door reaches the desk — or one of the two narrower gates
 *     that are named with their reason — BEFORE any write or seam; the body's brokerageId is used only as a claim; the file
 *     calls no row-security client; requireTransactionActor asks the desk and carries no roster of its own; the stage gate
 *     words the same decision; the two role-only predicates stay retired. Each rule has a positive control.
 * §D  REGISTRATION — package key, guard-chain membership, MAINTENANCE_DOMAINS owner.
 *
 * BLIND SPOTS (published). The in-memory client has no row security, CHECKs or foreign keys — which is exactly why a gate
 * that leaned on row security shows up here. lib/teams/team-scope.ts leadsAgentsTeam is a counted fixture (it calls a
 * database function the fake cannot run); its own rule is proven by test:team-scope. §B drives the doors, not the screens.
 * The closing-question gates (lib/commission/closing-verification.ts mayAttestClosing) are a SEPARATE roster and are not
 * asserted here: they admit the coordinator ASSIGNED to the deal and a team lead tenant-wide.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.DEAL_DESK_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 320)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string, root = ROOT): string => { const p = join(root, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

const MILESTONES = "app/actions/transaction-milestones.ts"
const DEAL_ACTIONS = "app/actions/transactions.ts"
const ROLE_GUARD = "lib/transactions/role-guard.ts"

// ═══ fixture world ═════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000155`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_TC = u("a", 2), U_CO = u("a", 3), U_AGENT = u("a", 4), U_AGENT2 = u("a", 5), U_BUYSIDE = u("a", 6)
const U_LEAD = u("a", 7), U_LEAD2 = u("a", 8), U_VENDOR = u("a", 9), U_CONTACT = u("a", 10), U_ISA = u("a", 11), U_NOTYPE = u("a", 12)
const U_X = u("a", 20), U_XVENDOR = u("a", 21)
const AG_A = u("e", 4), AG_B = u("e", 5), AG_BUY = u("e", 6), AG_LEAD = u("e", 7), AG_LEAD2 = u("e", 8), AG_X = u("e", 20)
const TX1 = u("d", 1), TX_NOAGENT = u("d", 2), TX_X = u("d", 9)
const R1 = u("c", 1), VENDOR_ROW = u("f", 1), XVENDOR_ROW = u("f", 2)
/** The team fixture the counted team-scope seam answers from: who LEADS which agents' team. */
const LEADS: Record<string, string[]> = { [U_LEAD]: [AG_A], [U_LEAD2]: [AG_B] }

function world(): MemClient {
  return memSupabase({
    brokerages: [{ id: B1 }, { id: B2 }],
    users: [
      { id: U_BROKER, brokerage_id: B1, user_type: "broker" }, { id: U_TC, brokerage_id: B1, user_type: "tc" },
      { id: U_CO, brokerage_id: B1, user_type: "compliance_officer" }, { id: U_AGENT, brokerage_id: B1, user_type: "agent" },
      { id: U_AGENT2, brokerage_id: B1, user_type: "agent" }, { id: U_BUYSIDE, brokerage_id: B1, user_type: "agent" },
      { id: U_LEAD, brokerage_id: B1, user_type: "team_lead" }, { id: U_LEAD2, brokerage_id: B1, user_type: "team_lead" },
      { id: U_VENDOR, brokerage_id: B1, user_type: "vendor" }, { id: U_CONTACT, brokerage_id: B1, user_type: "contact" },
      { id: U_ISA, brokerage_id: B1, user_type: "isa" }, { id: U_NOTYPE, brokerage_id: B1, user_type: null },
      { id: U_X, brokerage_id: B2, user_type: "broker" }, { id: U_XVENDOR, brokerage_id: B2, user_type: "vendor" },
    ],
    agents: [
      { id: AG_A, user_id: U_AGENT, brokerage_id: B1 }, { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 }, { id: AG_BUY, user_id: U_BUYSIDE, brokerage_id: B1 },
      { id: AG_LEAD, user_id: U_LEAD, brokerage_id: B1 }, { id: AG_LEAD2, user_id: U_LEAD2, brokerage_id: B1 }, { id: AG_X, user_id: U_X, brokerage_id: B2 },
    ],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: AG_BUY, seller_agent_id: null, status: "under_contract", purchase_price: 400000 },
      { id: TX_NOAGENT, brokerage_id: B1, agent_id: null, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
    ],
    // The vendor seats are ASSIGNED to TX1 — the row a row-security read of the deal admits them on.
    vendors: [{ id: VENDOR_ROW, brokerage_id: B1, category: "lender" }, { id: XVENDOR_ROW, brokerage_id: B2, category: "title" }],
    vendor_assignments: [{ id: u("9", 1), vendor_id: VENDOR_ROW, transaction_id: TX1, brokerage_id: B1, status: "confirmed" }, { id: u("9", 2), vendor_id: XVENDOR_ROW, transaction_id: TX1, brokerage_id: B1, status: "confirmed" }],
    transaction_repair_negotiations: [{ id: R1, transaction_id: TX1, brokerage_id: B1, item_description: "roof flashing", status: "requested" }],
    generated_documents: [], lifecycle_events: [], notifications: [], agent_action_ledger: [], teams: [],
  }, { uuidIds: true })
}

// ═══ seams (installed BEFORE any app module loads) ═════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__DD = {
  mem: world() as MemClient, seat: null as string | null, refuseTransactions: false, leads: LEADS,
  calls: { milestones: [] as any[], events: [] as any[], lender: [] as any[], other: 0 },
  sess: () => {
    const m = G.__DD.mem
    const client = Object.assign(m, { auth: { getUser: async () => ({ data: { user: G.__DD.seat ? { id: G.__DD.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) } })
    if (!G.__DD.refuseTransactions) return client
    // A REFUSED read of the deal: the same client, but `from("transactions")` resolves with an error (CLAUDE.md §3).
    const refusal = { data: null, error: { message: "permission denied (fixture)", code: "42501" } }
    const chain: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? (res: any) => res(refusal) : () => chain), apply: () => chain })
    return new Proxy(client, { get: (t: any, k) => (k === "from" ? (table: string) => (table === "transactions" ? chain : t.from(table)) : t[k]) })
  },
}
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
/** Re-export the real module, then override the named seams. */
const OVERRIDE: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__DD.sess() }; export async function createServerClient(){ return globalThis.__DD.sess() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__DD.sess() }",
}
/** Replace the module entirely — counted seams; the real module (and whatever it would reach) never loads. */
const REPLACE: Record<string, string> = {
  "lib/transactions/milestone-service.ts": "const c = () => globalThis.__DD.calls; export async function completeMilestone(p){ c().milestones.push({ fn: 'completeMilestone', ...p }) }; export async function setMilestoneDate(...a){ c().milestones.push({ fn: 'setMilestoneDate', args: a }) }; export async function overrideMilestone(p){ c().milestones.push({ fn: 'overrideMilestone', ...p }) }",
  "lib/kernel/transactions.ts": "const c = () => globalThis.__DD.calls; export async function emitTransactionEvent(p){ c().events.push(p); return { inserted: true } }; export async function updateLenderState(p){ c().lender.push(p) }",
  "lib/kernel/deal-save-huddle.ts": "export async function runDealSaveHuddle(){ globalThis.__DD.calls.other++; return { convened: false } }",
  "lib/kernel/appraisal-negotiation.ts": "export async function runAppraisalNegotiationCopilot(){ globalThis.__DD.calls.other++; return { ok: true } }",
  "lib/managers/cross-referral.ts": "export async function raiseReferralDeduped(){ globalThis.__DD.calls.other++; return { raised: false } }",
  "lib/kernel/appraiser-packet.ts": "export async function runAppraiserPacketCoaching(){ globalThis.__DD.calls.other++; return { fired: false, reason: 'fixture', pdfUrl: null, taskId: null } }",
  "lib/vendors/appraiser-independence.ts": "export async function sendAppraiserPacket(){ globalThis.__DD.calls.other++; return { ok: false, message: 'fixture: not sent' } }",
  // The team anchor (teams.team_lead_id through a database function) — a counted fixture; its rule is test:team-scope's.
  "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(_svc, userId, agentId){ const led = globalThis.__DD.leads[userId] ?? null; return { ok: true, leads: !!led && led.includes(agentId), ledTeamId: led ? 'team-of-' + userId : null } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
/** "@/x" resolved under ROOT (so a DEAL_DESK_ROOT run loads that tree's modules, not this one's). */
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    if (rep) return { url: dataUrl(REPLACE[rep]), shortCircuit: true }
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})

const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
function as(seat: string | null): MemClient {
  G.__DD.mem = world(); G.__DD.seat = seat; G.__DD.refuseTransactions = false
  G.__DD.calls = { milestones: [], events: [], lender: [], other: 0 }
  return G.__DD.mem
}
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: X | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}
const refused = (x: { r: any; threw: string | null }) => !!x.threw || x.r?.success === false
const seamCalls = () => G.__DD.calls.milestones.length + G.__DD.calls.events.length + G.__DD.calls.lender.length + G.__DD.calls.other
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []

// ═══ source readers (PURE) ═════════════════════════════════════════════════════════════════════════════════════════════
/** Exported async functions of a "use server" module, from comment-stripped source. */
const exportedActions = (stripped: string): string[] => [...stripped.matchAll(/^export\s+async\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1])
/** The text of one top-level function (exported or not), from its declaration to the closing brace at column 0. */
function fnBody(stripped: string, name: string): string {
  const at = stripped.search(new RegExp(`^(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`, "m"))
  if (at < 0) return ""
  const end = stripped.indexOf("\n}", at)
  return end < 0 ? stripped.slice(at) : stripped.slice(at, end + 2)
}
/** The two doors with a NARROWER gate of their own, and the token that proves it. Named, with the reason; not an exemption list. */
const NARROWER: Record<string, { gate: RegExp; why: string }> = {
  overrideMilestoneAction: { gate: /\brequireOverrideActor\s*\(/, why: "broker / admin / compliance seats with a written reason (lib/kernel/portal-auth.ts requireOverrideActor)" },
  sendAppraiserPacketAction: { gate: /\bsendAppraiserPacket\s*\(/, why: "the transaction's own agent only, decided in lib/vendors/appraiser-independence.ts sendAppraiserPacket" },
}
/** PURE — problems with one milestone door's source (empty = the rule holds). */
function doorProblems(name: string, body: string): string[] {
  const out: string[] = []
  const narrower = NARROWER[name]
  const gateAt = narrower ? body.search(narrower.gate) : body.search(/\bdealDeskFor\s*\(/)
  if (gateAt < 0) return [narrower ? `its narrower gate is gone (${narrower.why})` : "does not reach the deal desk (dealDeskFor)"]
  if (narrower) return out
  const firstEffect = body.search(/\.(?:insert|update|upsert|delete)\s*\(|\b(?:completeMilestone|setMilestoneDate|overrideMilestone|emitTransactionEvent|updateLenderState)\s*\(/)
  if (firstEffect >= 0 && firstEffect < gateAt) out.push("writes or reaches a seam BEFORE the desk")
  if (!/if\s*\(\s*!\s*desk\.ok\s*\)\s*return/.test(body)) out.push("the desk's refusal is not returned")
  const claims = [...body.matchAll(/\bparams\.brokerageId\b/g)].map((m) => m.index!)
  const insideGate = (i: number) => { const call = /\bdealDeskFor\s*\([^)]*\)/.exec(body); return !!call && i >= call.index && i < call.index + call[0].length }
  if (claims.some((i) => !insideGate(i))) out.push("uses the body's brokerageId for more than the claim")
  if (/\bcreateClient\s*\(/.test(body) || /\.auth\.getUser\s*\(/.test(body)) out.push("still opens the caller's row-security client")
  return out
}

// ═══ §A ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionA() {
  section("§A · decideDealDesk — one decision per seat (lib/transactions/role-guard.ts)")
  const rg = await load(ROLE_GUARD)
  if (typeof rg.decideDealDesk !== "function") { check("decideDealDesk is exported by lib/transactions/role-guard.ts", false, Object.keys(rg)); return }
  const ask = async (userId: string, role: string | null, transactionId = TX1, brokerageId = B1): Promise<any> => { as(userId); return quiet<any>(() => rg.decideDealDesk({ userId, role: role as any, brokerageId, transactionId })) }
  let d: any = await ask(U_BROKER, "broker"); check("brokerage tier: a broker works any deal of the tenant", d.allowed === true && d.tier === "brokerage", d)
  d = await ask(U_TC, "tc"); check("brokerage tier: the coordinator (tc) works any deal of the tenant", d.allowed === true && d.tier === "brokerage", d)
  d = await ask(U_TC, "transaction_coordinator"); check("…and its legacy spelling is the same seat", d.allowed === true && d.tier === "brokerage", d)
  d = await ask(U_CO, "compliance_officer"); check("brokerage tier: the compliance officer", d.allowed === true && d.tier === "brokerage", d)
  d = await ask(U_AGENT, "agent"); check("deal tier: the listing-side agent of the deal (agents.id through agents.user_id)", d.allowed === true && d.via === "own_deal", d)
  d = await ask(U_BUYSIDE, "agent"); check("deal tier: the buyer-side agent of the same deal", d.allowed === true && d.via === "own_deal", d)
  d = await ask(U_LEAD, "team_lead"); check("deal tier: the team lead of the deal agent's team", d.allowed === true && d.via === "led_team", d)
  d = await ask(U_AGENT2, "agent"); check("NEG an agent who is not on the deal", d.allowed === false && d.code === "not_your_deal", d)
  d = await ask(U_LEAD2, "team_lead"); check("NEG a team lead of ANOTHER team (a team lead is not a brokerage-wide seat)", d.allowed === false && d.code === "not_your_deal", d)
  for (const [seat, role] of [[U_VENDOR, "vendor"], [U_CONTACT, "contact"], [U_ISA, "isa"], [U_NOTYPE, null], [U_NOTYPE, ""], [U_VENDOR, "lender"], [U_VENDOR, "title_agent"]] as Array<[string, string | null]>) {
    d = await ask(seat, role); check(`NEG seat ${JSON.stringify(role)} is refused before any read (fails closed)`, d.allowed === false && d.code === "role_none" && G.__DD.mem.writes.length === 0, d)
  }
  d = await ask(U_X, "broker", TX1, B2); check("NEG another tenant's broker: the deal is not in THEIR tenant", d.allowed === false && d.code === "deal_not_found", d)
  d = await ask(U_AGENT, "agent", TX_NOAGENT); check("NEG a deal with no assigned agent is not an agent's to work", d.allowed === false && d.code === "no_assigned_agent", d)
  d = await ask(U_BROKER, "broker", TX_NOAGENT); check("…but the brokerage tier works it", d.allowed === true, d)
  as(U_BROKER); G.__DD.refuseTransactions = true
  d = await quiet<any>(() => rg.decideDealDesk({ userId: U_BROKER, role: "broker", brokerageId: B1, transactionId: TX1 }))
  check("FAIL CLOSED: a REFUSED read of the deal refuses even a broker (never 'not found', never allowed)", d.allowed === false && d.code === "deal_unreadable", d)
  as(U_AGENT2); const stage = await quiet<any>(() => rg.canTransitionStage({ userId: U_AGENT2, role: "agent", brokerageId: B1, transactionId: TX1 }))
  as(U_TC); const stageTc = await quiet<any>(() => rg.canTransitionStage({ userId: U_TC, role: "tc", brokerageId: B1, transactionId: TX1 }))
  check("ONE RULE: the stage gate gives the same answers (refuses the off-deal agent with its own wording, admits the coordinator)", stage.allowed === false && /move your own transactions/.test(String(stage.reason)) && stageTc.allowed === true, { stage, stageTc })
}

// ═══ §B ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const paramsFor = (brokerageId: string | undefined) => ({
  transactionId: TX1, brokerageId, milestoneName: "inspection_completed", overrideReason: "The seller agreed to a new date in writing.",
  appraisalValue: 410000, walkthroughDate: "2027-01-15", itemDescription: "Replace roof flashing", repairId: R1, actualCost: 350, notes: "fixture note",
})
/** Seats that must be refused by EVERY milestone door: [label, seat, the brokerage the body claims]. */
const REFUSED_SEATS: Array<[string, string | null, string]> = [
  ["a vendor seat of the tenant ASSIGNED to the deal", U_VENDOR, B1],
  ["another tenant's vendor seat ASSIGNED to the deal, naming the deal's brokerage", U_XVENDOR, B1],
  ["a contact seat", U_CONTACT, B1],
  ["an isa seat", U_ISA, B1],
  ["a seat with no user_type", U_NOTYPE, B1],
  ["an agent who is not on the deal", U_AGENT2, B1],
  ["a team lead of another team", U_LEAD2, B1],
  ["another tenant's broker naming the deal's brokerage", U_X, B1],
  ["no session", null, B1],
]
const WORKING_SEATS: Array<[string, string]> = [["the agent on the deal", U_AGENT], ["the coordinator", U_TC], ["a broker", U_BROKER], ["the team lead of the deal agent's team", U_LEAD]]

async function sectionB() {
  section(`§B · every exported door of ${MILESTONES}, driven`)
  const stripped = stripComments(raw(MILESTONES))
  const doors = exportedActions(stripped)
  check(`the doors are DERIVED from the source (${doors.length}): ${doors.join(", ")}`, doors.length >= 9 && doors.includes("completeMilestoneAction") && doors.includes("requestRepairAction"), doors)
  const tm = await load(MILESTONES)
  for (const door of doors) {
    const bad: string[] = []
    for (const [label, seat, claim] of REFUSED_SEATS) {
      const m = as(seat)
      const x = await drive(() => tm[door](paramsFor(claim)))
      if (!refused(x) || m.writes.length !== 0 || seamCalls() !== 0) bad.push(`${label}: ${refused(x) ? "refused" : "NOT refused"}, ${m.writes.length} write(s), ${seamCalls()} seam call(s)`)
    }
    check(`NEG ${door}: ${REFUSED_SEATS.length} seats that do not work this deal are each refused with 0 writes and 0 seam calls`, bad.length === 0, bad)
  }
  const deskDoors = doors.filter((d) => !NARROWER[d])
  for (const door of deskDoors) {
    const bad: string[] = []
    for (const [label, seat] of WORKING_SEATS) {
      const m = as(seat)
      const x = await drive(() => tm[door](paramsFor(B1)))
      const tenants = [...G.__DD.calls.milestones, ...G.__DD.calls.events, ...G.__DD.calls.lender].map((c: any) => c.brokerageId ?? c.args?.[1] ?? null).filter((t: unknown) => typeof t === "string")
      const rowTenants = m.writes.filter((w) => w.op === "insert").map((w) => w.payload.brokerage_id).filter((t) => t !== undefined)
      if (x.threw || (x.r as any)?.success !== true) bad.push(`${label}: not admitted (${x.threw ?? (x.r as any)?.error})`)
      else if ([...tenants, ...rowTenants].some((t) => t !== B1)) bad.push(`${label}: a write carried a tenant other than the session's`)
      else if (seamCalls() + m.writes.length === 0) bad.push(`${label}: admitted but nothing happened`)
    }
    check(`POS ${door}: the agent on the deal, the coordinator, a broker and the led team's lead are each admitted; every write carries the session's tenant`, bad.length === 0, bad)
  }
  // The body's tenant is a CLAIM: omitted is fine (the session answers), another tenant's is refused.
  let m = as(U_AGENT); let x = await drive(() => tm.completeMilestoneAction(paramsFor(undefined)))
  check("CLAIM omitted: the session's tenant answers, and the milestone seam is handed it with the session's user", (x.r as any)?.success === true && G.__DD.calls.milestones[0]?.brokerageId === B1 && G.__DD.calls.milestones[0]?.completedBy === U_AGENT, { x, c: G.__DD.calls.milestones })
  m = as(U_AGENT); x = await drive(() => tm.completeMilestoneAction(paramsFor(B2)))
  check("CLAIM of another tenant by a seat that works the deal: refused, 0 writes, 0 seam calls", refused(x) && m.writes.length === 0 && seamCalls() === 0, x)
  m = as(U_TC); x = await drive(() => tm.completeRepairAction({ ...paramsFor(B1), repairId: u("c", 99) }))
  check("completeRepairAction NEG a repair that is not this deal's: refused, the real repair untouched", refused(x) && T(m, "transaction_repair_negotiations").find((r) => r.id === R1)?.status === "requested", x)
  m = as(U_TC); x = await drive(() => tm.completeRepairAction(paramsFor(B1)))
  check("completeRepairAction POS the coordinator completes this deal's repair — the row is updated on the service client, pinned to deal and tenant", (x.r as any)?.success === true && T(m, "transaction_repair_negotiations").find((r) => r.id === R1)?.status === "completed", x)
  m = as(U_BROKER); x = await drive(() => tm.markAppraisalCompleteAction(paramsFor(B1)))
  check("markAppraisalCompleteAction POS a broker: the appraisal value lands on the deal's own row (it was a zero-row update under row security for a non-agent seat)", (x.r as any)?.success === true && T(m, "transactions").find((r) => r.id === TX1)?.appraisal_value === 410000, { x, row: T(m, "transactions").find((r) => r.id === TX1) })
}

// ═══ §C ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function sectionC() {
  section("§C · the source rules (comment-stripped)")
  const ms = stripComments(raw(MILESTONES))
  const doors = exportedActions(ms)
  for (const door of doors) {
    const p = doorProblems(door, fnBody(ms, door))
    check(`${door}: ${NARROWER[door] ? `keeps its narrower gate — ${NARROWER[door].why}` : "reaches the deal desk before any write or seam, returns its refusal, and uses the body's brokerageId only as the claim"}`, p.length === 0, p)
  }
  const good = `export async function planted(params: P) {\n  const desk = await dealDeskFor(params.transactionId, params.brokerageId)\n  if (!desk.ok) return { success: false, error: desk.error }\n  await completeMilestone({ brokerageId: desk.brokerageId })\n}`
  check("§C CONTROLS — a well-formed door passes; no desk, a write before the desk, an unreturned refusal, the body's tenant used again, and a row-security client are each caught; a desk named only in a comment is not a desk",
    doorProblems("planted", good).length === 0
    && doorProblems("planted", good.replace(/const desk[^\n]*\n[^\n]*\n/, "")).some((p) => /does not reach/.test(p))
    && doorProblems("planted", good.replace("  const desk", "  await completeMilestone({})\n  const desk")).some((p) => /BEFORE the desk/.test(p))
    && doorProblems("planted", good.replace(/  if \(!desk\.ok\)[^\n]*\n/, "")).some((p) => /not returned/.test(p))
    && doorProblems("planted", good.replace("brokerageId: desk.brokerageId", "brokerageId: params.brokerageId")).some((p) => /more than the claim/.test(p))
    && doorProblems("planted", good.replace("  await completeMilestone", "  const supabase = await createClient()\n  await completeMilestone")).some((p) => /row-security client/.test(p))
    && doorProblems("planted", stripComments(good.replace(/const desk[^\n]*\n[^\n]*\n/, "// const desk = await dealDeskFor(params.transactionId, params.brokerageId)\n"))).some((p) => /does not reach/.test(p)))
  const helper = fnBody(ms, "dealDeskFor")
  check("dealDeskFor is NOT exported, decides the body's tenant as a claim (requireCallerTenant), asks decideDealDesk with the SESSION's seat, and hands the service client back only after both",
    helper.length > 0 && !/^export\s+async\s+function\s+dealDeskFor\b/m.test(ms) && /requireCallerTenant\(\s*claimedBrokerageId\s*\)/.test(helper) && /decideDealDesk\(\s*\{[^}]*role:\s*auth\.userType/.test(helper)
    && helper.indexOf("requireCallerTenant(") < helper.indexOf("decideDealDesk(") && helper.indexOf("decideDealDesk(") < helper.indexOf("createServiceClient()"), helper.slice(0, 200))
  check(`${MILESTONES} opens no row-security client anywhere (no createClient( call, no auth.getUser)`, !/\bcreateClient\s*\(/.test(ms) && !/\.auth\.getUser\s*\(/.test(ms))

  const da = stripComments(raw(DEAL_ACTIONS))
  const rta = fnBody(da, "requireTransactionActor"), rdr = fnBody(da, "requireDealRowActor")
  check(`${DEAL_ACTIONS} requireTransactionActor asks decideDealDesk with the session's seat and tenant, and carries no roster of its own`,
    /decideDealDesk\(\s*\{[^}]*role:\s*ctx\.userType[^}]*brokerageId:\s*ctx\.brokerageId/.test(rta) && /if\s*\(\s*!\s*desk\.allowed\s*\)\s*return/.test(rta) && !/\bisAdminOrBroker\s*\(/.test(rta) && !/agent_id/.test(rta), rta.slice(0, 240))
  check("…the finance narrowing for reopening a closed deal is still applied AFTER the desk", /requireFinance/.test(rta) && rta.indexOf("decideDealDesk(") < rta.indexOf("isBrokerageFinanceAdmin("))
  check("…and the row-keyed gate still goes through it", /\brequireTransactionActor\s*\(/.test(rdr))

  const rg = stripComments(raw(ROLE_GUARD))
  const stage = fnBody(rg, "canTransitionStage")
  check("the stage gate WORDS the desk's decision and decides nothing itself (one rule)", /\bdecideDealDesk\s*\(\s*context\s*\)/.test(stage) && !/\.from\s*\(/.test(stage) && !/stageTransitionTier\s*\(/.test(stage), stage.slice(0, 200))
  check("the desk derives its tiers from the roster module (stageTransitionTier), never a retyped list", /\bstageTransitionTier\s*\(\s*context\.role\s*\)/.test(fnBody(rg, "decideDealDesk")) && !/\[\s*["']admin["']\s*,\s*["']broker["']/.test(rg))
  check("the two role-only milestone predicates stay retired (no export), and their tombstone names the gates that run",
    !/export\s+(?:async\s+)?function\s+(?:canOverrideMilestone|canEditMilestoneDate)\b/.test(rg) && /TOMBSTONE[^\n]*canOverrideMilestone and canEditMilestoneDate/.test(raw(ROLE_GUARD)) && /lib\/kernel\/portal-auth\.ts:\d+ requireOverrideActor/.test(raw(ROLE_GUARD)))
  const tomb = /lib\/kernel\/portal-auth\.ts:(\d+) requireOverrideActor/.exec(raw(ROLE_GUARD))
  check("…and that tombstone's line is where requireOverrideActor is exported", !!tomb && /^export async function requireOverrideActor\b/.test(raw("lib/kernel/portal-auth.ts").split("\n")[Number(tomb[1]) - 1] ?? ""), tomb?.[1])
}

// ═══ §D ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function sectionD() {
  section("§D · registration")
  const pkg = JSON.parse(raw("package.json", WT)) as { scripts: Record<string, string> }
  check("package.json has test:deal-desk and the guard chain runs it", /deal-desk-guard\.ts/.test(pkg.scripts["test:deal-desk"] ?? "") && /npm run test:deal-desk(\s|$)/.test(pkg.scripts.guard ?? ""))
  check("MAINTENANCE_DOMAINS names an owner for it", /proof:\s*"test:deal-desk"/.test(stripComments(raw("lib/kernel/manager-registry.ts", WT))))
}

async function main() {
  console.log(`\ndeal-desk-guard — one deal desk (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  await sectionA()
  await sectionB()
  sectionC()
  if (ROOT === WT) sectionD()
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(`❌ DEAL_DESK_FAIL — ${fails.slice(0, 12).join(" | ")}`); process.exit(1) }
  console.log("✅ DEAL_DESK_PASS — one decision says who may work a deal; every milestone door and every deal-detail edit asks it, and a seat that does not work the deal writes nothing")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
