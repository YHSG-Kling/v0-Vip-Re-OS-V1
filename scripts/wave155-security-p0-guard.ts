#!/usr/bin/env tsx
/**
 * scripts/wave155-security-p0-guard.ts — `npm run test:wave155-security-p0` (wave 155, lane 155S1).
 *
 * CROSS-TENANT, MONEY AND PAID-PULL HOLES (P0). Every case drives the REAL export (or route-facing module) against the
 * in-memory client (scripts/in-memory-supabase.ts). Only the session (the cookie client's auth.getUser and getAgentContext),
 * the service-client constructor, and the provider / model / scorer / emit seams are replaced — every seam COUNTS its calls,
 * and the service client COUNTS which tables were READ. All results are SIMULATED.
 *
 *   1  closing-concierge resolve / dismiss / draft / dispatch — another tenant's action: refused, nothing read past the action
 *      row, nothing written, the model and the mailer called 0 times; a vendor seat on the deal refused; no session refused;
 *      an already-closed action is not a success. POSITIVE: the owning agent resolves and drafts.
 *   2  buyer-closing-costs — no session refused (0 reads of the deal, 0 model calls); another tenant's deal, another
 *      Contact's figures and another tenant's staff refused. POSITIVE: the Contact reads their own deal; AI refine bills once.
 *   3  matchMentor — another tenant's agent refused with 0 relationship rows; an agent pairing a colleague refused; no session
 *      refused. POSITIVE: the agent matches itself; a tenant admin pairs an agent of its tenant.
 *   4  runScrapeTestAction — another tenant's market refused BEFORE the paid seams (BatchData 0, Apify 0); no session 401.
 *      POSITIVE: own market pulls once; platform superadmin keeps the platform-wide view.
 *   5  recordBuyerFinancialVerification — RETIRED (no "use server" export left; tombstone names the survivor); the voice
 *      route's own door calls the lib writer (stripped source, positive controls; driven end to end by
 *      test:manager-ownership-matrix §E). updateTrainingJobStatus — no longer a "use server" export; another tenant's /
 *      another profile's job refused with 0 writes. POSITIVE: own job completes.
 *   6  initiateVendorPayout — an agent and a compliance officer are refused before any vendor read; the vendor's OWN seat is
 *      admitted for its own vendor only; the amount is the vendor's available earnings, each paid once; a refused transfer
 *      and a reversed payout give the earnings back (owner task, wave 155: bound to the vendor seat and earnings)
 *      (TENANT_COMMERCE_ADMIN_USER_TYPES); transfer seam 0. POSITIVE: a broker records a manual payout.
 *   7  services-config stage rules (compliance_rules — a platform catalogue) — a tenant broker and no session refused with 0
 *      writes; a delete that matched nothing is not a success. POSITIVE: platform superadmin creates and deletes.
 *   8  phone-connect — the carrier auth token is stored SEALED (enc:v1), opens to the original, a legacy plaintext value
 *      still reads, the one config-secret reader hands back the plaintext, and with no key nothing is stored in plaintext.
 *   9  rescanDealHealthAction / rescanListingHealthAction — a vendor seat, another tenant and a non-owning agent are refused
 *      with the scorer called 0 times; no session refused. POSITIVE: the owning agent (and tenant staff) rescans.
 * RED AT 81cdddae: run against the base files every NEGATIVE above fails (measured — $S/lane155S1-notes.md).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n═══ ${t} ═══`)
const src = (p: string) => { try { return stripComments(readFileSync(join(ROOT, p), "utf8")) } catch { return "" } }

// A TEST-ONLY envelope key (a fixture constant, not a credential): the sealing path needs one to run.
const TEST_SECRETS_KEY = "0f".repeat(32)

const G = globalThis as any
G.__S1 = {
  svc: null as MemClient | null,
  user: null as { id: string; email?: string } | null,
  ctx: null as Record<string, unknown> | null,
  reads: [] as string[],
  calls: { model: 0, mail: 0, batchdata: 0, google: 0, transfer: 0, deal: 0, listing: 0, events: 0 },
}
/** The service client the code receives: the in-memory client, with every `.from(table)` READ recorded. */
const tracked = () => {
  const m = G.__S1.svc as MemClient
  return { ...m, from: (t: string) => { G.__S1.reads.push(t); return m.from(t) } }
}
G.__S1.tracked = tracked
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__S1.tracked()",
  "@/lib/supabase/server": "export const createClient = async () => ({ ...globalThis.__S1.tracked(), auth: { getUser: async () => ({ data: { user: globalThis.__S1.user }, error: null }) } })",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/identity": "export const getAgentContext = async () => globalThis.__S1.ctx",
  "@/lib/identity/get-agent-context": "export const getAgentContext = async () => globalThis.__S1.ctx",
  "@/lib/ai/models": [
    "export const generateTextRouted = async () => { globalThis.__S1.calls.model++; return { text: 'Hello from the model seam.' } }",
    "export const generateObjectRouted = async () => { globalThis.__S1.calls.model++; return { object: { explanations: [], summary: 'seam' } } }",
  ].join("\n"),
  "@/lib/providers/dispatch": "export const dispatchEmail = async () => { globalThis.__S1.calls.mail++; return { success: true, providerKey: 'seam' } }",
  "@/lib/external": "export class BatchDataClient { async getMotivatedSellerData() { globalThis.__S1.calls.batchdata++; return [] } }",
  "@/lib/lead-pipeline/social-sourcer": "export const sourceGoogle = async () => { globalThis.__S1.calls.google++; return { cost: 0, records: [] } }",
  "@/lib/providers/payment": [
    "export const createTransfer = async (a) => { globalThis.__S1.calls.transfer++; globalThis.__S1.lastTransfer = a; return globalThis.__S1.transferFails ? { success: false, error: 'the transfer seam refused' } : { success: true, transferId: 'tr_seam' } }",
    "export const createCheckoutSession = async () => ({ success: false }); export const retrieveCheckoutSession = async () => ({ success: false })",
  ].join("\n"),
  "@/lib/stripe": "export const stripe = new Proxy({}, { get() { throw new Error('stripe is a seam in this proof — never called') } })",
  "@/lib/kernel/emit": "export const emitKernelEvent = async () => { globalThis.__S1.calls.events++; return { inserted: true } }; export const asWriteResult = () => ({ error: null })",
  "@/lib/deal-health/health-scorer": "export const calculateDealHealth = async () => { globalThis.__S1.calls.deal++; return { overallScore: 71, riskLevel: 'healthy', scoreDelta: null } }",
  "@/lib/listing-health/health-scorer": "export const calculateListingHealth = async () => { globalThis.__S1.calls.listing++; return { overallScore: 64, riskLevel: 'watch', scoreDelta: null } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ── ids ────────────────────────────────────────────────────────────────────
const BRK_A = "a1111111-1111-4111-8111-111111111111"
const BRK_B = "b2222222-2222-4222-8222-222222222222"
const U_AGENT_A = "a0000000-0000-4000-8000-0000000000a1"
const U_AGENT_A2 = "a0000000-0000-4000-8000-0000000000a3"
const U_BROKER_A = "a0000000-0000-4000-8000-0000000000a4"
const U_VENDOR_A = "a0000000-0000-4000-8000-0000000000a5"
const U_COMPLIANCE_A = "a0000000-0000-4000-8000-0000000000a6"
const U_CONTACT_A = "a0000000-0000-4000-8000-0000000000a7"
const U_CONTACT_A2 = "a0000000-0000-4000-8000-0000000000a8"
const U_SUPER = "a0000000-0000-4000-8000-0000000000a9"
const U_AGENT_B = "b0000000-0000-4000-8000-0000000000b1"
const AG_A = "a0000000-0000-4000-8000-0000000000c1"
const AG_A2 = "a0000000-0000-4000-8000-0000000000c2"
const AG_MENTOR_A = "a0000000-0000-4000-8000-0000000000c3"
const AG_B = "b0000000-0000-4000-8000-0000000000c1"
const AG_MENTOR_B = "b0000000-0000-4000-8000-0000000000c2"
const TX_A = "a0000000-0000-4000-8000-0000000000d1"
const TX_B = "b0000000-0000-4000-8000-0000000000d1"
const ACT_A = "a0000000-0000-4000-8000-0000000000e1"
const ACT_A_DONE = "a0000000-0000-4000-8000-0000000000e2"
const ACT_B = "b0000000-0000-4000-8000-0000000000e1"
const C_A = "a0000000-0000-4000-8000-0000000000f1"
const C_A2 = "a0000000-0000-4000-8000-0000000000f2"
const C_B = "b0000000-0000-4000-8000-0000000000f1"
const MK_A = "a0000000-0000-4000-8000-000000000101"
const MK_B = "b0000000-0000-4000-8000-000000000101"
const V_A = "a0000000-0000-4000-8000-000000000201"
const L_A = "a0000000-0000-4000-8000-000000000301"
const L_A2 = "a0000000-0000-4000-8000-000000000302"
const L_B = "b0000000-0000-4000-8000-000000000301"
const PROF_A = "a0000000-0000-4000-8000-000000000401"
const PROF_A2 = "a0000000-0000-4000-8000-000000000402"
const PROF_B = "b0000000-0000-4000-8000-000000000401"
const JOB_A = "a0000000-0000-4000-8000-000000000501"
const JOB_B = "b0000000-0000-4000-8000-000000000501"
const RULE_1 = "c0000000-0000-4000-8000-000000000601"

const USERS: Row[] = [
  { id: U_AGENT_A, brokerage_id: BRK_A, user_type: "agent", email: "agent.a@example.test", platform_role: null },
  { id: U_AGENT_A2, brokerage_id: BRK_A, user_type: "agent", email: "agent.a2@example.test", platform_role: null },
  { id: U_BROKER_A, brokerage_id: BRK_A, user_type: "broker", email: "broker.a@example.test", platform_role: null },
  { id: U_VENDOR_A, brokerage_id: BRK_A, user_type: "vendor", email: "vendor.a@example.test", platform_role: null },
  { id: U_COMPLIANCE_A, brokerage_id: BRK_A, user_type: "compliance_officer", email: "co.a@example.test", platform_role: null },
  { id: U_CONTACT_A, brokerage_id: BRK_A, user_type: "contact", email: "pat@example.test", platform_role: null },
  { id: U_CONTACT_A2, brokerage_id: BRK_A, user_type: "contact", email: "lee@example.test", platform_role: null },
  { id: U_SUPER, brokerage_id: BRK_A, user_type: "admin", email: "staff@example.test", platform_role: "superadmin" },
  { id: U_AGENT_B, brokerage_id: BRK_B, user_type: "agent", email: "agent.b@example.test", platform_role: null },
]
const AGENTS: Row[] = [
  { id: AG_A, user_id: U_AGENT_A, brokerage_id: BRK_A, is_active: true, ytd_transactions: 1, years_experience: 1, specializations: [], location_id: null, team_id: null },
  { id: AG_A2, user_id: U_AGENT_A2, brokerage_id: BRK_A, is_active: true, ytd_transactions: 1, years_experience: 1, specializations: [], location_id: null, team_id: null },
  { id: AG_MENTOR_A, user_id: U_BROKER_A, brokerage_id: BRK_A, is_active: true, ytd_transactions: 12, years_experience: 9, specializations: [], location_id: null, team_id: null },
  { id: AG_B, user_id: U_AGENT_B, brokerage_id: BRK_B, is_active: true, ytd_transactions: 1, years_experience: 1, specializations: [], location_id: null, team_id: null },
  { id: AG_MENTOR_B, user_id: null, brokerage_id: BRK_B, is_active: true, ytd_transactions: 12, years_experience: 9, specializations: [], location_id: null, team_id: null },
]
const world = (extra: Record<string, Row[]> = {}): MemClient => memSupabase({
  users: USERS, agents: AGENTS,
  transactions: [
    { id: TX_A, brokerage_id: BRK_A, agent_id: AG_A, coordinator_id: null, status: "active", stage: "under_contract", deal_name: "12 Elm", property_address: "12 Elm St", purchase_price: 500000, loan_amount: null, contact_id: null, buyer_contact_id: C_A, seller_contact_id: null, property_state: "FL", property_city: "Destin", close_date: null, contract_date: null },
    { id: TX_B, brokerage_id: BRK_B, agent_id: AG_B, coordinator_id: null, status: "active", stage: "under_contract", deal_name: "9 Oak", property_address: "9 Oak Ave", purchase_price: 900000, loan_amount: null, contact_id: null, buyer_contact_id: C_A, seller_contact_id: C_B, property_state: "FL", property_city: "Navarre", close_date: null, contract_date: null },
  ],
  contacts: [
    { id: C_A, brokerage_id: BRK_A, contact_user_id: U_CONTACT_A, email: "pat@example.test" },
    { id: C_A2, brokerage_id: BRK_A, contact_user_id: U_CONTACT_A2, email: "lee@example.test" },
    { id: C_B, brokerage_id: BRK_B, contact_user_id: null, email: "sam@example.test" },
  ],
  transaction_coordinators: [], user_role_assignments: [], transaction_assignments: [], teams: [], portal_contact_invites: [],
  agent_action_ledger: [], activities: [], self_heal_events: [],
  ...extra,
}, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })

/** Sign in as `userId` (null = no session): the cookie client's user AND getAgentContext, both from the users row. */
function signIn(userId: string | null) {
  const svc = G.__S1.svc as MemClient
  const u = userId ? (svc.tables.users ?? []).find((r: Row) => r.id === userId) : null
  G.__S1.user = u ? { id: u.id, email: u.email } : null
  const agent = u ? (svc.tables.agents ?? []).find((a: Row) => a.user_id === u.id) : null
  G.__S1.ctx = u
    ? { isAuthenticated: true, userId: u.id, agentId: agent?.id ?? null, brokerageId: u.brokerage_id, userType: u.user_type, isImpersonating: false, impersonationMode: null, impersonatorUserId: null }
    : { isAuthenticated: false, userId: "", agentId: null, brokerageId: null, userType: "agent", isImpersonating: false, impersonationMode: null, impersonatorUserId: null }
}
function fresh(extra: Record<string, Row[]> = {}, who: string | null = null) {
  G.__S1.svc = world(extra)
  G.__S1.reads = []
  for (const k of Object.keys(G.__S1.calls)) G.__S1.calls[k] = 0
  G.__S1.transferFails = false; G.__S1.lastTransfer = null
  signIn(who)
}
const svc = () => G.__S1.svc as MemClient
const writesTo = (table: string, op?: string) => svc().writes.filter((w) => w.table === table && (!op || w.op === op) && w.matched > 0).length
const ledger = (action?: string) => (svc().tables.agent_action_ledger ?? []).filter((r: Row) => !action || r.action === action)
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = { warn: console.warn, error: console.error, log: console.log }
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await f() } finally { console.warn = o.warn; console.error = o.error; console.log = o.log }
}
const settle = async <T>(f: () => Promise<T>): Promise<{ value?: T; threw?: string }> => {
  try { return { value: await quiet(f) } } catch (e) { return { threw: e instanceof Error ? e.message : String(e) } }
}
async function guarded(name: string, body: () => Promise<void>) {
  try { await body() } catch (e) { ok(`${name} — the section ran to completion`, false, e instanceof Error ? `${e.message}\n${(e.stack ?? "").split("\n").slice(1, 4).join("\n")}` : String(e)) }
}

async function main() {
  // ══ 1 ══
  section("1 · closing-concierge — the session's tenant and the deal-work rule decide before any read past the action row")
  await guarded("1", async () => {
    const cc = await import("../app/dashboard/transactions/closing-concierge/actions")
    const actions = (): Row[] => [
      { id: ACT_A, brokerage_id: BRK_A, transaction_id: TX_A, agent_id: AG_A, status: "open", action_type: "lender_docs", headline: "Lender docs missing", detail: null, suggested_recipient: "buyer", due_date: null, dispatched_email_id: null },
      { id: ACT_A_DONE, brokerage_id: BRK_A, transaction_id: TX_A, agent_id: AG_A, status: "resolved", action_type: "x", headline: "done", detail: null, suggested_recipient: null, due_date: null, dispatched_email_id: null },
      { id: ACT_B, brokerage_id: BRK_B, transaction_id: TX_B, agent_id: AG_B, status: "open", action_type: "title", headline: "Title commitment", detail: null, suggested_recipient: "seller", due_date: null, dispatched_email_id: null },
    ]
    const ex = () => ({ transaction_pending_actions: actions(), transaction_lenders: [], transaction_title_escrow: [], transaction_inspections: [] })

    fresh(ex(), null)
    const anon = await quiet(() => cc.resolveConciergeAction(ACT_A, null))
    ok("NEGATIVE · no session: resolve refused, nothing written", anon.success === false && writesTo("transaction_pending_actions", "update") === 0, JSON.stringify(anon))

    fresh(ex(), U_AGENT_A)
    const r1 = await quiet(() => cc.resolveConciergeAction(ACT_B, "mine now"))
    const b1 = svc().tables.transaction_pending_actions.find((r: Row) => r.id === ACT_B)
    ok("NEGATIVE · another tenant's action id: resolve answers \"Action not found\", the row stays open, 0 updates", r1.success === false && /not found/i.test(String(r1.error)) && b1?.status === "open" && writesTo("transaction_pending_actions", "update") === 0, JSON.stringify(r1))
    fresh(ex(), U_AGENT_A)
    const d1 = await quiet(() => cc.dismissConciergeAction(ACT_B, null))
    ok("NEGATIVE · another tenant's action id: dismiss refused, 0 updates", d1.success === false && writesTo("transaction_pending_actions", "update") === 0, JSON.stringify(d1))
    fresh(ex(), U_AGENT_A)
    const dr1 = await quiet(() => cc.draftConciergeActionEmail(ACT_B))
    const leaked = G.__S1.reads.filter((t: string) => ["transactions", "contacts", "transaction_lenders", "transaction_title_escrow", "transaction_inspections"].includes(t))
    ok("NEGATIVE · another tenant's action id: draft refused, the MODEL is called 0 times and no deal / contact / lender table is read", dr1.success === false && G.__S1.calls.model === 0 && leaked.length === 0 && !dr1.suggestedRecipientEmail, `${JSON.stringify(dr1)} reads=${JSON.stringify(leaked)} model=${G.__S1.calls.model}`)
    fresh(ex(), U_AGENT_A)
    const sp1 = await quiet(() => cc.dispatchConciergeActionEmail({ actionId: ACT_B, recipientEmail: "x@example.test", subject: "s", body: "b" }))
    ok("NEGATIVE · another tenant's action id: dispatch refused, the MAILER is called 0 times, no stamp written", sp1.success === false && G.__S1.calls.mail === 0 && writesTo("transaction_pending_actions", "update") === 0, JSON.stringify(sp1))
    fresh(ex(), U_VENDOR_A)
    const v1 = await quiet(() => cc.resolveConciergeAction(ACT_A, null))
    ok("NEGATIVE · a vendor seat of the SAME tenant (not a worker of the deal) is refused, 0 updates", v1.success === false && writesTo("transaction_pending_actions", "update") === 0, JSON.stringify(v1))
    fresh(ex(), U_AGENT_A)
    const z1 = await quiet(() => cc.resolveConciergeAction(ACT_A_DONE, null))
    ok("NEGATIVE · an action already closed: a write that matched nothing is NOT a success (§3)", z1.success === false, JSON.stringify(z1))

    fresh(ex(), U_AGENT_A)
    const p1 = await quiet(() => cc.resolveConciergeAction(ACT_A, "cleared with lender"))
    const a1 = svc().tables.transaction_pending_actions.find((r: Row) => r.id === ACT_A)
    ok("POSITIVE · the owning agent resolves their own action: status resolved, resolved_by the session user, ONE receipt", p1.success === true && a1?.status === "resolved" && a1?.resolved_by === U_AGENT_A && ledger("transaction.pending_action.resolve").length === 1, JSON.stringify(p1))
    fresh(ex(), U_AGENT_A)
    const p2 = await quiet(() => cc.draftConciergeActionEmail(ACT_A))
    ok("POSITIVE · the owning agent drafts: the model is called ONCE and the buyer's own email comes back", p2.success === true && G.__S1.calls.model === 1 && p2.suggestedRecipientEmail === "pat@example.test", JSON.stringify(p2))
  })

  // ══ 2 ══
  section("2 · buyer-closing-costs — a session, the Contact's own deal or the tenant's staff, BEFORE any deal read or model call")
  await guarded("2", async () => {
    const bcc = await import("../app/actions/buyer-closing-costs")
    const ex = () => ({ offers: [], transaction_lenders: [], buyer_financial_profiles: [], brokerages: [{ id: BRK_A, state: "FL" }, { id: BRK_B, state: "FL" }] })
    fresh(ex(), null)
    const n0 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A, refineWithAi: true }))
    ok("NEGATIVE · no session: refused, the deal is never read, the model is called 0 times", n0.success === false && !G.__S1.reads.includes("transactions") && G.__S1.calls.model === 0, JSON.stringify(n0))
    fresh(ex(), U_CONTACT_A)
    const n1 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_B, refineWithAi: true }))
    ok("NEGATIVE · the Contact names ANOTHER TENANT's deal that lists them as buyer: \"Transaction not found\", 0 model calls", n1.success === false && /not found/i.test((n1 as { error: string }).error) && G.__S1.calls.model === 0, JSON.stringify(n1))
    fresh(ex(), U_CONTACT_A2)
    const n2 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A, refineWithAi: true }))
    ok("NEGATIVE · another Contact asks for this buyer's figures: refused, the deal is never read, 0 model calls", n2.success === false && !G.__S1.reads.includes("transactions") && G.__S1.calls.model === 0, JSON.stringify(n2))
    fresh(ex(), U_AGENT_B)
    const n3 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A }))
    ok("NEGATIVE · another tenant's staff: refused, the deal is never read", n3.success === false && !G.__S1.reads.includes("transactions"), JSON.stringify(n3))
    fresh(ex(), U_CONTACT_A)
    const p1 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A }))
    ok("POSITIVE · the Contact reads their OWN deal's figures (purchase price from the deal)", p1.success === true && (p1 as { purchasePrice: number }).purchasePrice === 500000, JSON.stringify(p1).slice(0, 200))
    fresh(ex(), U_CONTACT_A)
    const p2 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A, refineWithAi: true }))
    ok("POSITIVE · the opt-in AI explanation runs ONCE, only after the gate", p2.success === true && G.__S1.calls.model === 1, `model=${G.__S1.calls.model}`)
    fresh(ex(), U_AGENT_A)
    const p3 = await quiet(() => bcc.getBuyerClosingCosts({ contactId: C_A, transactionId: TX_A }))
    ok("POSITIVE · the tenant's own staff read the tenant's deal", p3.success === true, JSON.stringify(p3).slice(0, 160))
  })

  // ══ 3 ══
  section("3 · matchMentor — the mentee is an agent of the SESSION's tenant (and itself, unless a tenant admin pairs)")
  await guarded("3", async () => {
    const mm = await import("../app/actions/onboarding/mentorship")
    const ex = () => ({ agent_mentor_relationships: [] })
    fresh(ex(), null)
    const n0 = await quiet(() => mm.matchMentor(AG_A))
    ok("NEGATIVE · no session: refused, 0 relationship rows", n0.success === false && writesTo("agent_mentor_relationships", "insert") === 0, JSON.stringify(n0))
    fresh(ex(), U_AGENT_A)
    const n1 = await quiet(() => mm.matchMentor(AG_B))
    ok("NEGATIVE · another tenant's agent id: \"Agent not found\", 0 relationship rows (it used to pair them under THAT tenant)", n1.success === false && /not found/i.test(String(n1.error)) && writesTo("agent_mentor_relationships", "insert") === 0, JSON.stringify(n1))
    fresh(ex(), U_AGENT_A)
    const n2 = await quiet(() => mm.matchMentor(AG_A2))
    ok("NEGATIVE · an agent seat pairing a COLLEAGUE: refused, 0 rows", n2.success === false && writesTo("agent_mentor_relationships", "insert") === 0, JSON.stringify(n2))
    fresh(ex(), U_AGENT_A)
    const p1 = await quiet(() => mm.matchMentor(AG_A))
    const rel = (svc().tables.agent_mentor_relationships ?? [])[0]
    ok("POSITIVE · the agent matches ITSELF: one relationship row in the session's tenant with the tenant's mentor", p1.success === true && writesTo("agent_mentor_relationships", "insert") === 1 && rel?.brokerage_id === BRK_A && rel?.mentee_agent_id === AG_A && rel?.mentor_agent_id === AG_MENTOR_A, JSON.stringify(p1).slice(0, 200))
    fresh(ex(), U_BROKER_A)
    const p2 = await quiet(() => mm.matchMentor(AG_A2))
    ok("POSITIVE · a tenant admin pairs an agent of its own tenant", p2.success === true && writesTo("agent_mentor_relationships", "insert") === 1, JSON.stringify(p2).slice(0, 200))
  })

  // ══ 4 ══
  section("4 · runScrapeTestAction — the market is the caller's BEFORE either paid seam")
  await guarded("4", async () => {
    const rs = await import("../app/actions/admin/run-scrape-test")
    const mk = (id: string, b: string) => ({ id, brokerage_id: b, name: `m-${b.slice(0, 1)}`, city: "Destin", state: "FL", zip_codes: ["32541"], counties: [], enabled_sources: ["batchdata_motivated"], monthly_budget_usd: 100, spend_this_month: 10, is_active: true })
    const ex = () => ({ lead_scraping_markets: [mk(MK_A, BRK_A), mk(MK_B, BRK_B)] })
    fresh(ex(), null)
    const n0 = await quiet(() => rs.runScrapeTestAction(MK_A, "batchdata_motivated"))
    ok("NEGATIVE · no session: 401, BatchData 0 calls", (n0 as { status: number }).status === 401 && G.__S1.calls.batchdata === 0, JSON.stringify(n0))
    fresh(ex(), U_BROKER_A)
    const n1 = await quiet(() => rs.runScrapeTestAction(MK_B, "batchdata_motivated"))
    ok("NEGATIVE · a tenant admin names ANOTHER TENANT's market: 404, the PAID BatchData seam is called 0 times, no receipt", (n1 as { status: number }).status === 404 && G.__S1.calls.batchdata === 0 && ledger().length === 0, JSON.stringify(n1))
    fresh(ex(), U_BROKER_A)
    const n2 = await quiet(() => rs.runScrapeTestAction(MK_B, "google_phrase_intent"))
    ok("NEGATIVE · …and the PAID Apify Google lane is called 0 times", (n2 as { status: number }).status === 404 && G.__S1.calls.google === 0, JSON.stringify(n2))
    fresh(ex(), U_AGENT_A)
    const n3 = await quiet(() => rs.runScrapeTestAction(MK_A, "batchdata_motivated"))
    ok("NEGATIVE · an agent seat: 403, 0 paid calls", (n3 as { status: number }).status === 403 && G.__S1.calls.batchdata === 0, JSON.stringify(n3))
    fresh(ex(), U_BROKER_A)
    const p1 = await quiet(() => rs.runScrapeTestAction(MK_A, "batchdata_motivated"))
    ok("POSITIVE · own market: 200, BatchData called ONCE, one receipt", (p1 as { status: number }).status === 200 && G.__S1.calls.batchdata === 1 && ledger("lead_scraping.provider_pull.preview").length === 1, JSON.stringify(p1).slice(0, 200))
    fresh(ex(), U_SUPER)
    const p2 = await quiet(() => rs.runScrapeTestAction(MK_B, "batchdata_motivated"))
    ok("POSITIVE · platform superadmin keeps the diagnostics page's platform-wide view (any market)", (p2 as { status: number }).status === 200 && G.__S1.calls.batchdata === 1, JSON.stringify(p2).slice(0, 200))
  })

  // ══ 5 ══
  section("5 · recordBuyerFinancialVerification and updateTrainingJobStatus are no longer open doors")
  await guarded("5a", async () => {
    // The open door is GONE (retired with a tombstone naming the survivor): no "use server" module exports it any more, so
    // there is nothing for a browser to call. POSITIVE CONTROL: the finder sees the export in a planted specimen. (The voice
    // route's own door — its authority, its tenant gate on the contact and its spoken-confirm hold — is driven end to end by
    // test:manager-ownership-matrix §E: another tenant's contact DENY with 0 writes; one release writes once.)
    const blc = await import("../app/actions/buyer-lifecycle-core") as Record<string, unknown>
    const blcSrc = src("app/actions/buyer-lifecycle-core.ts")
    const EXPORT_SPECIMEN = "export async function recordBuyerFinancialVerification(params: { contactId: string }) {}"
    const exportsRecord = (t: string) => /export\s+async\s+function\s+recordBuyerFinancialVerification\b/.test(t)
    ok("POSITIVE CONTROL · the export finder recognises the open door in a planted specimen", exportsRecord(EXPORT_SPECIMEN))
    ok("NEGATIVE (red at the base) · recordBuyerFinancialVerification is no longer a public endpoint — the \"use server\" module neither declares nor exports it", !exportsRecord(blcSrc) && typeof blc.recordBuyerFinancialVerification === "undefined")
    ok("…and its retirement names the survivor at file:line (CLAUDE.md §1)", /TOMBSTONE[^\n]*recordBuyerFinancialVerification RETIRED/.test(readFileSync(join(ROOT, "app/actions/buyer-lifecycle-core.ts"), "utf8")) && /financial-verification-schema\.ts:\d+ emitFinancialVerificationEvent/.test(readFileSync(join(ROOT, "app/actions/buyer-lifecycle-core.ts"), "utf8")))

    const route = src("app/api/agent-assistant/tool-call/route.ts")
    const SPECIMEN = 'const { recordBuyerFinancialVerification } = await import("@/app/actions/buyer-lifecycle-core")\nconst res = await recordBuyerFinancialVerification({ contactId })'
    const callsAction = (t: string) => /\brecordBuyerFinancialVerification\s*\(/.test(t)
    ok("POSITIVE CONTROL · the finder recognises the old route call in a planted specimen", callsAction(SPECIMEN))
    ok("the sessionless voice route has ITS OWN door: it no longer calls the session action, it calls the lib writer", !callsAction(route) && /emitFinancialVerificationEvent\s*\(/.test(route) && /@\/lib\/buyer-lifecycle\/extensions\/financial-verification-schema/.test(route))
  })
  await guarded("5b", async () => {
    const vv = src("app/actions/video-voice.ts")
    const SPECIMEN = "export async function updateTrainingJobStatus(trainingId: string) {}"
    const exportsIt = (t: string) => /export\s+async\s+function\s+updateTrainingJobStatus\b/.test(t)
    ok("POSITIVE CONTROL · the finder recognises the export in a planted specimen", exportsIt(SPECIMEN))
    ok("updateTrainingJobStatus is NOT exported by the \"use server\" file (it was a public endpoint taking any training id)", !exportsIt(vv) && /^\s*["']use server["']/.test(readFileSync(join(ROOT, "app/actions/video-voice.ts"), "utf8")))
    const mod = await import("../lib/voice/voice-clone-training")
    const ex = () => ({
      voice_clone_training: [
        { id: JOB_A, brokerage_id: BRK_A, voice_profile_id: PROF_A, status: "queued" },
        { id: JOB_B, brokerage_id: BRK_B, voice_profile_id: PROF_B, status: "queued" },
      ],
      agent_voice_profiles: [
        { id: PROF_A, brokerage_id: BRK_A, elevenlabs_voice_id: null, training_status: "training" },
        { id: PROF_A2, brokerage_id: BRK_A, elevenlabs_voice_id: null, training_status: "training" },
        { id: PROF_B, brokerage_id: BRK_B, elevenlabs_voice_id: "voice-of-b", training_status: "ready" },
      ],
      lifecycle_events: [],
    })
    fresh(ex(), null)
    const n1 = await settle(() => mod.updateTrainingJobStatus(JOB_B, "completed", { voice_id: "attacker-voice" }, undefined, { brokerageId: BRK_A, profileId: PROF_A }))
    const pb = svc().tables.agent_voice_profiles.find((r: Row) => r.id === PROF_B)
    ok("NEGATIVE · another tenant's training job: refused, 0 job / profile updates, the other tenant's voice untouched", !!n1.threw && writesTo("voice_clone_training", "update") === 0 && writesTo("agent_voice_profiles", "update") === 0 && pb?.elevenlabs_voice_id === "voice-of-b", JSON.stringify(n1))
    fresh(ex(), null)
    const n2 = await settle(() => mod.updateTrainingJobStatus(JOB_A, "completed", { voice_id: "v" }, undefined, { brokerageId: BRK_A, profileId: PROF_A2 }))
    ok("NEGATIVE · a job of a DIFFERENT profile than the request names: refused, 0 updates", !!n2.threw && writesTo("voice_clone_training", "update") === 0 && writesTo("agent_voice_profiles", "update") === 0, JSON.stringify(n2))
    fresh(ex(), null)
    const p1 = await settle(() => mod.updateTrainingJobStatus(JOB_A, "completed", { voice_id: "voice-of-a" }, undefined, { brokerageId: BRK_A, profileId: PROF_A }))
    const pa = svc().tables.agent_voice_profiles.find((r: Row) => r.id === PROF_A)
    ok("POSITIVE · the session's own job completes: the profile carries the new voice and reads 'ready'", !p1.threw && pa?.elevenlabs_voice_id === "voice-of-a" && pa?.training_status === "ready", JSON.stringify(p1))
  })

  // ══ 6 ══
  section("6 · initiateVendorPayout — the vendor's own seat or a commerce admin asks; the amount is the vendor's AVAILABLE earnings, each paid once")
  await guarded("6", async () => {
    const vp = await import("../app/actions/vendor-payments")
    const { releaseEarningsOfFailedPayout } = await import("../lib/vendors/vendor-payout-events")
    const V_A2 = "a0000000-0000-4000-8000-000000000202"
    const E1 = "a0000000-0000-4000-8000-000000000211", E2 = "a0000000-0000-4000-8000-000000000212", E_PENDING = "a0000000-0000-4000-8000-000000000213", E_OTHER = "a0000000-0000-4000-8000-000000000214"
    const P_FAILED = "a0000000-0000-4000-8000-000000000221", P_LIVE = "a0000000-0000-4000-8000-000000000222"
    const ex = (over: Record<string, Row[]> = {}) => ({
      vendors: [{ id: V_A, brokerage_id: BRK_A }, { id: V_A2, brokerage_id: BRK_A }],
      user_role_assignments: [{ user_id: U_VENDOR_A, vendor_id: V_A, brokerage_id: BRK_A, role: "vendor" }],
      vendor_earnings: [
        { id: E1, vendor_id: V_A, brokerage_id: BRK_A, net_amount: 1500, gross_amount: 1500, status: "available" },
        { id: E2, vendor_id: V_A, brokerage_id: BRK_A, net_amount: 1000, gross_amount: 1000, status: "available" },
        { id: E_PENDING, vendor_id: V_A, brokerage_id: BRK_A, net_amount: 700, gross_amount: 700, status: "pending" },
        { id: E_OTHER, vendor_id: V_A2, brokerage_id: BRK_A, net_amount: 900, gross_amount: 900, status: "available" },
      ],
      vendor_payouts: [], vendor_w9: [], vendor_tax_documents: [],
      platform_credentials: [{ id: "a0000000-0000-4000-8000-000000000231", owner_type: "vendor", owner_id: V_A, platform: "stripe", account_id: "acct_seam", config: { stripe_onboarding_complete: true } }],
      ...over,
    })
    const earning = (id: string) => (svc().tables.vendor_earnings ?? []).find((r: Row) => r.id === id)?.status
    const payouts = (): Row[] => svc().tables.vendor_payouts ?? []
    const untouched = () => earning(E1) === "available" && earning(E2) === "available" && earning(E_PENDING) === "pending" && earning(E_OTHER) === "available" && payouts().length === 0 && G.__S1.calls.transfer === 0

    // WHO
    for (const [who, label] of [[U_AGENT_A, "an agent"], [U_COMPLIANCE_A, "a compliance officer (reads the books, never keeps them)"]] as const) {
      fresh(ex(), who)
      const r = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "manual" }))
      ok(`NEGATIVE · ${label}: refused BEFORE any vendor read; nothing claimed, 0 payout rows, the transfer seam 0 calls`, r.success === false && !G.__S1.reads.includes("vendors") && untouched(), JSON.stringify(r))
    }
    fresh(ex(), U_VENDOR_A)
    const o1 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A2, amount: 900, method: "manual" }))
    ok("NEGATIVE · a vendor seat asking for ANOTHER vendor's earnings (no grant for that vendor): refused; nothing claimed", o1.success === false && !G.__S1.reads.includes("vendors") && untouched(), JSON.stringify(o1))
    fresh(ex({ user_role_assignments: [{ user_id: U_VENDOR_A, vendor_id: V_A, brokerage_id: BRK_B, role: "vendor" }] }), U_VENDOR_A)
    const o2 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "manual" }))
    ok("NEGATIVE · a vendor grant that belongs to ANOTHER tenant does not admit the seat here: refused; nothing claimed", o2.success === false && untouched(), JSON.stringify(o2))

    // THE AMOUNT IS THE AVAILABLE EARNINGS — never the caller's number
    fresh(ex(), U_VENDOR_A)
    const m1 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 9999, method: "manual" }))
    ok("NEGATIVE · the vendor's own seat asking for MORE than its available earnings (9,999 vs 2,500): refused; nothing claimed", m1.success === false && /must equal the available earnings/.test(String(m1.error)) && untouched(), JSON.stringify(m1))
    fresh(ex(), U_VENDOR_A)
    const m2 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2400, earningIds: [E1, E_OTHER], method: "manual" }))
    ok("NEGATIVE · naming ANOTHER vendor's earning id: refused; nothing claimed", m2.success === false && untouched(), JSON.stringify(m2))
    fresh(ex(), U_VENDOR_A)
    const m3 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2200, earningIds: [E1, E_PENDING], method: "manual" }))
    ok("NEGATIVE · naming an earning that is not yet available (pending): refused; nothing claimed", m3.success === false && untouched(), JSON.stringify(m3))

    // THE VENDOR'S OWN SEAT IS ADMITTED — and each earning is paid once
    fresh(ex(), U_VENDOR_A)
    const p1 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "manual" }))
    const row1 = payouts()[0]
    ok("POSITIVE · the vendor's own seat requests its available earnings: ONE payout row for 2,500 carrying both earnings, 'pending'; both earnings read paid out; the others untouched; no transfer for a manual request",
      p1.success === true && payouts().length === 1 && Number(row1?.amount) === 2500 && row1?.status === "pending" && row1?.brokerage_id === BRK_A && JSON.stringify([...(row1?.earnings_ids ?? [])].sort()) === JSON.stringify([E1, E2])
      && earning(E1) === "paid_out" && earning(E2) === "paid_out" && earning(E_PENDING) === "pending" && earning(E_OTHER) === "available" && G.__S1.calls.transfer === 0, `${JSON.stringify(p1)} ${JSON.stringify(row1)}`)
    const p1again = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "manual" }))
    ok("NEGATIVE · THE SAME REQUEST AGAIN (the double-pay shape: the button used to pay the same balance every click): refused — nothing is left to claim; still ONE payout row",
      p1again.success === false && /no available earnings/i.test(String(p1again.error)) && payouts().length === 1, JSON.stringify(p1again))

    // STRIPE: the transfer carries the BOUND amount; a refused transfer gives the earnings back
    fresh(ex(), U_VENDOR_A)
    const s1 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 1500, earningIds: [E1], method: "stripe" }))
    const rowS = payouts()[0]
    ok("POSITIVE · Stripe, one selected earning: the transfer seam is called ONCE for 1,500 (the earning's amount), the payout row reads 'processing' with the transfer id, the earning reads paid out, the other stays available",
      s1.success === true && G.__S1.calls.transfer === 1 && Number(G.__S1.lastTransfer?.amount) === 1500 && rowS?.status === "processing" && rowS?.stripe_transfer_id === "tr_seam" && earning(E1) === "paid_out" && earning(E2) === "available", `${JSON.stringify(s1)} ${JSON.stringify(rowS)}`)
    ok("…and the transfer left ONE decision record on the payout sink", ledger("vendor.payout.transfer").length === 1 && ledger("vendor.payout.transfer")[0].brokerage_id === BRK_A, JSON.stringify(ledger("vendor.payout.transfer").map((r: Row) => r.status)))
    fresh(ex(), U_VENDOR_A)
    G.__S1.transferFails = true
    const s2 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "stripe" }))
    ok("NEGATIVE · the transfer is refused: the call fails, the payout row reads 'failed' (never a pending payout nobody will make), and BOTH earnings are available again",
      s2.success === false && G.__S1.calls.transfer === 1 && payouts().length === 1 && payouts()[0].status === "failed" && earning(E1) === "available" && earning(E2) === "available" && !s2.earningsWarning, `${JSON.stringify(s2)} ${JSON.stringify(payouts()[0])}`)
    fresh(ex({ platform_credentials: [] }), U_VENDOR_A)
    const s3 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "stripe" }))
    ok("NEGATIVE · Stripe not set up: refused BEFORE anything is claimed", s3.success === false && untouched(), JSON.stringify(s3))

    // A COMMERCE ADMIN IS BOUND TO THE SAME RULE
    fresh(ex(), U_BROKER_A)
    const b0 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 100, method: "manual" }))
    ok("NEGATIVE · a broker (commerce admin) naming an amount that is not the available earnings: refused; nothing claimed", b0.success === false && untouched(), JSON.stringify(b0))
    fresh(ex(), U_BROKER_A)
    const b1 = await quiet(() => vp.initiateVendorPayout({ vendorId: V_A, amount: 2500, method: "manual" }))
    ok("POSITIVE · a broker (commerce admin) records a manual payout of the vendor's available earnings", b1.success === true && writesTo("vendor_payouts", "insert") === 1 && earning(E1) === "paid_out" && earning(E2) === "paid_out", JSON.stringify(b1))

    // THE RELEASE RULE (a reversed payout gives its earnings back — never one a later live payout carries)
    const paidOut = (): Row[] => [
      { id: E1, vendor_id: V_A, brokerage_id: BRK_A, net_amount: 1500, status: "paid_out" },
      { id: E2, vendor_id: V_A, brokerage_id: BRK_A, net_amount: 1000, status: "paid_out" },
    ]
    fresh(ex({ vendor_earnings: paidOut(), vendor_payouts: [{ id: P_FAILED, vendor_id: V_A, brokerage_id: BRK_A, status: "failed", earnings_ids: [E1, E2] }] }), null)
    const r1 = await releaseEarningsOfFailedPayout(svc(), P_FAILED)
    const r1b = await releaseEarningsOfFailedPayout(svc(), P_FAILED)
    ok("RELEASE · a failed payout gives both earnings back; running it again releases nothing more", r1.ok && r1.released === 2 && earning(E1) === "available" && earning(E2) === "available" && r1b.ok && r1b.released === 0, `${JSON.stringify(r1)} ${JSON.stringify(r1b)}`)
    fresh(ex({ vendor_earnings: paidOut(), vendor_payouts: [{ id: P_FAILED, vendor_id: V_A, brokerage_id: BRK_A, status: "failed", earnings_ids: [E1, E2] }, { id: P_LIVE, vendor_id: V_A, brokerage_id: BRK_A, status: "processing", earnings_ids: [E2] }] }), null)
    const r2 = await releaseEarningsOfFailedPayout(svc(), P_FAILED)
    ok("RELEASE · NEGATIVE · an earning a LATER live payout carries is not released (a late redelivery cannot free money in flight)", r2.ok && r2.released === 1 && r2.heldByLivePayout === 1 && earning(E1) === "available" && earning(E2) === "paid_out", JSON.stringify(r2))
    const r3 = await releaseEarningsOfFailedPayout(svc(), P_LIVE)
    ok("RELEASE · NEGATIVE · a payout that is not failed or cancelled releases nothing", r3.ok === false && earning(E2) === "paid_out", JSON.stringify(r3))
  })

  // ══ 7 ══
  section("7 · services-config stage rules — compliance_rules is a platform catalogue: platform superadmin writes, tenants read")
  await guarded("7", async () => {
    const sc = await import("../app/actions/services-config")
    const rule = { rule_type: "transaction", from_stage: "pending", to_stage: "closed", required_conditions: [], auto_transition: false, actions_on_transition: [] }
    const ex = () => ({ compliance_rules: [{ id: RULE_1, rule_type: "transaction", from_stage: "a", to_stage: "b" }] })
    fresh(ex(), null)
    const n0 = await settle(() => sc.createStageRule(rule))
    ok("NEGATIVE · no session: refused (it had no gate at all), 0 rows inserted into the global table", (!!n0.threw || (n0.value as { success?: boolean })?.success === false) && writesTo("compliance_rules", "insert") === 0, JSON.stringify(n0))
    fresh(ex(), U_BROKER_A)
    const n1 = await settle(() => sc.createStageRule(rule))
    ok("NEGATIVE · a tenant broker cannot write the PLATFORM-WIDE catalogue: refused, 0 inserts", (!!n1.threw || (n1.value as { success?: boolean })?.success === false) && writesTo("compliance_rules", "insert") === 0, JSON.stringify(n1))
    fresh(ex(), U_BROKER_A)
    const n2 = await settle(() => sc.deleteStageRule(RULE_1))
    ok("NEGATIVE · a tenant broker cannot delete a catalogue rule: refused, the rule survives", (!!n2.threw || (n2.value as { success?: boolean })?.success === false) && svc().tables.compliance_rules.length === 1, JSON.stringify(n2))
    fresh(ex(), U_SUPER)
    const z = await settle(() => sc.deleteStageRule("c0000000-0000-4000-8000-0000000009ff"))
    ok("NEGATIVE · a delete that matched NOTHING is not a success (§3)", !!z.threw || (z.value as { success?: boolean })?.success === false, JSON.stringify(z))
    fresh(ex(), U_SUPER)
    const p1 = await settle(() => sc.createStageRule(rule))
    ok("POSITIVE · platform superadmin creates a catalogue rule (one insert)", !p1.threw && writesTo("compliance_rules", "insert") === 1, JSON.stringify(p1).slice(0, 160))
    fresh(ex(), U_SUPER)
    const p2 = await settle(() => sc.deleteStageRule(RULE_1))
    ok("POSITIVE · platform superadmin deletes an existing rule (the row is gone)", !p2.threw && svc().tables.compliance_rules.length === 0, JSON.stringify(p2))
  })

  // ══ 8 ══
  section("8 · phone-connect — the carrier auth token is sealed like its sibling api_key, and still reads")
  await guarded("8", async () => {
    const prior = process.env.SECRETS_ENCRYPTION_KEY
    const priorPrev = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
    delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
    try {
      process.env.SECRETS_ENCRYPTION_KEY = TEST_SECRETS_KEY
      const pc = await import("../app/actions/phone-connect")
      const crypto = await import("../lib/security/secret-crypto")
      const { secretFromConfig } = await import("../lib/connections/credential-secret")
      const TOKEN = "fixture-auth-token-0000"
      fresh({ platform_credentials: [] }, U_AGENT_A)
      const r = await quiet(() => pc.connectPhoneAction({ accountSid: "ACfixture", authToken: TOKEN, fromNumber: "+15550000000" }))
      const row = (svc().tables.platform_credentials ?? [])[0]
      const stored = row?.config?.auth_token
      ok("the connect still succeeds for the agent's own line", (r as { ok: boolean }).ok === true && !!row, JSON.stringify(r))
      ok("NEGATIVE (red at the base) · the stored auth token is NOT the plaintext — it is an enc:v1 envelope like api_key", typeof stored === "string" && stored !== TOKEN && crypto.isEncrypted(stored) && crypto.isEncrypted(row?.api_key), String(stored).slice(0, 12))
      ok("…it opens to the original through decryptSecret (the same door api_key is read through)", crypto.decryptSecret(stored) === TOKEN)
      ok("…a LEGACY plaintext token still reads (decryptSecret passes it through; re-sealing stored rows is resealLegacyPlaintextSecretsAction's job)", crypto.decryptSecret("legacy-plain-token") === "legacy-plain-token")
      // The READ DOOR the SMS resolver uses (lib/providers/messaging/resolve-sms-provider.ts → resolveScopedConnection →
      // secretFromConfig(conn.config)), driven for real against the row the connect just wrote, and against a legacy row.
      const { resolveScopedConnection } = await import("../lib/connections/resolve-scoped")
      const conn = await quiet(() => resolveScopedConnection("twilio", { agentUserId: U_AGENT_A, teamId: null, brokerageId: BRK_A }))
      const opened = secretFromConfig(conn?.config)
      const legacyRow = { ...row, id: "a0000000-0000-4000-8000-000000000999", config: { auth_token: "legacy-plain-token", from_number: "+15550000001" } }
      svc().tables.platform_credentials.splice(0, svc().tables.platform_credentials.length, legacyRow)
      const legacy = await quiet(() => resolveScopedConnection("twilio", { agentUserId: U_AGENT_A, teamId: null, brokerageId: BRK_A }))
      ok("PAIRED READ DOOR · the scoped reader the SMS resolver uses hands back the PLAINTEXT token for a sealed row, and a legacy plaintext row unchanged", opened === TOKEN && secretFromConfig(legacy?.config) === "legacy-plain-token", `sealed→${String(opened).slice(0, 12)} legacy→${String(secretFromConfig(legacy?.config)).slice(0, 12)} — needs Outside-lane request 1 (resolve-scoped / connection-manager / connector-health open config secrets)`)
      delete process.env.SECRETS_ENCRYPTION_KEY
      fresh({ platform_credentials: [] }, U_AGENT_A)
      const nk = await settle(() => pc.connectPhoneAction({ accountSid: "ACfixture", authToken: TOKEN, fromNumber: "+15550000000" }))
      const plain = (svc().tables.platform_credentials ?? []).filter((x: Row) => x.config?.auth_token === TOKEN)
      ok("NEGATIVE · with no envelope key configured the write is REFUSED — no plaintext token is ever stored", plain.length === 0 && (!!nk.threw || (nk.value as { ok?: boolean })?.ok === false), JSON.stringify(nk).slice(0, 160))
    } finally {
      if (prior === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = prior
      if (priorPrev !== undefined) process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = priorPrev
    }
  })

  // ══ 9 ══
  section("9 · the two rescan ACTIONS take the route gates of 119ac6b4")
  await guarded("9", async () => {
    const dh = await import("../app/actions/deal-health-actions")
    const lh = await import("../app/actions/listing-health-actions")
    const ex = () => ({
      proactive_interventions: [],
      listings: [
        { id: L_A, brokerage_id: BRK_A, agent_id: AG_A },
        { id: L_A2, brokerage_id: BRK_A, agent_id: AG_A2 },
        { id: L_B, brokerage_id: BRK_B, agent_id: AG_B },
      ],
    })
    fresh(ex(), null)
    const d0 = await quiet(() => dh.rescanDealHealthAction({ transactionId: TX_A }))
    ok("NEGATIVE · deal · no session: refused, scorer 0 calls", d0.success === false && G.__S1.calls.deal === 0, JSON.stringify(d0))
    fresh(ex(), U_VENDOR_A)
    const d1 = await quiet(() => dh.rescanDealHealthAction({ transactionId: TX_A }))
    ok("NEGATIVE · deal · a VENDOR seat of the deal's tenant (the row policy lets a vendor party read it): refused, scorer 0, 0 events", d1.success === false && G.__S1.calls.deal === 0 && G.__S1.calls.events === 0, JSON.stringify(d1))
    fresh(ex(), U_AGENT_B)
    const d2 = await quiet(() => dh.rescanDealHealthAction({ transactionId: TX_A }))
    ok("NEGATIVE · deal · another tenant's agent: \"Transaction not found\", scorer 0", d2.success === false && G.__S1.calls.deal === 0, JSON.stringify(d2))
    fresh(ex(), U_AGENT_A2)
    const d3 = await quiet(() => dh.rescanDealHealthAction({ transactionId: TX_A }))
    ok("NEGATIVE · deal · an agent of the same tenant who does not work this deal: refused, scorer 0", d3.success === false && G.__S1.calls.deal === 0, JSON.stringify(d3))
    fresh(ex(), U_AGENT_A)
    const d4 = await quiet(() => dh.rescanDealHealthAction({ transactionId: TX_A }))
    ok("POSITIVE · deal · the owning agent rescans: scorer ONCE, the score comes back", d4.success === true && G.__S1.calls.deal === 1 && d4.overallScore === 71, JSON.stringify(d4))

    fresh(ex(), null)
    const l0 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A }))
    ok("NEGATIVE · listing · no session: refused, scorer 0", l0.success === false && G.__S1.calls.listing === 0, JSON.stringify(l0))
    fresh(ex(), U_AGENT_A2)
    const l1 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A }))
    ok("NEGATIVE · listing · ANOTHER agent of the same tenant (the row policy admits any agent): refused, scorer 0", l1.success === false && G.__S1.calls.listing === 0, JSON.stringify(l1))
    fresh(ex(), U_AGENT_B)
    const l2 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A }))
    ok("NEGATIVE · listing · another tenant's agent: refused, scorer 0", l2.success === false && G.__S1.calls.listing === 0, JSON.stringify(l2))
    fresh(ex(), U_VENDOR_A)
    const l3 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A }))
    ok("NEGATIVE · listing · a vendor seat of the tenant: refused, scorer 0", l3.success === false && G.__S1.calls.listing === 0, JSON.stringify(l3))
    fresh(ex(), U_AGENT_A)
    const l4 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A }))
    ok("POSITIVE · listing · the listing's own agent rescans: scorer ONCE", l4.success === true && G.__S1.calls.listing === 1, JSON.stringify(l4))
    fresh(ex(), U_BROKER_A)
    const l5 = await quiet(() => lh.rescanListingHealthAction({ listingId: L_A2 }))
    ok("POSITIVE · listing · tenant staff (a broker) rescans a listing of its tenant", l5.success === true && G.__S1.calls.listing === 1, JSON.stringify(l5))
  })

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
  console.log("✅ WAVE155_SECURITY_P0_PASS — another tenant's id, no session and a wrong seat are refused before any read, write or paid call; the rightful caller still works (SIMULATED)")
}
main().catch((e) => { console.error(e); process.exit(1) })
