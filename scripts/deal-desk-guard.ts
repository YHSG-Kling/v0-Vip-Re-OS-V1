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
 * §E  EVERY DESK SEAT'S DEAL-DETAIL EDIT LANDS (follow-on, 2026-11-20). The desk admitted a broker owner, a broker admin, a
 *     compliance officer and a team lead on a team member's deal, and the DATABASE then refused their edit: the nine deal-detail
 *     writers of lib/application/transactions.ts wrote through the caller's row-security client, and the two live policies on
 *     transaction_participants / _deadlines / _title_escrow / _repair_negotiations (and transaction_timeline) name only the
 *     agents on the deal and the seats broker / admin / super_admin / tc — with a WITH CHECK that also refused EVERY seat's
 *     insert that carried no brokerage_id (add a participant, add a deadline, every timeline line). §E drives the real doors
 *     (app/actions/transactions.ts → the real writers) with the SESSION client replaced by a model of those two policies
 *     (policySession below; pg_policies read 2026-11-20) and the service client left unrestricted, exactly as live:
 *       · the doors are DERIVED (the exported actions that reach a service writer of one of the four tables) and must equal
 *         the driven set; each door × each seat the desk admits saves, on the right deal, with the SESSION tenant on the row;
 *       · each door × each seat the desk refuses writes nothing; another tenant's rows are refused; a row an older writer
 *         never stamped is still editable (the DEAL is the pin); a patch cannot move a row; a refused deal read refuses;
 *       · the source rules for every writer of the four tables in the service module (desk before any write, no client of
 *         its own, every update / delete pinned to the desk's deal, every insert stamped after any spread), with controls;
 *       · THE MODEL BITES: the policy model itself is shown refusing what the live policies refuse (positive control).
 *     With DEAL_DESK_ROOT=<the tree before this change> the "saves" checks are RED for exactly those seats and inserts.
 * §F  THE INSERT SIDE OF THOSE POLICIES, AND THE CHANGE THAT CLOSES IT (follow-on, 2026-11-20). The agent policy's WITH CHECK
 *     names only the tenant, so any signed-in seat of a tenant — a vendor or a client seat included — can INSERT into the five
 *     tables through the data API on any deal id, another tenant's included. docs/operations/OWNER-SQL.md §R.6 holds the
 *     ALTER POLICY block that closes it (the owner runs it; nothing here applies SQL). §F is what makes it safe to run:
 *       · PG_MEASURED — the verbatim live policy text and that exact block, run on a real PostgreSQL 16 by
 *         scripts/deal-table-policy-measure.py: 16 seats × 8 operations, before and after. The block's fingerprint is pinned,
 *         so editing the SQL without measuring again goes red;
 *       · THE MODEL IS THAT ENGINE ON THOSE CASES — policySession (both modes) reproduces every measured cell, so the driven
 *         checks here and in §E stand on a model that agrees with Postgres, not on my reading of the documentation;
 *       · THE CENSUS (derived, comment-stripped) — every write statement on the five tables in app/ and lib/, with the client
 *         its receiver is bound to: none rides a session client (a file nothing imports is named, with the proof); a function
 *         that is HANDED its client is traced to every caller, each of which must hand it the service client;
 *       · the doors that DID ride a session client are driven or source-ruled: the earnest-money door and the one timeline
 *         writer under BOTH policy modes, the AI deadline door and the two former inline timeline inserts by source rule.
 *     With DEAL_DESK_ROOT=<the tree before this change> the census finds the session sites and the driven doors go red.
 * §G  THE AI DEAL DOORS (follow-on, 2026-11-20). app/actions/ai-transaction-coordinator.ts gated its doors on "the caller can
 *     READ the deal in the session's tenant" (scopeTransaction), and app/actions/ai-closing-workflow.ts on session + tenant —
 *     and the transactions SELECT policies admit a vendor seat assigned to the deal. So a lender / title / inspector seat
 *     could spend a model call on the deal (AI is platform-covered: a call a seat may not make is a wrong invoice), and two
 *     of those doors also write or send. §G: the doors are DERIVED (every exported action of the two files that reaches a
 *     model or the shared gate); each must reach the deal desk — and return its refusal — BEFORE the first model call and
 *     before any write, with a control per rule; every door is DRIVEN with the model seam replaced by a COUNTED stub (no
 *     provider is ever reached): each seat the desk refuses spends 0 model calls and writes nothing, each seat it admits
 *     reaches the seam. The agent-wide risk scan asks the desk per deal: only admitted deals reach the model, and a deal id
 *     that comes back from the model lands only on an admitted deal. Red on the tree before the change.
 *
 * BLIND SPOTS (published). The in-memory client has no row security, CHECKs or foreign keys — which is exactly why a gate
 * that leaned on row security shows up here. lib/teams/team-scope.ts leadsAgentsTeam is a counted fixture (it calls a
 * database function the fake cannot run); its own rule is proven by test:team-scope. §B drives the doors, not the screens.
 * The closing-question gates (lib/commission/closing-verification.ts mayAttestClosing) are a SEPARATE roster and are not
 * asserted here: they admit the coordinator ASSIGNED to the deal and a team lead tenant-wide.
 * §E's policySession is a MODEL of two measured policies, not Postgres: permissive policies OR-ed, USING for visibility,
 * WITH CHECK for the new row, RETURNING needing visibility. It models no other table's row security (the doors read the deal
 * on the service client), no CHECK constraint and no embed (`transactions(id)` projects nothing here). Two service writers of
 * the four tables have NO door (they are printed by §E) — the source rules hold them; nothing drives them. Other files' doors
 * onto these tables keep their own gates and are not driven here: the title vendor's status (app/actions/title-portal.ts),
 * the repair doors of §B. §F's census matches a LITERAL table name: a write through a computed name
 * (lib/kernel/brokerage-transfer.ts `svc.from(table)`, the service client) is not seen. Its classifier binds a receiver to the
 * NEAREST PRECEDING declaration of that name in the file — lexical scope by position, not a parser; "unknown" fails the guard
 * rather than passing. A declaration `x = handed ?? createServiceClient()` counts as the service client; its handed half is not
 * followed (one site: lib/voice/team-commands.ts). PG_MEASURED was measured with NO row security on public.transactions / public.agents (the policies'
 * subqueries read them as the caller); live, those tables have their own policies, which can only refuse more. §F does not
 * drive the AI deadline door (it reaches a model) — its rule is read from source. §G's model seam is a stub that returns an
 * empty object: a door is shown to REACH the model, not to do anything sensible with its answer (that is each door's own
 * proof). The outbound send (sendTransactionCommunication) is driven for refusals only — a send is never performed here.
 * The fake has no row security on public.transactions, which is exactly the "whoever can read the deal" the old gate was.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
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
// §E: two more brokerage seats, a second deal of the same agents (it has no title / escrow record yet), and the deal-detail rows.
const U_OWNER = u("a", 13), U_BADMIN = u("a", 14), U_ADMIN = u("a", 15), TX2 = u("d", 3)
const P1 = u("c", 2), P_OLD = u("c", 3), P_X = u("c", 4), E1 = u("c", 5), E_X = u("c", 6), D1 = u("c", 7), D_X = u("c", 8), R_X = u("c", 9)
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
      { id: U_OWNER, brokerage_id: B1, user_type: "broker_owner" }, { id: U_BADMIN, brokerage_id: B1, user_type: "broker_admin" },
      { id: U_ADMIN, brokerage_id: B1, user_type: "admin" },
    ],
    agents: [
      { id: AG_A, user_id: U_AGENT, brokerage_id: B1 }, { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 }, { id: AG_BUY, user_id: U_BUYSIDE, brokerage_id: B1 },
      { id: AG_LEAD, user_id: U_LEAD, brokerage_id: B1 }, { id: AG_LEAD2, user_id: U_LEAD2, brokerage_id: B1 }, { id: AG_X, user_id: U_X, brokerage_id: B2 },
    ],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: AG_BUY, seller_agent_id: null, status: "under_contract", purchase_price: 400000 },
      { id: TX_NOAGENT, brokerage_id: B1, agent_id: null, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
      { id: TX2, brokerage_id: B1, agent_id: AG_A, buyer_agent_id: AG_BUY, seller_agent_id: null, status: "under_contract" },
    ],
    // The vendor seats are ASSIGNED to TX1 — the row a row-security read of the deal admits them on.
    vendors: [{ id: VENDOR_ROW, brokerage_id: B1, category: "lender" }, { id: XVENDOR_ROW, brokerage_id: B2, category: "title" }],
    vendor_assignments: [{ id: u("9", 1), vendor_id: VENDOR_ROW, transaction_id: TX1, brokerage_id: B1, status: "confirmed" }, { id: u("9", 2), vendor_id: XVENDOR_ROW, transaction_id: TX1, brokerage_id: B1, status: "confirmed" }],
    transaction_repair_negotiations: [{ id: R1, transaction_id: TX1, brokerage_id: B1, item_description: "roof flashing", status: "requested" }, { id: R_X, transaction_id: TX_X, brokerage_id: B2, item_description: "other roof", status: "requested" }],
    // P_OLD: a row an older writer never stamped with its tenant (the column is nullable and nothing defaults it).
    transaction_participants: [{ id: P1, transaction_id: TX1, brokerage_id: B1, role: "inspector", name: "Ivy" }, { id: P_OLD, transaction_id: TX1, brokerage_id: null, role: "appraiser", name: "Old Row" }, { id: P_X, transaction_id: TX_X, brokerage_id: B2, role: "inspector", name: "Other" }],
    transaction_title_escrow: [{ id: E1, transaction_id: TX1, brokerage_id: B1, title_company_name: "First Title" }, { id: E_X, transaction_id: TX_X, brokerage_id: B2, title_company_name: "Other Title" }],
    transaction_deadlines: [{ id: D1, transaction_id: TX1, brokerage_id: B1, deadline_type: "inspection", status: "pending", notes: "Inspection" }, { id: D_X, transaction_id: TX_X, brokerage_id: B2, deadline_type: "inspection", status: "pending", notes: "Other" }],
    transaction_timeline: [],
    generated_documents: [], lifecycle_events: [], notifications: [], agent_action_ledger: [], teams: [],
  }, { uuidIds: true })
}

// ═══ seams (installed BEFORE any app module loads) ═════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__DD = {
  mem: world() as MemClient, seat: null as string | null, refuseTransactions: false, leads: LEADS, rls: false, policy: "live" as "live" | "proposed",
  calls: { milestones: [] as any[], events: [] as any[], lender: [] as any[], other: 0, model: 0 }, modelObject: null as any,
  /** The caller's client. §E turns `rls` on: it is then the model of the live policies; the service client never is. */
  sess: () => (G.__DD.rls ? policySession(G.__DD.base(), G.__DD.seat) : G.__DD.base()),
  svc: () => G.__DD.base(),
  base: () => {
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
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__DD.svc() }",
  // §G THE MODEL SEAM — counted; a provider is never reached. The stub answers with globalThis.__DD.modelObject (default {}).
  "lib/ai/generate.ts": "export function bookedGenerateObject(){ return async () => { globalThis.__DD.calls.model++; return { object: globalThis.__DD.modelObject ?? {}, usage: {} } } }",
  "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__DD.calls.model++; return { text: 'stub', usage: {} } }",
  "lib/ai/resolve-model.ts": "export function resolveModel(x){ return x }",
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
  G.__DD.mem = world(); G.__DD.seat = seat; G.__DD.refuseTransactions = false; G.__DD.rls = false; G.__DD.policy = "live"
  G.__DD.calls = { milestones: [], events: [], lender: [], other: 0, model: 0 }; G.__DD.modelObject = null
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

// ═══ §E — the two live row-security policies as the SESSION client ═════════════════════════════════════════════════════
const DETAIL_TABLES = ["transaction_participants", "transaction_deadlines", "transaction_title_escrow", "transaction_repair_negotiations"]
const POLICY_TABLES = new Set<string>([...DETAIL_TABLES, "transaction_timeline"])
/** trx_broker_<table>: the seats the policy names. `super_admin` is in the live policy and is not a storable users.user_type. */
const POLICY_SEATS = ["broker", "admin", "super_admin", "tc"]
/** docs/operations/OWNER-SQL.md §R.6 trx_broker_<table>: the deal desk's brokerage tier (the dead name is gone). */
const PROPOSED_SEATS = ["broker", "broker_owner", "broker_admin", "admin", "compliance_officer", "tc"]
/**
 * pg_policies, project hrvaqgvukzxfskkcrwbt, read 2026-11-20 — the same two policies on each of the five tables:
 *   trx_agent_<t>   ALL  USING  the caller is agent_id / buyer_agent_id / seller_agent_id of the row's deal (agents.user_id = auth.uid())
 *                        CHECK  brokerage_id = current_user_brokerage_id()
 *   trx_broker_<t>  ALL  USING and CHECK  brokerage_id = current_user_brokerage_id() AND current_user_type() IN (POLICY_SEATS)
 * Permissive policies OR together: a row is VISIBLE when either USING holds; a new or changed row LANDS when either CHECK
 * holds (so: when it carries the caller's tenant); a write that RETURNS its row needs the row visible.
 */
function policySession(client: any, seat: string | null): any {
  const mem = client as MemClient
  const me = T(mem, "users").find((x) => x.id === seat) ?? null
  const tenant: string | null = me?.brokerage_id ?? null, type = String(me?.user_type ?? "")
  const myAgents = new Set(T(mem, "agents").filter((a) => a.user_id === seat).map((a) => a.id))
  const sameTenant = (row: Row) => tenant !== null && row.brokerage_id === tenant
  const onMyDeal = (row: Row) => { const d = T(mem, "transactions").find((t) => t.id === row.transaction_id); return !!d && [d.agent_id, d.buyer_agent_id, d.seller_agent_id].some((a) => a && myAgents.has(a)) }
  // PROPOSED (§R.6): the agent CHECK also names the deal (in the caller's tenant); the broker policy names the six desk seats
  // and its CHECK also requires the DEAL to be in the caller's tenant. USING is not narrowed.
  const proposed = G.__DD.policy === "proposed"
  const dealInTenant = (row: Row) => { const d = T(mem, "transactions").find((t) => t.id === row.transaction_id); return !!d && tenant !== null && d.brokerage_id === tenant }
  const seats = proposed ? PROPOSED_SEATS : POLICY_SEATS
  const using = (row: Row) => !!seat && (onMyDeal(row) || (sameTenant(row) && seats.includes(type)))
  const withCheck = (row: Row) => !!seat && sameTenant(row) && (!proposed || (dealInTenant(row) && (onMyDeal(row) || seats.includes(type))))
  const denied = (table: string) => ({ data: null, error: { code: "42501", message: `new row violates row-level security policy for table "${table}"` } })
  const from = (table: string) => {
    const real: any = client.from(table)
    if (!POLICY_TABLES.has(table)) return real
    let op = "select", rows: Row[] = [], returning = false
    const exec = async (name: "then" | "single" | "maybeSingle"): Promise<any> => {
      if (op === "insert" && !(rows.every(withCheck) && (!returning || rows.every(using)))) return denied(table)
      const all = mem.tables[table] ?? []
      const hidden = all.filter((r) => !using(r)), visible = all.filter((r) => using(r))
      const before = new Map(visible.map((r) => [r, { ...r }]))
      mem.tables[table] = visible // the fake reads tables[table] when it RUNS — synchronously, inside the call on the next line
      const pending = name === "then" ? real.then((v: any) => v) : real[name]()
      const ran = mem.tables[table] ?? [] // …then the hidden rows go back where they were: the original order, new rows last
      mem.tables[table] = [...all.filter((r) => hidden.includes(r) || ran.includes(r)), ...ran.filter((r) => !all.includes(r))]
      const res = await pending
      if (op === "update" && visible.some((r) => JSON.stringify(r) !== JSON.stringify(before.get(r)) && !withCheck(r))) {
        for (const r of visible) { const was = before.get(r)!; for (const k of Object.keys(r)) delete r[k]; Object.assign(r, was) }
        return denied(table)
      }
      return res
    }
    const p: any = new Proxy({}, { get: (_t, k) => {
      if (typeof k !== "string") return undefined
      if (k === "then") return (res: any, rej: any) => exec("then").then(res, rej)
      if (k === "single" || k === "maybeSingle") return () => exec(k)
      return (...args: any[]) => {
        if (k === "insert" || k === "upsert") { op = "insert"; rows = Array.isArray(args[0]) ? args[0] : [args[0]] }
        else if (k === "update" || k === "delete") op = k
        else if (k === "select" && op !== "select") returning = true
        real[k](...args)
        return p
      }
    } })
    return p
  }
  return new Proxy(client, { get: (t: any, k) => (k === "from" ? from : t[k]) })
}
/** A fresh world, signed in as `seat`, with the SESSION client under the policy model. */
function underPolicies(seat: string | null, mode: "live" | "proposed" = "live"): MemClient { const m = as(seat); G.__DD.rls = true; G.__DD.policy = mode; return m }
const detailState = (m: MemClient) => JSON.stringify([...POLICY_TABLES].map((t) => T(m, t)))

/** The driven deal-detail doors: how each is called and what "it landed" means — on the right deal, in the SESSION's tenant. */
const DETAIL_DOORS: Record<string, { call: (a: any) => Promise<any>; landed: (m: MemClient) => boolean }> = {
  addParticipant: { call: (a) => a.addParticipant({ transaction_id: TX1, role: "inspector", name: "Nia Inspector" }), landed: (m) => T(m, "transaction_participants").some((r) => r.name === "Nia Inspector" && r.transaction_id === TX1 && r.brokerage_id === B1) },
  updateParticipant: { call: (a) => a.updateParticipant(P1, { name: "Renamed" }), landed: (m) => { const r = T(m, "transaction_participants").find((x) => x.id === P1); return r?.name === "Renamed" && r.transaction_id === TX1 && r.brokerage_id === B1 } },
  removeParticipant: { call: (a) => a.removeParticipant(P1), landed: (m) => !T(m, "transaction_participants").some((r) => r.id === P1) && T(m, "transaction_participants").some((r) => r.id === P_X) },
  addTitleEscrow: { call: (a) => a.addTitleEscrow({ transaction_id: TX2, title_company_name: "Second Title" }), landed: (m) => T(m, "transaction_title_escrow").some((r) => r.transaction_id === TX2 && r.brokerage_id === B1 && r.title_company_name === "Second Title") },
  updateTitleEscrow: { call: (a) => a.updateTitleEscrow(E1, { escrow_number: "ESC-9" }), landed: (m) => { const r = T(m, "transaction_title_escrow").find((x) => x.id === E1); return r?.escrow_number === "ESC-9" && r.transaction_id === TX1 } },
  addDeadline: { call: (a) => a.addDeadline({ transaction_id: TX1, deadline_type: "inspection", notes: "Inspection window", deadline_date: "2026-12-01" }), landed: (m) => T(m, "transaction_deadlines").some((r) => r.notes === "Inspection window" && r.transaction_id === TX1 && r.brokerage_id === B1 && r.status === "pending") },
  updateDeadline: { call: (a) => a.updateDeadline(D1, { notes: "Moved" }), landed: (m) => T(m, "transaction_deadlines").find((x) => x.id === D1)?.notes === "Moved" },
  completeDeadline: { call: (a) => a.completeDeadline(D1), landed: (m) => T(m, "transaction_deadlines").find((x) => x.id === D1)?.status === "completed" },
  respondToRepairRequest: { call: (a) => a.respondToRepairRequest(R1, "accepted"), landed: (m) => T(m, "transaction_repair_negotiations").find((x) => x.id === R1)?.status === "approved" },
}
/** Every seat the desk admits for TX1 / TX2 (§A), and every seat it refuses. */
const DESK_SEATS: Array<[string, string]> = [[U_BROKER, "broker"], [U_OWNER, "broker owner"], [U_BADMIN, "broker admin"], [U_CO, "compliance officer"], [U_TC, "coordinator"], [U_AGENT, "listing-side agent"], [U_BUYSIDE, "buyer-side agent"], [U_LEAD, "team lead of the deal agent's team"]]
const OFF_DESK_SEATS: Array<[string | null, string]> = [[U_AGENT2, "agent off the deal"], [U_LEAD2, "another team's lead"], [U_VENDOR, "vendor assigned to the deal"], [U_CONTACT, "contact"], [U_ISA, "isa"], [U_NOTYPE, "no user_type"], [U_X, "another tenant's broker"], [null, "no session"]]

const SERVICE = "lib/application/transactions.ts"
/** One top-level function, whole — to its closing brace ALONE at column 0 (a multi-line parameter type closes with `})`, which fnBody would stop at). */
function fnWhole(stripped: string, name: string): string {
  const at = stripped.search(new RegExp(`^(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`, "m"))
  if (at < 0) return ""
  const end = stripped.indexOf("\n}\n", at)
  return end < 0 ? stripped.slice(at) : stripped.slice(at, end + 3)
}
const WRITE_VERB = /\.(?:insert|update|upsert|delete)\s*\(/
/** Service functions (exported or not) that WRITE one of the four tables — derived from comment-stripped source. */
function detailWriters(stripped: string): string[] {
  return [...stripped.matchAll(/^(?:export\s+)?async\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1]).filter((name) => {
    const body = fnWhole(stripped, name)
    return DETAIL_TABLES.some((t) => body.includes(`.from("${t}")`)) && detailStatements(body).some((st) => WRITE_VERB.test(st))
  })
}
/** The statements of a body that start at `.from("<one of the four tables>")` — each runs to the next blank line. */
function detailStatements(body: string): string[] {
  const out: string[] = []
  for (const t of DETAIL_TABLES) for (const m of body.matchAll(new RegExp(`\\.from\\("${t}"\\)`, "g"))) { const end = body.indexOf("\n\n", m.index!); out.push(body.slice(m.index!, end < 0 ? body.length : end)) }
  return out
}
/** PURE — problems with one service writer of the four tables (empty = the rule holds). */
function writerProblems(body: string): string[] {
  const out: string[] = []
  const deskAt = body.search(/\bdealDeskWriteContext\s*\(/)
  if (deskAt < 0) out.push("does not ask the deal desk (dealDeskWriteContext)")
  const firstWrite = body.search(WRITE_VERB)
  if (deskAt >= 0 && firstWrite >= 0 && firstWrite < deskAt) out.push("writes BEFORE the desk")
  if (deskAt >= 0 && !/if\s*\(\s*!\s*gate\.ok\s*\)\s*return/.test(body)) out.push("the desk's refusal is not returned")
  if (/\bactingWriteContext\s*\(/.test(body) || /\bcreateClient\s*\(/.test(body) || /\bcreateServiceClient\s*\(/.test(body)) out.push("resolves a client of its own")
  if (/\baddTimelineEntry\s*\(/.test(body)) out.push("writes its timeline line through a second resolution of the session, not on the desk's client")
  for (const st of detailStatements(body)) {
    if (/\.(?:update|delete)\s*\(/.test(st) && !/\.eq\(\s*"transaction_id"\s*,\s*gate\.transactionId\s*\)/.test(st)) out.push("an update / delete is not pinned to the desk's deal")
    if (/\.update\s*\(\s*(?!\{|withoutRowIdentity\s*\()/.test(st)) out.push("passes a caller's patch without dropping the row's identity")
    const ins = /\.(?:insert|upsert)\s*\(([\s\S]*)/.exec(st)
    if (ins) {
      const arg = ins[1], deal = arg.indexOf("transaction_id: gate.transactionId"), ten = arg.indexOf("brokerage_id: gate.brokerageId"), spread = arg.lastIndexOf("...")
      if (deal < 0 || ten < 0) out.push("an insert does not stamp the desk's deal and the session tenant")
      else if (spread > Math.min(deal, ten)) out.push("an insert spreads caller data AFTER the stamp (the spread could overwrite it)")
    }
  }
  return [...new Set(out)]
}

/** Every deal-detail door × every desk seat saves, × every off-desk seat writes nothing — under one policy mode. */
async function driveDetailDoors(act: any, mode: "live" | "proposed") {
  const tag = mode === "live" ? "" : " [PROPOSED policies]"
  for (const door of Object.keys(DETAIL_DOORS).filter((d) => typeof act[d] === "function")) {
    const notSaved: string[] = []
    for (const [seat, label] of DESK_SEATS) {
      const m = underPolicies(seat, mode)
      const x = await drive(() => DETAIL_DOORS[door].call(act))
      if (!((x.r as any)?.success === true && DETAIL_DOORS[door].landed(m))) notSaved.push(`${label}: ${x.threw ?? (x.r as any)?.error ?? "resolved, but the row is not as asked"}`)
    }
    check(`${door}${tag}: each of the ${DESK_SEATS.length} seats the desk admits saves — on the deal, with the session's tenant`, notSaved.length === 0, notSaved)
    const wrote: string[] = []
    for (const [seat, label] of OFF_DESK_SEATS) {
      const m = underPolicies(seat, mode)
      const was = detailState(m)
      const x = await drive(() => DETAIL_DOORS[door].call(act))
      if (!refused(x) || detailState(m) !== was) wrote.push(`${label}: ${detailState(m) !== was ? "ROWS CHANGED" : "rows unchanged"}, answered ${JSON.stringify(x.r ?? x.threw)?.slice(0, 140)}`)
    }
    check(`NEG ${door}${tag}: each of the ${OFF_DESK_SEATS.length} seats the desk refuses is refused and the five tables are unchanged`, wrote.length === 0, wrote)
  }
}

async function sectionE() {
  section("§E · every desk seat's deal-detail edit lands (the session client models the two live policies)")
  // ── THE MODEL BITES (positive control for the store itself) ──
  let m: MemClient = underPolicies(U_CO)
  const coUpd = await G.__DD.sess().from("transaction_participants").update({ name: "x" }).eq("id", P1).select().single()
  const coIns = await G.__DD.sess().from("transaction_title_escrow").insert({ transaction_id: TX2, brokerage_id: B1, title_company_name: "t" }).select().single()
  m = underPolicies(U_AGENT)
  const agNoTenant = await G.__DD.sess().from("transaction_deadlines").insert({ transaction_id: TX1, deadline_type: "x", status: "pending" }).select().single()
  const agUpd = await G.__DD.sess().from("transaction_participants").update({ name: "by agent" }).eq("id", P1).select().single()
  const agOld = await G.__DD.sess().from("transaction_participants").update({ name: "y" }).eq("id", P_OLD).select().single()
  const agentRows = T(m, "transaction_participants").map((r) => r.name).sort().join(",")
  m = underPolicies(U_TC)
  const tcUpd = await G.__DD.sess().from("transaction_deadlines").update({ notes: "by tc" }).eq("id", D1).select().single()
  const tcX = await G.__DD.sess().from("transaction_deadlines").update({ notes: "cross" }).eq("id", D_X).select().single()
  const tcTimeline = await G.__DD.sess().from("transaction_timeline").insert({ transaction_id: TX1, activity_type: "x", description: "no tenant" })
  const svcUpd = await G.__DD.svc().from("transaction_participants").update({ name: "service" }).eq("id", P_X).select().single()
  check("THE MODEL BITES — as measured live: a compliance officer's update matches no row and their insert cannot return; an agent's insert with no tenant is 42501; the agent on the deal and the coordinator write their own tenant's rows; a never-stamped row fails the CHECK; another tenant's row is invisible; a timeline line with no tenant is refused; the service client is unrestricted",
    coUpd.error?.code === "PGRST116" && coIns.error?.code === "42501" && agNoTenant.error?.code === "42501" && !agUpd.error && agUpd.data?.name === "by agent" && agOld.error?.code === "42501" && agentRows === "Old Row,Other,by agent"
    && !tcUpd.error && tcUpd.data?.notes === "by tc" && tcX.error?.code === "PGRST116" && tcTimeline.error?.code === "42501" && !svcUpd.error && svcUpd.data?.name === "service",
    { coUpd: coUpd.error?.code, coIns: coIns.error?.code, agNoTenant: agNoTenant.error?.code, agUpd: agUpd.error ?? agUpd.data?.name, agOld: agOld.error?.code, agentRows, tcUpd: tcUpd.error ?? tcUpd.data?.notes, tcX: tcX.error?.code, tcTimeline: tcTimeline.error?.code, svcUpd: svcUpd.error ?? svcUpd.data?.name })

  // ── the doors are DERIVED and must equal the driven set ──
  const svcSrc = stripComments(raw(SERVICE)), da = stripComments(raw(DEAL_ACTIONS))
  const writers = detailWriters(svcSrc)
  const doorOf = (action: string) => writers.find((w) => new RegExp(`\\bTransactionService\\.${w}\\s*\\(`).test(fnWhole(da, action)))
  const doors = exportedActions(da).filter((a) => !!doorOf(a))
  const undriven = doors.filter((d) => !DETAIL_DOORS[d]), stale = Object.keys(DETAIL_DOORS).filter((d) => !doors.includes(d))
  check(`the deal-detail doors are derived, not listed: ${doors.length} exported actions of ${DEAL_ACTIONS} reach a service writer of the four tables, and every one is driven below`, doors.length > 0 && undriven.length === 0 && stale.length === 0, { doors, undriven, stale })
  const doorless = writers.filter((w) => !doors.some((d) => doorOf(d) === w))
  console.log(`    (published) ${writers.length} service writers of the four tables; ${doorless.length} with no door — held by the source rules only: ${doorless.join(", ") || "none"}`)

  // ── DRIVEN: every seat the desk admits saves; every seat it refuses writes nothing ──
  const act = await load(DEAL_ACTIONS)
  await driveDetailDoors(act, "live")
  check("every driven door exists on the module", Object.keys(DETAIL_DOORS).every((d) => typeof act[d] === "function"), Object.keys(DETAIL_DOORS).filter((d) => typeof act[d] !== "function"))

  // ── another tenant's rows ──
  const cross: Array<[string, () => Promise<any>]> = [["updateParticipant", () => act.updateParticipant(P_X, { name: "moved" })], ["removeParticipant", () => act.removeParticipant(P_X)], ["updateTitleEscrow", () => act.updateTitleEscrow(E_X, { escrow_number: "X" })], ["updateDeadline", () => act.updateDeadline(D_X, { notes: "X" })], ["completeDeadline", () => act.completeDeadline(D_X)], ["respondToRepairRequest", () => act.respondToRepairRequest(R_X, "accepted")], ["addParticipant", () => act.addParticipant({ transaction_id: TX_X, role: "inspector", name: "Planted" })], ["addDeadline", () => act.addDeadline({ transaction_id: TX_X, deadline_type: "inspection", notes: "Planted", deadline_date: "2026-12-01" })], ["addTitleEscrow", () => act.addTitleEscrow({ transaction_id: TX_X, title_company_name: "Planted" })]]
  const leaked: string[] = []
  for (const [name, call] of cross) { m = underPolicies(U_BROKER); const was = detailState(m); const x = await drive(call); if (!refused(x) || detailState(m) !== was) leaked.push(name) }
  check(`NEG another tenant's deal: a broker of THIS tenant is refused on all ${cross.length} doors and the other tenant's rows are unchanged`, leaked.length === 0, leaked)

  // ── the deal is the pin: a row an older writer never stamped ──
  m = underPolicies(U_CO)
  let x = await drive(() => act.updateParticipant(P_OLD, { name: "Old Row, corrected" }))
  let old = T(m, "transaction_participants").find((r) => r.id === P_OLD)
  check("a row an older writer never stamped with its tenant is still editable by the desk — the DEAL is the pin, and the row stays on it", (x.r as any)?.success === true && old?.name === "Old Row, corrected" && old?.transaction_id === TX1, { r: x.r, old })

  // ── the sink's own defense: a patch cannot move a row; an insert cannot choose its tenant ──
  const svc = await load(SERVICE)
  m = underPolicies(U_BROKER)
  x = await drive(() => svc.updateParticipant(P1, { name: "kept", transaction_id: TX_X, brokerage_id: B2, id: P_X } as any))
  const kept = T(m, "transaction_participants").find((r) => r.id === P1)
  m = underPolicies(U_BROKER)
  const y = await drive(() => svc.addParticipant({ transaction_id: TX1, role: "inspector", name: "Chosen Tenant", brokerage_id: B2, id: P_X } as any))
  const made = T(m, "transaction_participants").filter((r) => r.name === "Chosen Tenant")
  check("THE SINK: a patch naming id / transaction_id / brokerage_id does not move the row, and an insert carrying a brokerage_id of its own lands in the SESSION's tenant under a fresh id",
    (x.r as any)?.success === true && kept?.name === "kept" && kept?.transaction_id === TX1 && kept?.brokerage_id === B1 && (y.r as any)?.success === true && made.length === 1 && made[0].brokerage_id === B1 && made[0].transaction_id === TX1 && made[0].id !== P_X, { kept, made, x: x.r, y: y.r })

  // ── the timeline line the edit writes ──
  m = underPolicies(U_CO)
  x = await drive(() => act.addParticipant({ transaction_id: TX1, role: "inspector", name: "Timeline Seat" }))
  const lines = T(m, "transaction_timeline")
  check("the edit's timeline line lands for a seat that is not on the deal, on the deal, with the session's tenant (it was inserted with no tenant, which the policies' CHECK refuses for every seat)", (x.r as any)?.success === true && lines.length === 1 && lines[0].transaction_id === TX1 && lines[0].brokerage_id === B1 && lines[0].activity_type === "participant_added", { r: x.r, lines })

  // ── fail closed ──
  m = underPolicies(U_BROKER); G.__DD.refuseTransactions = true
  const wasClosed = detailState(m)
  x = await drive(() => act.updateDeadline(D1, { notes: "should not land" }))
  check("FAIL CLOSED: when the deal cannot be read, even a broker's edit is refused and nothing is written", refused(x) && detailState(m) === wasClosed, x.r)

  // ── the source rules, for EVERY writer of the four tables (doorless ones included) ──
  for (const w of writers) { const p = writerProblems(fnWhole(svcSrc, w)); check(`${SERVICE} ${w}: asks the desk before any write, resolves no client of its own, pins every update / delete to the desk's deal and stamps every insert`, p.length === 0, p) }
  check("…and there is at least one such writer to judge (the derivation is not empty)", writers.length > 0, writers)
  const good = `export async function planted(id: string, updates: U) {\n  const gate = await dealDeskWriteContext({ table: "transaction_participants", rowId: id })\n  if (!gate.ok) return { success: false, error: gate.error }\n  const supabase = gate.db\n  const { data, error } = await supabase\n    .from("transaction_participants")\n    .update(withoutRowIdentity(updates))\n    .eq("id", id).eq("transaction_id", gate.transactionId)\n    .select()\n    .single()\n\n  return { success: true, data }\n}`
  const goodInsert = good.replace(/\.update\(withoutRowIdentity\(updates\)\)\n    \.eq\("id", id\)\.eq\("transaction_id", gate\.transactionId\)/, ".insert({ ...updates, transaction_id: gate.transactionId, brokerage_id: gate.brokerageId })")
  check("§E CONTROLS — a well-formed writer passes (update and insert); no desk, a write before the desk, an unreturned refusal, its own client, a timeline line through the session seam, an unpinned update, a raw caller patch, an unstamped insert, and a spread after the stamp are each caught; a desk named only in a comment is not a desk",
    writerProblems(good).length === 0 && writerProblems(goodInsert).length === 0
    && writerProblems(good.replace(/  const gate[^\n]*\n[^\n]*\n/, "")).some((p) => /does not ask/.test(p))
    && writerProblems(good.replace("  const gate", `  await db.from("transaction_participants").delete().eq("id", id)\n  const gate`)).some((p) => /BEFORE the desk/.test(p))
    && writerProblems(good.replace(/  if \(!gate\.ok\)[^\n]*\n/, "")).some((p) => /not returned/.test(p))
    && writerProblems(good.replace("  const supabase = gate.db", "  const supabase = await createClient()")).some((p) => /client of its own/.test(p))
    && writerProblems(good.replace("  return { success: true, data }", "  await addTimelineEntry(gate.transactionId, \"x\", \"y\")\n  return { success: true, data }")).some((p) => /second resolution/.test(p))
    && writerProblems(good.replace("dealDeskWriteContext({ table: \"transaction_participants\", rowId: id })", "actingWriteContext()")).some((p) => /does not ask/.test(p))
    && writerProblems(good.replace('.eq("transaction_id", gate.transactionId)', "")).some((p) => /not pinned/.test(p))
    && writerProblems(good.replace("withoutRowIdentity(updates)", "updates")).some((p) => /without dropping/.test(p))
    && writerProblems(goodInsert.replace(", brokerage_id: gate.brokerageId", "")).some((p) => /does not stamp/.test(p))
    && writerProblems(goodInsert.replace("{ ...updates, transaction_id: gate.transactionId, brokerage_id: gate.brokerageId }", "{ transaction_id: gate.transactionId, brokerage_id: gate.brokerageId, ...updates }")).some((p) => /AFTER the stamp/.test(p))
    && writerProblems(stripComments(good.replace(/  const gate[^\n]*\n[^\n]*\n/, "  // const gate = await dealDeskWriteContext({ table: \"transaction_participants\", rowId: id })\n"))).some((p) => /does not ask/.test(p)))
  const helper = fnWhole(svcSrc, "dealDeskWriteContext")
  check("dealDeskWriteContext is NOT exported; it stands on the one write seam (session, grant mode), asks decideDealDesk with that seam's seat and tenant, returns the desk's refusal, and hands back the service client only on a pass",
    helper.length > 0 && !/^export\s+async\s+function\s+dealDeskWriteContext\b/m.test(svcSrc) && helper.indexOf("actingWriteContext(") >= 0 && helper.indexOf("actingWriteContext(") < helper.indexOf("createServiceClient(")
    && /decideDealDesk\(\s*\{[^}]*role:\s*seam\.userType[^}]*brokerageId:\s*seam\.brokerageId/.test(helper) && /if\s*\(\s*!\s*desk\.allowed\s*\)\s*return\s*\{\s*ok:\s*false/.test(helper)
    && helper.indexOf("decideDealDesk(") < helper.lastIndexOf("ok: true") && /catch\s*\{\s*return\s*\{\s*ok:\s*false/.test(helper), helper.slice(0, 240))
  const timelineWrites = [...svcSrc.matchAll(/\.from\("transaction_timeline"\)\s*\.(?:insert|update|upsert|delete)\s*\(/g)].length
  const line = fnWhole(svcSrc, "writeTimelineLine")
  const stampAt = line.indexOf("brokerage_id: brokerageId"), spreadAt = line.indexOf("...row")
  check("ONE timeline insert in the service module (writeTimelineLine), and it stamps the tenant of the write context that holds the client — after the row, so the row cannot overwrite it; addTimelineEntry asks the desk for the deal it is handed and passes that client and tenant",
    timelineWrites === 1 && /\.from\("transaction_timeline"\)\.insert\(/.test(line) && spreadAt >= 0 && stampAt > spreadAt && !/^export\s+async\s+function\s+writeTimelineLine\b/m.test(svcSrc)
    && /writeTimelineLine\(\s*supabase\s*,\s*gate\.brokerageId\s*,/.test(fnWhole(svcSrc, "addTimelineEntry")) && /const gate = await dealDeskWriteContext\(\s*\{\s*transactionId\s*\}\s*\)/.test(fnWhole(svcSrc, "addTimelineEntry")), { timelineWrites, line: line.slice(0, 200) })
}

// ═══ §F — the insert side of the policies, measured on PostgreSQL, and the census that makes the fix safe to run ═══════
/**
 * MEASURED, NOT MODELLED: scripts/deal-table-policy-measure.py loaded the verbatim live policy and helper-function text (pg_policies /
 * pg_proc, project hrvaqgvukzxfskkcrwbt, read 2026-11-20) into a local PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), ran every seat × operation, applied the
 * ALTER POLICY block of docs/operations/OWNER-SQL.md §R.6 UNCHANGED, and ran them again. All five tables answered identically.
 * A cell is the rows affected / visible, or the SQLSTATE (42501 = refused by row security). Operations, in order:
 *   insert_b1_deal · insert_b1_deal_returning · insert_b1_deal_no_tenant · insert_b2_deal · update_row · update_never_stamped_row · delete_row · rows_visible_on_b1_deal
 * (TX1 is a deal of tenant B1; "b2 deal" is another tenant's deal; the seat always stamps ITS OWN tenant unless "no_tenant".)
 */
const PG_MEASURED = {
  engine: "PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)",
  proposedSqlSha256: "41350c1715b02ece98c084a0deda6248420a4311e7b7b39a399fa521c99c47ad",
  cases: ["insert_b1_deal", "insert_b1_deal_returning", "insert_b1_deal_no_tenant", "insert_b2_deal", "update_row", "update_never_stamped_row", "delete_row", "rows_visible_on_b1_deal"],
  live: {
    broker: "1 1 42501 1 1 0 1 1",
    broker_owner: "1 42501 42501 1 0 0 0 0",
    broker_admin: "1 42501 42501 1 0 0 0 0",
    admin: "1 1 42501 1 1 0 1 1",
    compliance_officer: "1 42501 42501 1 0 0 0 0",
    tc: "1 1 42501 1 1 0 1 1",
    agent_on_deal: "1 1 42501 1 1 42501 1 2",
    buyer_side_agent: "1 1 42501 1 1 42501 1 2",
    team_lead_not_on_deal: "1 42501 42501 1 0 0 0 0",
    agent_off_deal: "1 42501 42501 1 0 0 0 0",
    vendor: "1 42501 42501 1 0 0 0 0",
    contact: "1 42501 42501 1 0 0 0 0",
    isa: "1 42501 42501 1 0 0 0 0",
    no_user_type: "1 42501 42501 1 0 0 0 0",
    other_tenant_broker: "1 1 42501 1 0 0 0 0",
    anon: "42501 42501 42501 42501 0 0 0 0",
  } as Record<string, string>,
  proposed: {
    broker: "1 1 42501 42501 1 0 1 1",
    broker_owner: "1 1 42501 42501 1 0 1 1",
    broker_admin: "1 1 42501 42501 1 0 1 1",
    admin: "1 1 42501 42501 1 0 1 1",
    compliance_officer: "1 1 42501 42501 1 0 1 1",
    tc: "1 1 42501 42501 1 0 1 1",
    agent_on_deal: "1 1 42501 42501 1 42501 1 2",
    buyer_side_agent: "1 1 42501 42501 1 42501 1 2",
    team_lead_not_on_deal: "42501 42501 42501 42501 0 0 0 0",
    agent_off_deal: "42501 42501 42501 42501 0 0 0 0",
    vendor: "42501 42501 42501 42501 0 0 0 0",
    contact: "42501 42501 42501 42501 0 0 0 0",
    isa: "42501 42501 42501 42501 0 0 0 0",
    no_user_type: "42501 42501 42501 42501 0 0 0 0",
    other_tenant_broker: "42501 42501 42501 1 0 0 0 0",
    anon: "42501 42501 42501 42501 0 0 0 0",
  } as Record<string, string>,
}
/** The measured seat names → this guard's fixture users (null = no session). */
const PG_SEAT: Record<string, string | null> = { broker: U_BROKER, broker_owner: U_OWNER, broker_admin: U_BADMIN, admin: U_ADMIN, compliance_officer: U_CO, tc: U_TC, agent_on_deal: U_AGENT, buyer_side_agent: U_BUYSIDE, team_lead_not_on_deal: U_LEAD, agent_off_deal: U_AGENT2, vendor: U_VENDOR, contact: U_CONTACT, isa: U_ISA, no_user_type: U_NOTYPE, other_tenant_broker: U_X, anon: null }

/** The same eight operations through the MODEL, on transaction_participants (P1 = stamped row, P_OLD = never stamped, TX_X = B2's deal). */
async function modelOutcomes(seat: string | null, mode: "live" | "proposed"): Promise<string> {
  const t = "transaction_participants"
  const run = async (fn: (sess: any, tenant: string | null) => PromiseLike<any>, kind: "insert" | "count"): Promise<string> => {
    const m = underPolicies(seat, mode)
    const r = await fn(G.__DD.sess(), T(m, "users").find((x) => x.id === seat)?.brokerage_id ?? null)
    return r.error ? String(r.error.code) : kind === "insert" ? "1" : String((r.data ?? []).length)
  }
  return [
    await run((s, ten) => s.from(t).insert({ transaction_id: TX1, brokerage_id: ten }), "insert"),
    await run((s, ten) => s.from(t).insert({ transaction_id: TX1, brokerage_id: ten }).select().single(), "insert"),
    await run((s) => s.from(t).insert({ transaction_id: TX1, brokerage_id: null }), "insert"),
    await run((s, ten) => s.from(t).insert({ transaction_id: TX_X, brokerage_id: ten }), "insert"),
    await run((s) => s.from(t).update({ note: "u" }).eq("id", P1).select("id"), "count"),
    await run((s) => s.from(t).update({ note: "u" }).eq("id", P_OLD).select("id"), "count"),
    await run((s) => s.from(t).delete().eq("id", P1).select("id"), "count"),
    await run((s) => s.from(t).select("id").eq("transaction_id", TX1), "count"),
  ].join(" ")
}

// ── the census: every write statement on the five tables, and the client its receiver is bound to ──
type SiteClass = { cls: "service" | "desk" | "session" | "handed" | "unknown"; how: string; fn?: string }
const lastMatch = (text: string, re: RegExp): RegExpExecArray | null => { let m: RegExpExecArray | null, last: RegExpExecArray | null = null; while ((m = re.exec(text))) last = m; return last }
/** PURE — the client a receiver name is bound to at one position: the NEAREST PRECEDING declaration or parameter of that name. */
function classifyReceiver(src: string, at: number, recv: string, depth = 0): SiteClass {
  if (/createServiceClient\(\)$/.test(recv)) return { cls: "service", how: "createServiceClient() inline" }
  const base = recv.split(".")[0]
  const before = src.slice(0, at)
  const bind = lastMatch(before, new RegExp(`(?:const|let|var)\\s+(?:\\{[^}=]*\\b${base}\\b[^}=]*\\}|${base})\\s*(?::[^=\\n]+)?=\\s*([^\\n]+)`, "g"))
  const param = lastMatch(before, new RegExp(`function\\s+(\\w+)\\s*\\(([^)]*?\\b${base}\\b\\s*[:,)=?][^)]*|[^)]*?\\b${base}\\b)\\)`, "g"))
  if (param && (!bind || param.index > bind.index)) return { cls: "handed", how: `parameter of ${param[1]}`, fn: param[1] }
  if (!bind) return { cls: "unknown", how: `no declaration of ${base}` }
  const rhs = bind[1]
  if (/createServiceClient\(/.test(rhs)) return { cls: "service", how: "createServiceClient()" }
  if (/dealDeskWriteContext\(|dealDeskFor\(/.test(rhs)) return { cls: "desk", how: "the deal desk's client" }
  if (/createClient\(|createServerClient\(/.test(rhs)) return { cls: "session", how: "createClient()" }
  if (/actingWriteContext\(|resolveWriteContext(?:ForTenant)?\(/.test(rhs)) return { cls: "session", how: "the write seam (the session client unless a full grant)" }
  const via = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\.(?:db|supabase|client)\b/.exec(rhs)
  if (via && depth < 3) return classifyReceiver(src, bind.index, via[1], depth + 1)
  return { cls: "unknown", how: `bound to: ${rhs.slice(0, 60)}` }
}
function tsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = `${dir}/${e}`
    if (statSync(join(ROOT, p)).isDirectory()) tsFiles(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
type WriteSite = { file: string; line: number; table: string; verb: string; recv: string } & SiteClass
/** PURE over one file's comment-stripped source. */
function writeSitesOf(file: string, src: string): WriteSite[] {
  const out: WriteSite[] = []
  const re = new RegExp(`((?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*|\\)))\\s*\\.from\\(\\s*["'\`](${[...POLICY_TABLES].join("|")})["'\`]\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const end = src.indexOf("\n\n", m.index)
    const verb = /\.(insert|update|upsert|delete)\s*\(/.exec(src.slice(m.index, end < 0 ? m.index + 600 : Math.min(end, m.index + 900)))
    if (!verb) continue
    let recv = m[1]
    if (recv === ")") recv = (/([\w$.()"'@\/\s-]{0,80}\))$/.exec(src.slice(0, m.index + 1))?.[1] ?? ")").replace(/\s+/g, "")
    out.push({ file, line: src.slice(0, m.index).split("\n").length, table: m[2], verb: verb[1], recv, ...classifyReceiver(src, m.index, recv) })
  }
  return out
}
/** Split on top-level commas. `generics` also treats `<…>` as a bracket (a parameter list: `Record<string, unknown>`), never `=>`. */
function splitTopLevel(text: string, generics = false): string[] {
  const out: string[] = []; let depth = 0, cur = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ("([{".includes(ch) || (generics && ch === "<")) depth++
    if (")]}".includes(ch) || (generics && ch === ">" && text[i - 1] !== "=")) depth--
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = "" } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
function parenBody(src: string, open: number): string { let depth = 0; for (let i = open; i < src.length; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") { depth--; if (depth === 0) return src.slice(open + 1, i) } } return "" }

async function sectionF() {
  section("§F · the insert side of the policies (measured on PostgreSQL) and the census that makes the fix safe to run")
  // ── THE MODEL IS THAT ENGINE ON THOSE CASES ──
  for (const mode of ["live", "proposed"] as const) {
    const diff: string[] = []
    for (const [name, seat] of Object.entries(PG_SEAT)) { const got = await modelOutcomes(seat, mode); if (got !== PG_MEASURED[mode][name]) diff.push(`${name}: model "${got}" ≠ ${PG_MEASURED.engine} "${PG_MEASURED[mode][name]}"`) }
    check(`the policy model reproduces every cell measured on ${PG_MEASURED.engine} — ${mode.toUpperCase()} policies, ${Object.keys(PG_SEAT).length} seats × ${PG_MEASURED.cases.length} operations`, diff.length === 0 && Object.keys(PG_MEASURED[mode]).length === Object.keys(PG_SEAT).length, diff)
  }
  const crossed = Object.entries(PG_SEAT).length > 0 ? (await Promise.all(Object.entries(PG_SEAT).map(async ([name, seat]) => (await modelOutcomes(seat, "live")) !== PG_MEASURED.proposed[name]))).filter(Boolean).length : 0
  check("control · the comparison is not vacuous: the LIVE model does NOT reproduce the PROPOSED table", crossed > 0, crossed)
  const cell = (mode: "live" | "proposed", seat: string, op: string) => PG_MEASURED[mode][seat].split(" ")[PG_MEASURED.cases.indexOf(op)]
  const outsiders = ["team_lead_not_on_deal", "agent_off_deal", "vendor", "contact", "isa", "no_user_type"]
  // The six desk seats come from the ONE list the proposed policy names (PROPOSED_SEATS) — they are users.user_type values, and
  // the measured rows carry the same names. The two on-deal rows are measurement LABELS, kept apart so no array reads as a roster.
  const onDealLabels = ["agent_on_deal", "buyer_side_agent"]
  const insiders = [...PROPOSED_SEATS, ...onDealLabels]
  check("THE HOLE, as measured: under the LIVE policies a vendor, a contact, an ISA, an agent off the deal, a team lead and a seat with no type each INSERT on their tenant's deal AND on another tenant's deal",
    outsiders.every((s) => cell("live", s, "insert_b1_deal") === "1" && cell("live", s, "insert_b2_deal") === "1"), outsiders.map((s) => `${s}:${cell("live", s, "insert_b1_deal")}/${cell("live", s, "insert_b2_deal")}`))
  check("…CLOSED, as measured: under the PROPOSED policies each of them is refused (42501) on both; an anonymous caller too; another tenant's broker cannot insert on this tenant's deal",
    [...outsiders, "anon"].every((s) => cell("proposed", s, "insert_b1_deal") === "42501" && cell("proposed", s, "insert_b2_deal") === "42501") && cell("proposed", "other_tenant_broker", "insert_b1_deal") === "42501")
  check("…and nothing a deal's own seats do is refused: an agent on the deal and the six desk seats insert, update and delete on their tenant's deal — and NONE of them can insert on another tenant's deal",
    insiders.every((s) => cell("proposed", s, "insert_b1_deal") === "1" && cell("proposed", s, "insert_b1_deal_returning") === "1" && cell("proposed", s, "update_row") === "1" && cell("proposed", s, "delete_row") === "1" && cell("proposed", s, "insert_b2_deal") === "42501"),
    insiders.map((s) => `${s}:${PG_MEASURED.proposed[s]}`))
  check("…and no row a seat reads today disappears (USING is not narrowed): every seat sees at least as many rows after as before",
    Object.keys(PG_SEAT).every((s) => Number(cell("proposed", s, "rows_visible_on_b1_deal")) >= Number(cell("live", s, "rows_visible_on_b1_deal"))))
  if (ROOT === WT) {
    const doc = raw("docs/operations/OWNER-SQL.md", WT)
    const sec = doc.includes("### R.6 ") ? doc.slice(doc.indexOf("### R.6 ")) : ""
    const blockAt = sec.indexOf("```sql"), block = blockAt < 0 ? "" : sec.slice(blockAt + 6, sec.indexOf("```", blockAt + 6))
    const measured = block.includes("begin;") && block.includes("commit;") ? block.slice(block.indexOf("begin;"), block.indexOf("commit;") + "commit;".length) : ""
    const sha = createHash("sha256").update(measured.replace(/\s+/g, " ").trim()).digest("hex")
    check("THE MEASURED TEXT IS THE PUBLISHED TEXT: the ALTER POLICY block of OWNER-SQL.md §R.6 has the fingerprint PG_MEASURED was measured with (edit the SQL → measure again with scripts/deal-table-policy-measure.py)",
      measured.length > 0 && sha === PG_MEASURED.proposedSqlSha256, { sha: sha.slice(0, 16), expected: PG_MEASURED.proposedSqlSha256.slice(0, 16) })
    check("…the block alters exactly the two policies of each of the five tables, and nothing in it is destructive", [...POLICY_TABLES].every((t) => new RegExp(`alter policy trx_agent_${t} on public\\.${t}\\b`).test(measured) && new RegExp(`alter policy trx_broker_${t} on public\\.${t}\\b`).test(measured))
      && (measured.match(/alter policy /g) ?? []).length === POLICY_TABLES.size * 2 && !/\b(drop|delete|truncate|grant|revoke|create)\b/i.test(measured), (measured.match(/alter policy /g) ?? []).length)
  }

  // ── THE CENSUS ──
  const sources = [...tsFiles("app"), ...tsFiles("lib")].map((f) => [f, stripComments(raw(f))] as const)
  const sites = sources.flatMap(([f, src]) => writeSitesOf(f, src))
  const byClass = (c: SiteClass["cls"]) => sites.filter((s) => s.cls === c)
  console.log(`    (published) ${sites.length} write statements on the five tables in ${new Set(sites.map((s) => s.file)).size} files of app/ and lib/: ${byClass("service").length} service client · ${byClass("desk").length} the deal desk's client · ${byClass("handed").length} handed their client · ${byClass("session").length} session client · ${byClass("unknown").length} unresolved`)
  check("the census is not empty and every receiver resolved (an unresolved client fails here rather than passing as fine)", sites.length > 0 && byClass("unknown").length === 0, byClass("unknown").map((s) => `${s.file}:${s.line} ${s.recv} — ${s.how}`))
  // A session-client site is allowed only in a module NOTHING imports — derived, and named.
  const importersOf = (file: string): string[] => {
    const noExt = file.replace(/\.(ts|tsx)$/, ""), base = noExt.split("/").pop()!, dir = noExt.split("/").slice(0, -1).join("/")
    return sources.filter(([f, src]) => f !== file && (src.includes(`"@/${noExt}"`) || src.includes(`'@/${noExt}'`) || (f.startsWith(dir + "/") && !f.slice(dir.length + 1).includes("/") && new RegExp(`["']\\./${base.replace(/[.]/g, "\\.")}["']`).test(src)))).map(([f]) => f)
  }
  const reachable = (file: string): boolean => importersOf(file).some((imp) => {
    if (!/\/index\.tsx?$/.test(imp)) return true
    const dir = imp.replace(/\/index\.tsx?$/, "")
    return sources.some(([f, src]) => f !== imp && (src.includes(`"@/${dir}"`) || src.includes(`'@/${dir}'`)))
  })
  const sessionLive = byClass("session").filter((s) => reachable(s.file))
  const sessionDead = byClass("session").filter((s) => !reachable(s.file))
  check("NO write on the five tables rides a session client from code anything can reach — so the policy change can refuse none of the application's own writes", sessionLive.length === 0, sessionLive.map((s) => `${s.file}:${s.line} ${s.table} ${s.verb} via ${s.how}`))
  if (sessionDead.length) console.log(`    (published) session-client sites in a module nothing imports — unreachable, and their insert carries no tenant, so both policy sets refuse it: ${sessionDead.map((s) => `${s.file}:${s.line}`).join(", ")}`)
  // A handed client is traced to every caller — and a caller that is itself handed it, to ITS callers (two levels up at most;
  // deeper, or a call with nothing at the client's position, fails rather than passes).
  const handsOf = (fn: string, paramName: string, depth = 0): { bad: string[]; calls: number } => {
    const decl = sources.map(([f, src]) => ({ f, src, m: new RegExp(`function\\s+${fn}\\s*\\(`).exec(src) })).find((x) => x.m)
    if (!decl) return { bad: [`${fn}: declaration not found`], calls: 0 }
    const idx = splitTopLevel(parenBody(decl.src, decl.m!.index + decl.m![0].length - 1), true).findIndex((p) => new RegExp(`^${paramName}\\b`).test(p))
    if (idx < 0) return { bad: [`${fn}: no parameter named ${paramName}`], calls: 0 }
    const bad: string[] = []; let calls = 0
    for (const [f, src] of sources) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, "g"); let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue
        calls++
        const arg = (splitTopLevel(parenBody(src, m.index + m[0].length - 1))[idx] ?? "").replace(/\s+as\s+\w+$/, "").trim()
        const c: SiteClass = arg ? classifyReceiver(src, m.index, arg) : { cls: "unknown", how: "nothing at the client's position" }
        if (c.cls === "service" || c.cls === "desk") continue
        if (c.cls === "handed" && depth < 2) { bad.push(...handsOf(c.fn!, arg.split(".")[0], depth + 1).bad); continue }
        bad.push(`${fn} ← ${f}:${src.slice(0, m.index).split("\n").length} hands it "${arg}" (${c.cls}: ${c.how})`)
      }
    }
    return { bad, calls }
  }
  const handedFns = [...new Set(byClass("handed").map((s) => s.fn!))]
  const badHands: string[] = [], hands: string[] = []
  for (const fn of handedFns) {
    const r = handsOf(fn, byClass("handed").find((s) => s.fn === fn)!.recv.split(".")[0])
    badHands.push(...r.bad); hands.push(`${fn} ← ${r.calls} call(s)`)
  }
  console.log(`    (published) handed sinks: ${hands.join(" · ") || "none"}`)
  check("every function that is HANDED its client for one of these writes is handed the service client (or the deal desk's) at every call site", badHands.length === 0, badHands)
  check("control · the handed trace is not vacuous: there is at least one handed sink, every one has a caller, and a caller's session client would be named",
    handedFns.length > 0 && hands.every((h) => !/← 0 call/.test(h)) && splitTopLevel("a: Record<string, unknown>, cb: (x: number) => void, svc: Svc", true).length === 3 && classifyReceiver(`const supabase = await createClient()\n  await planted(supabase, 1)`, 45, "supabase").cls === "session", hands)
  // CONTROLS for the census.
  const spec = (decl: string) => writeSitesOf("planted.ts", `${decl}\n  await supabase.from("transaction_timeline").insert({ a: 1 })\n\n`)[0]
  check("CENSUS CONTROLS — a session client, the write seam, the service client, the desk's client and a parameter are each recognised; a write named only in a comment is not a site; a read is not a site",
    spec("const supabase = await createClient()")?.cls === "session" && spec("const gate = await actingWriteContext()\n  const supabase = gate.db")?.cls === "session"
    && spec("const supabase = createServiceClient()")?.cls === "service" && spec("const gate = await dealDeskWriteContext({ transactionId })\n  const supabase = gate.db")?.cls === "desk"
    && spec("async function planted(supabase: any) {")?.cls === "handed" && spec("const other = 1")?.cls === "unknown"
    && writeSitesOf("planted.ts", stripComments(`// await supabase.from("transaction_timeline").insert({ a: 1 })\n\n`)).length === 0
    && writeSitesOf("planted.ts", `const supabase = await createClient()\n  await supabase.from("transaction_timeline").select("*")\n\n`).length === 0)

  // ── THE DOORS THAT RODE A SESSION CLIENT — source rules ──
  const insp = stripComments(raw("app/actions/transaction-inspections.ts")), em = fnWhole(insp, "updateEarnestMoneyAction")
  const firstWrite = em.search(/\.(?:insert|update|upsert|delete)\s*\(/)
  check("updateEarnestMoneyAction asks the deal desk before any write and returns its refusal; its update is pinned to the deal and the session's tenant and COUNTED; its insert stamps both after the patch",
    em.indexOf("decideDealDesk(") >= 0 && em.indexOf("decideDealDesk(") < firstWrite && /if\s*\(\s*!\s*desk\.allowed\s*\)\s*return/.test(em) && !/await createClient\(/.test(em)
    && /\.update\(updates\)\s*\.eq\("id", params\.titleEscrowId\)\.eq\("transaction_id", params\.transactionId\)\.eq\("brokerage_id", auth\.brokerageId\)\.select\("id"\)/.test(em) && /\(saved \?\? \[\]\)\.length !== 1/.test(em)
    && em.indexOf("...updates") >= 0 && em.indexOf("...updates") < em.indexOf("brokerage_id:   auth.brokerageId"), em.slice(0, 160))
  const coord = stripComments(raw("app/actions/ai-transaction-coordinator.ts")), pd = coord.slice(Math.max(0, coord.indexOf("export async function predictAndManageDeadlines(")), coord.indexOf("\nexport async function ", coord.indexOf("export async function predictAndManageDeadlines(") + 10))
  const scopeAt = pd.indexOf("scopeTransaction("), modelAt = pd.search(/\b(?:bookedGenerateObject|generateText|generateObject)\s*\(/), insertAt = pd.indexOf('.from("transaction_deadlines").insert(')
  check("predictAndManageDeadlines passes the file's one gate (the deal desk, §G) BEFORE the model is reached and before any deadline is written, returns its refusal, and inserts on a service client opened only after it, with the deal and the session's tenant",
    scopeAt >= 0 && modelAt > scopeAt && insertAt > scopeAt && /if\s*\(\s*!\s*scope\.ok\s*\)\s*return/.test(pd) && pd.indexOf("if (!scope.ok) return") < modelAt
    && /await svc\.from\("transaction_deadlines"\)\.insert\(/.test(pd) && /const svc = \(await import\("@\/lib\/supabase\/service"\)\)\.createServiceClient\(\)/.test(pd) && pd.indexOf("const svc = ") > pd.indexOf("if (!scope.ok) return") && /brokerage_id:\s*scope\.brokerageId/.test(pd), { scopeAt, modelAt, insertAt })
  const closing = stripComments(raw("app/actions/ai-closing-workflow.ts")), vm = stripComments(raw("app/actions/vendor-marketplace.ts"))
  check("the AI closing analysis and the vendor booking write no timeline row themselves any more — both hand the line to the ONE timeline writer, which asks the deal desk for that deal",
    !/\.from\(\s*"transaction_timeline"\s*\)/.test(closing) && /\baddTimelineEntry\s*\(/.test(closing) && !/\.from\(\s*"transaction_timeline"\s*\)/.test(vm) && /\baddTimelineEntry\s*\(/.test(vm))

  // ── DRIVEN under BOTH policy modes: the deal-detail doors, the earnest-money door, the one timeline writer ──
  const act = await load(DEAL_ACTIONS)
  await driveDetailDoors(act, "proposed")
  const svc = await load(SERVICE)
  let inspections: any = null
  try { inspections = await quiet(() => load("app/actions/transaction-inspections.ts")) } catch (e) { check("app/actions/transaction-inspections.ts loads in the harness", false, (e as Error)?.message?.slice(0, 300)) }
  for (const mode of ["live", "proposed"] as const) {
    const lineBad: string[] = [], lineLeak: string[] = []
    for (const [seat, label] of DESK_SEATS) {
      const m = underPolicies(seat, mode)
      const x = await drive(() => svc.addTimelineEntry(TX1, "note", "a line", seat, { k: 1 }))
      const rows = T(m, "transaction_timeline")
      if (!((x.r as any)?.ok === true && rows.length === 1 && rows[0].transaction_id === TX1 && rows[0].brokerage_id === B1 && rows[0].performed_by === seat)) lineBad.push(`${label}: ${JSON.stringify(x.r ?? x.threw)?.slice(0, 120)}`)
    }
    for (const [seat, label] of [...OFF_DESK_SEATS, [U_BROKER, "this tenant's broker, on ANOTHER tenant's deal"] as [string, string]]) {
      const m = underPolicies(seat, mode)
      const x = await drive(() => svc.addTimelineEntry(label.includes("ANOTHER") ? TX_X : TX1, "note", "a planted line"))
      if ((x.r as any)?.ok !== false || T(m, "transaction_timeline").length !== 0) lineLeak.push(label)
    }
    check(`addTimelineEntry [${mode.toUpperCase()} policies]: each of the ${DESK_SEATS.length} desk seats' line lands on the deal with the session's tenant and the actor it was given`, lineBad.length === 0, lineBad)
    check(`NEG addTimelineEntry [${mode.toUpperCase()} policies]: a seat the desk refuses, and a deal of another tenant, get NO line — and the caller is told (ok: false)`, lineLeak.length === 0, lineLeak)
    if (!inspections || typeof inspections.updateEarnestMoneyAction !== "function") continue
    const emBad: string[] = [], emLeak: string[] = []
    for (const [seat, label] of DESK_SEATS) {
      let m = underPolicies(seat, mode)
      const upd = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX1, brokerageId: B1, titleEscrowId: E1, earnestMoneyAmount: 5000 }))
      const okUpd = (upd.r as any)?.success === true && T(m, "transaction_title_escrow").find((r) => r.id === E1)?.earnest_money_amount === 5000
      m = underPolicies(seat, mode)
      const ins = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX2, earnestMoneyAmount: 7000, earnestMoneyHeldBy: "First Title" }))
      const made = T(m, "transaction_title_escrow").filter((r) => r.transaction_id === TX2)
      const okIns = (ins.r as any)?.success === true && made.length === 1 && made[0].brokerage_id === B1 && made[0].earnest_money_amount === 7000
      if (!okUpd || !okIns) emBad.push(`${label}: update ${okUpd ? "ok" : JSON.stringify(upd.r ?? upd.threw)?.slice(0, 90)} · insert ${okIns ? "ok" : JSON.stringify(ins.r ?? ins.threw)?.slice(0, 90)}`)
    }
    for (const [seat, label] of OFF_DESK_SEATS) {
      const m = underPolicies(seat, mode), was = detailState(m)
      const upd = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX1, titleEscrowId: E1, earnestMoneyAmount: 1 }))
      const ins = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX2, earnestMoneyAmount: 1 }))
      if (!refused(upd) || !refused(ins) || detailState(m) !== was) emLeak.push(`${label}: ${detailState(m) !== was ? "ROWS CHANGED" : "rows unchanged"} ${JSON.stringify(upd.r ?? upd.threw)?.slice(0, 80)}`)
    }
    const m = underPolicies(U_BROKER, mode), was = detailState(m)
    const cross = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX1, titleEscrowId: E_X, earnestMoneyAmount: 1 }))
    const crossDeal = await drive(() => inspections.updateEarnestMoneyAction({ transactionId: TX_X, earnestMoneyAmount: 1 }))
    check(`updateEarnestMoneyAction [${mode.toUpperCase()} policies]: each of the ${DESK_SEATS.length} desk seats saves the amount on the existing record and creates the record on a deal that has none — in the session's tenant`, emBad.length === 0, emBad)
    check(`NEG updateEarnestMoneyAction [${mode.toUpperCase()} policies]: each of the ${OFF_DESK_SEATS.length} seats the desk refuses is refused with the tables unchanged; a broker cannot reach another tenant's record or deal`, emLeak.length === 0 && refused(cross) && refused(crossDeal) && detailState(m) === was, { emLeak, cross: cross.r, crossDeal: crossDeal.r })
  }
}

// ═══ §G — the AI deal doors ════════════════════════════════════════════════════════════════════════════════════════════
const COORD = "app/actions/ai-transaction-coordinator.ts", CLOSING = "app/actions/ai-closing-workflow.ts"
const MODEL_CALL = /\b(?:generateObject|generateText)\s*\(/
/** A door that scans a BOOK, not one deal — named, with the rule it is held to instead (not an exemption). */
const BOOK_DOORS: Record<string, string> = { monitorTransactionRisks: "it scans an agent's in-escrow book: the desk is asked per deal, only the deals it admits reach the model, and the write-back is pinned to them" }
/** PURE — problems with one AI deal door's comment-stripped source (empty = the rule holds). */
function aiDoorProblems(name: string, body: string): string[] {
  const out: string[] = []
  const modelAt = body.search(MODEL_CALL), writeAt = body.search(/\.(?:insert|update|upsert|delete)\s*\(/)
  const firstEffect = Math.min(...[modelAt, writeAt].filter((i) => i >= 0), Infinity)
  const scopeAt = body.search(/\bscopeTransaction\s*\(/), deskAt = body.search(/\bdecideDealDesk\s*\(/)
  if (BOOK_DOORS[name]) {
    if (deskAt < 0 || deskAt > firstEffect) out.push("does not ask the deal desk before the model / a write")
    if (!/\(await decideDealDesk\([\s\S]*?\)\)\.allowed\)\s*transactions\.push\(/.test(body)) out.push("the list the model sees is not the desk-admitted one")
    const emptyAt = body.search(/if\s*\(\s*transactions\.length\s*===\s*0\s*\)\s*return/)
    if (emptyAt < 0 || (modelAt >= 0 && emptyAt > modelAt)) out.push("an empty admitted set does not return before the model")
    if (writeAt >= 0 && !/\.in\(\s*"id"\s*,\s*transactions\.map\(/.test(body)) out.push("the write-back is not pinned to the admitted deals")
    return out
  }
  const gateAt = scopeAt >= 0 ? scopeAt : deskAt
  if (gateAt < 0) return ["does not reach the deal desk (neither the file's gate nor decideDealDesk)"]
  if (gateAt > firstEffect) out.push("reaches a model or writes BEFORE the desk")
  const refAt = body.search(scopeAt >= 0 ? /if\s*\(\s*!\s*scope\.ok\s*\)\s*return/ : /if\s*\(\s*!\s*desk\.allowed\s*\)\s*return/)
  if (refAt < 0) out.push("the desk's refusal is not returned")
  else if (refAt > firstEffect) out.push("the refusal is returned only AFTER a model call or a write")
  return out
}
/** How each derived door is called, and what the stubbed model's answer lets it do. `reach` = a desk seat is shown reaching the model seam. */
const AI_DOORS: Record<string, { file: string; call: (m: any) => Promise<any>; reach: boolean }> = {
  analyzeTransactionHealth: { file: COORD, call: (m) => m.analyzeTransactionHealth({ transactionId: TX1 }), reach: true },
  predictAndManageDeadlines: { file: COORD, call: (m) => m.predictAndManageDeadlines({ transactionId: TX1 }), reach: true },
  generateSmartTasks: { file: COORD, call: (m) => m.generateSmartTasks({ transactionId: TX1 }), reach: true },
  draftTransactionCommunication: { file: COORD, call: (m) => m.draftTransactionCommunication({ transactionId: TX1, recipientRole: "buyer", communicationType: "update" }), reach: true },
  listTransactionCommunications: { file: COORD, call: (m) => m.listTransactionCommunications(TX1), reach: false },
  sendTransactionCommunication: { file: COORD, call: (m) => m.sendTransactionCommunication({ transactionId: TX1, communicationId: u("7", 1), finalContent: "hello" }), reach: false },
  generatePostClosingPlan: { file: COORD, call: (m) => m.generatePostClosingPlan({ transactionId: TX1 }), reach: true },
  monitorTransactionRisks: { file: COORD, call: (m) => m.monitorTransactionRisks(AG_A), reach: true },
  aiGenerateClosingChecklist: { file: CLOSING, call: (m) => m.aiGenerateClosingChecklist({ transactionId: TX1, agentId: AG_A, brokerageId: B1 }), reach: true },
  aiTrackClosingMilestones: { file: CLOSING, call: (m) => m.aiTrackClosingMilestones({ transactionId: TX1 }), reach: true },
}
/** Exports of the two files that are NOT AI deal doors — derived, and each named with why it was left. */
const LEFT_AS_IS: Record<string, string> = {
  getClosingChecklist: "a READ on the caller's row-security client — no model, no write",
  getClosingPrepSummary: "a READ on the caller's row-security client — no model, no write",
  completeChecklistItem: "a checklist tick on the write seam's client — no model is reached; row security decides the seat",
}

async function sectionG() {
  section("§G · the AI deal doors — the deal desk before any model call or write")
  const srcs: Record<string, string> = { [COORD]: stripComments(raw(COORD)), [CLOSING]: stripComments(raw(CLOSING)) }
  const isDoor = (file: string, n: string) => { const b = fnWhole(srcs[file], n); return MODEL_CALL.test(b) || /\bscopeTransaction\s*\(/.test(b) }
  const derived = Object.keys(srcs).flatMap((f) => exportedActions(srcs[f]).filter((n) => isDoor(f, n)).map((n) => [f, n] as const))
  const left = Object.keys(srcs).flatMap((f) => exportedActions(srcs[f]).filter((n) => !isDoor(f, n)))
  const undriven = derived.filter(([, n]) => !AI_DOORS[n]).map(([, n]) => n), stale = Object.keys(AI_DOORS).filter((n) => !derived.some(([f, d]) => d === n && f === AI_DOORS[n].file))
  check(`the AI deal doors are derived, not listed: ${derived.length} exported actions of the two files reach a model or the shared gate, and every one is driven below`, derived.length > 0 && undriven.length === 0 && stale.length === 0, { derived: derived.map(([, n]) => n), undriven, stale })
  check(`…and the ${left.length} exports that are NOT doors are each named with the reason they were left (none reaches a model)`, left.length > 0 && left.every((n) => !!LEFT_AS_IS[n]) && Object.keys(LEFT_AS_IS).every((n) => left.includes(n)), { left, named: Object.keys(LEFT_AS_IS) })
  console.log(`    (published) left as is: ${left.map((n) => `${n} — ${LEFT_AS_IS[n] ?? "UNNAMED"}`).join(" · ")}`)
  for (const [f, n] of derived) {
    const p = aiDoorProblems(n, fnWhole(srcs[f], n))
    check(`${n}: ${BOOK_DOORS[n] ? `the book rule — ${BOOK_DOORS[n]}` : "reaches the deal desk and returns its refusal before the first model call and before any write"}`, p.length === 0, p)
  }
  const st = fnWhole(srcs[COORD], "scopeTransaction")
  check("scopeTransaction (the coordinator file's ONE gate) is not exported, asks decideDealDesk with the SESSION's seat and tenant, returns its refusal, and no longer reads the deal on the caller's client",
    st.length > 0 && !/^export\s+async\s+function\s+scopeTransaction\b/m.test(srcs[COORD]) && /decideDealDesk\(\s*\{[^}]*role:\s*ctx\.userType[^}]*brokerageId:\s*ctx\.brokerageId/.test(st)
    && /if\s*\(\s*!\s*desk\.allowed\s*\)\s*return\s*\{\s*ok:\s*false/.test(st) && st.indexOf("decideDealDesk(") < st.lastIndexOf("ok: true") && !/\.from\s*\(/.test(st) && !/\bcreateClient\s*\(/.test(st), st.slice(0, 200))
  const good = `export async function planted(params: P) {\n  const scope = await scopeTransaction(params.transactionId)\n  if (!scope.ok) return { success: false, error: scope.error }\n  const { object } = await generateObject({ prompt: "x" })\n  await supabase.from("transaction_tasks").insert({ a: 1 })\n  return { success: true }\n}\n`
  const direct = good.replace("const scope = await scopeTransaction(params.transactionId)", "const desk = await decideDealDesk({ transactionId: params.transactionId })").replace("if (!scope.ok) return { success: false, error: scope.error }", "if (!desk.allowed) return { success: false, error: desk.reason }")
  const book = `export async function monitorTransactionRisks(agentId: string) {\n  const transactions: any[] = []; for (const t of readable ?? []) if ((await decideDealDesk({ transactionId: t.id })).allowed) transactions.push(t)\n  if (transactions.length === 0) return { success: true }\n  const { object } = await generateObject({ prompt: "x" })\n  await supabase.from("transactions").update({ a: 1 }).eq("id", r.id).in("id", transactions.map((t) => t.id))\n}\n`
  check("§G CONTROLS — a well-formed door passes through the file's gate and through the desk directly; no gate, a model call before the gate, a write before it, an unreturned refusal and a refusal returned only after the model are each caught; the book rule catches an unfiltered list, a model call on an empty set and an unpinned write-back; a gate named only in a comment is not a gate",
    aiDoorProblems("planted", good).length === 0 && aiDoorProblems("planted", direct).length === 0 && aiDoorProblems("monitorTransactionRisks", book).length === 0
    && aiDoorProblems("planted", good.replace(/  const scope[^\n]*\n[^\n]*\n/, "")).some((p) => /does not reach/.test(p))
    && aiDoorProblems("planted", good.replace("  const scope", `  const { object: early } = await generateObject({ prompt: "x" })\n  const scope`)).some((p) => /BEFORE the desk/.test(p))
    && aiDoorProblems("planted", good.replace("  const scope", `  await supabase.from("t").delete()\n  const scope`)).some((p) => /BEFORE the desk/.test(p))
    && aiDoorProblems("planted", good.replace(/  if \(!scope\.ok\)[^\n]*\n/, "")).some((p) => /not returned/.test(p))
    && aiDoorProblems("planted", good.replace(/  if \(!scope\.ok\)[^\n]*\n/, "").replace("  return { success: true }", "  if (!scope.ok) return { success: false }\n  return { success: true }")).some((p) => /only AFTER/.test(p))
    && aiDoorProblems("monitorTransactionRisks", book.replace(/if \(\(await decideDealDesk\([^\n]*\)\)\.allowed\) /, "")).some((p) => /not the desk-admitted/.test(p))
    && aiDoorProblems("monitorTransactionRisks", book.replace(/  if \(transactions\.length === 0\)[^\n]*\n/, "")).some((p) => /empty admitted set/.test(p))
    && aiDoorProblems("monitorTransactionRisks", book.replace('.in("id", transactions.map((t) => t.id))', "")).some((p) => /not pinned/.test(p))
    && aiDoorProblems("planted", stripComments(good.replace(/  const scope[^\n]*\n[^\n]*\n/, "  // const scope = await scopeTransaction(params.transactionId)\n"))).some((p) => /does not reach/.test(p)))

  // ── DRIVEN: the model seam is a counted stub — a provider is never reached ──
  const mods: Record<string, any> = {}
  for (const f of Object.keys(srcs)) { try { mods[f] = await quiet(() => load(f)) } catch (e) { check(`${f} loads in the harness`, false, (e as Error)?.message?.slice(0, 300)) } }
  const receiptOnly = (m: MemClient) => m.writes.filter((w) => w.table !== "agent_action_ledger")
  for (const [door, d] of Object.entries(AI_DOORS)) {
    const mod = mods[d.file]
    if (!mod || typeof mod[door] !== "function") { check(`${door} exists on ${d.file}`, false); continue }
    const spent: string[] = []
    for (const [seat, label] of OFF_DESK_SEATS) {
      const m = as(seat)
      const x = await drive(() => d.call(mod))
      const answeredNo = BOOK_DOORS[door] ? (refused(x) || ((x.r as any)?.success === true && !(x.r as any)?.riskAnalysis)) : refused(x)
      if (G.__DD.calls.model !== 0 || receiptOnly(m).length !== 0 || !answeredNo) spent.push(`${label}: model=${G.__DD.calls.model} writes=${receiptOnly(m).map((w) => `${w.op} ${w.table}`).join(",") || 0} answered ${JSON.stringify(x.r ?? x.threw)?.slice(0, 110)}`)
    }
    check(`NEG ${door}: each of the ${OFF_DESK_SEATS.length} seats the desk refuses reaches NO model and writes nothing (a vendor assigned to the deal included)`, spent.length === 0, spent)
    if (!d.reach) continue
    const stopped: string[] = []
    for (const [seat, label] of DESK_SEATS) {
      as(seat)
      const x = await drive(() => d.call(mod))
      if (G.__DD.calls.model < 1) stopped.push(`${label}: ${JSON.stringify(x.r ?? x.threw)?.slice(0, 140)}`)
    }
    check(`${door}: each of the ${DESK_SEATS.length} seats the desk admits passes the gate — the model seam is reached (counted, never a provider)`, stopped.length === 0, stopped)
  }
  // The outbound send and the read: a desk seat is not refused BY THE GATE (the send itself is never performed here).
  if (mods[COORD]) {
    const m = as(U_TC)
    const listed = await drive(() => mods[COORD].listTransactionCommunications(TX1))
    check("listTransactionCommunications: a desk seat (the coordinator) passes the gate and reads; nothing is written", (listed.r as any)?.success !== false && receiptOnly(m).length === 0, listed.r ?? listed.threw)
    // The book: a deal id that comes back FROM THE MODEL lands only on a deal the desk admitted.
    const m2 = as(U_BROKER)
    G.__DD.modelObject = { overallRiskLevel: "high", transactionRisks: [{ transactionId: TX1, riskLevel: "high", primaryRisk: "appraisal gap" }, { transactionId: TX_X, riskLevel: "critical", primaryRisk: "PLANTED" }], immediateActions: [], weeklyFocus: [] }
    const scan = await drive(() => mods[COORD].monitorTransactionRisks(AG_A))
    const own = T(m2, "transactions").find((r) => r.id === TX1), other = T(m2, "transactions").find((r) => r.id === TX_X)
    check("monitorTransactionRisks: the risk the model names lands on the admitted deal; a deal id the model INVENTS (another tenant's) is not written and is not counted as applied",
      (scan.r as any)?.success === true && own?.ai_risk_level === "high" && other?.ai_risk_level === undefined && (scan.r as any)?.appliedCount === 1 && G.__DD.calls.model === 1, { r: { success: (scan.r as any)?.success, appliedCount: (scan.r as any)?.appliedCount, scannedCount: (scan.r as any)?.scannedCount }, own: own?.ai_risk_level, other: other?.ai_risk_level, threw: scan.threw })
  }
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
  await sectionE()
  await sectionF()
  await sectionG()
  if (ROOT === WT) sectionD()
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(`❌ DEAL_DESK_FAIL — ${fails.slice(0, 12).join(" | ")}`); process.exit(1) }
  console.log("✅ DEAL_DESK_PASS — one decision says who may work a deal; every milestone door and every deal-detail edit asks it; every seat it admits saves the edit, a seat that does not work the deal writes nothing, no write on the five deal tables rides a session client, and no AI deal door reaches a model before the desk")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
