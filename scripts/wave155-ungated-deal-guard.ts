#!/usr/bin/env tsx
/**
 * scripts/wave155-ungated-deal-guard.ts   (npm run test:wave155-ungated-deal)   — wave 155, lane 155S2
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * DEAL-SIDE AND AI "use server" EXPORTS TAKE THE TENANT AND THE PERSON FROM THE SESSION — AND THREE TRUTH BUGS STAY FIXED.
 *
 * Every export driven here is a PUBLIC endpoint ("use server", CLAUDE.md §4). Before lane 155S2 each one either read no
 * session at all, or took `brokerageId` / `agentId` / `userId` from its argument. This proof calls the REAL exports with the
 * REAL gates — lib/auth/require-caller.ts (requireCaller / requireCallerTenant → decideClaimedTenant / authorizeForAgent),
 * lib/identity getAgentContext, lib/auth/authorize-for-user.ts authorizeForUser, lib/platform/acting-context.ts
 * resolveWriteContext(ForTenant), the roster in lib/auth/resolve-user-role.ts — over an IN-MEMORY database
 * (scripts/in-memory-supabase.ts). Stubbed ONLY: the session client (which user is signed in), the model router and the
 * AI generator (COUNTED seams — never a provider), the title-portal actor gate, and Next's request shims. SIMULATED.
 *
 * Each NEGATIVE canary (another tenant's id, another person's id, no session, a non-roster seat) asserts the refusal AND
 * its consequence: no row written / changed, no model reached (seam count unchanged). Each has a POSITIVE twin — the
 * rightful caller still works — so a gate that refuses everyone cannot pass.
 * TRUTH: open-house invalid ids return a refusal, never the invented "92" / "B+"; the chat stream route reaches its model
 * and streams; a title note reaches the agent's USER seat and never writes an agents.id into a contacts column;
 * enableAIPilot files the plan under the agents.id (crossed from users.id via agents.user_id).
 *
 * RED AT THE BASE 81cdddae — measured by running this file with the 16 lane files checked out at the base (lane notes).
 * BLIND SPOTS: RLS is not modelled (the in-memory client admits every row — which is exactly why a missing tenant
 * predicate shows here); the impersonation seam is not exercised (getAgentContext's act-as branch); `getSourcePerformance`
 * still takes `agentIds` (in-tenant scope) from the caller — see the lane notes.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
/** Call an export; never throw. */
async function drive<T>(fn: () => Promise<T>): Promise<{ r: T | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}

// ── the people ──────────────────────────────────────────────────────────────────────────────────────────────────────
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000155`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_AGENT = u("a", 2), U_AGENT2 = u("a", 3), U_X = u("a", 9)
const AG_A = u("e", 2), AG_B = u("e", 3), AG_X = u("e", 9)
const TC1 = u("f", 1), TC_X = u("f", 9), TX1 = u("d", 1), TX_X = u("d", 9), ITEM1 = u("c", 1), ITEM_X = u("c", 9)
const L_A = u("1", 1), L_X = u("1", 9), C_A = u("2", 1), C_B = u("2", 2), C_X = u("2", 9), C_SELLER_USER = u("a", 5)
const PLAN1 = u("3", 1), PLAN_X = u("3", 9), ACT1 = u("4", 1), CA_X = u("5", 9), CONV1 = u("6", 1), EV1 = u("7", 1), EV_X = u("7", 9)

function world(): MemClient {
  const m = seedWorld()
  // memSupabase projects plain columns only; the title portal reads its deal through an EMBED
  // (`transactions(brokerage_id, property_address, agent_id)`), which the fixture carries pre-joined on the row. Return
  // that row whole so the export's own tenant check runs on the real nested values (fixture limit, not a gate change).
  const from = m.from.bind(m)
  ;(m as any).from = (t: string) => { const b: any = from(t); if (t === "transaction_title_escrow") { const sel = b.select.bind(b); b.select = () => sel("*") } return b }
  return m
}
function seedWorld(): MemClient {
  return memSupabase({
    // The report-scope resolver reads the workspace row and its offices; without one it fails closed to "own work" (which is
    // what the fixture produced before these rows existed — a broker saw an empty report). Single-office workspaces.
    brokerages: [{ id: B1, plan_tier: "brokerage" }, { id: B2, plan_tier: "brokerage" }],
    locations: [],
    users: [
      { id: U_BROKER, brokerage_id: B1, user_type: "broker", first_name: "Bea", last_name: "Broker", email: "bea@example.test" },
      { id: U_AGENT, brokerage_id: B1, user_type: "agent", first_name: "Ann", last_name: "Agent", email: "ann@example.test" },
      { id: U_AGENT2, brokerage_id: B1, user_type: "agent", first_name: "Ben", last_name: "Agent", email: "ben@example.test" },
      { id: U_X, brokerage_id: B2, user_type: "broker", first_name: "Xavi", last_name: "Other", email: "x@example.test" },
    ],
    agents: [
      { id: AG_A, user_id: U_AGENT, brokerage_id: B1 },
      { id: AG_B, user_id: U_AGENT2, brokerage_id: B1 },
      { id: AG_X, user_id: U_X, brokerage_id: B2 },
    ],
    transaction_coordinators: [
      { id: TC1, brokerage_id: B1, display_name: "Tess", max_active_deals: 5, is_active: true },
      { id: TC_X, brokerage_id: B2, display_name: "Other TC", max_active_deals: 5, is_active: true },
    ],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, contact_id: C_A, status: "under_contract", property_address: "1 Fixture Way", close_date: "2026-12-30" },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, contact_id: C_X, status: "under_contract", property_address: "9 Other St", close_date: "2026-12-30" },
    ],
    closing_checklist_items: [
      { id: ITEM1, brokerage_id: B1, transaction_id: TX1, item_name: "Final walk-through", completed: false, completed_by: null },
      { id: ITEM_X, brokerage_id: B2, transaction_id: TX_X, item_name: "Other", completed: false, completed_by: null },
    ],
    contacts: [
      { id: C_A, brokerage_id: B1, agent_id: AG_A, first_name: "Sam", last_name: "Seller", contact_user_id: C_SELLER_USER, source: "zillow", source_family: "lead", created_at: new Date().toISOString(), deleted_at: null },
      { id: C_B, brokerage_id: B1, agent_id: AG_B, first_name: "Col", last_name: "League", source: "zillow", source_family: "lead", created_at: new Date().toISOString(), deleted_at: null },
      { id: C_X, brokerage_id: B2, agent_id: AG_X, first_name: "Other", last_name: "Client" },
    ],
    listings: [
      { id: L_A, brokerage_id: B1, agent_id: AG_A, address: "1 Fixture Way", city: "Destin", slug: "1-fixture-way", list_price: 500000, contact_id: C_A, seller_walkaway_price: null, property_type: "single_family" },
      { id: L_X, brokerage_id: B2, agent_id: AG_X, address: "9 Other St", slug: "9-other", list_price: 400000, contact_id: C_X, seller_walkaway_price: null },
    ],
    ai_autopilot_plans: [
      { id: PLAN1, brokerage_id: B1, agent_id: AG_A, contact_id: C_A, is_active: true, next_action_at: "2026-12-01" },
      { id: PLAN_X, brokerage_id: B2, agent_id: AG_X, contact_id: C_X, is_active: true, next_action_at: "2026-12-01" },
    ],
    activities: [{ id: ACT1, brokerage_id: B1, activity_type: "content.approval", status: "pending", metadata: {} }],
    call_analyses: [
      { id: CA_X, brokerage_id: B2, agent_id: AG_X, contact_id: C_X, summary: "other tenant call", analyzed_at: new Date().toISOString() },
      { id: u("5", 1), brokerage_id: B1, agent_id: AG_A, contact_id: C_A, summary: "a call", coaching_score: 80, analyzed_at: new Date().toISOString() },
    ],
    conversations: [{ id: CONV1, brokerage_id: B1, contact_id: null }],
    messages: [],
    open_house_events: [{ id: EV1, brokerage_id: B1, listing_id: L_A, attendance_prediction: null }, { id: EV_X, brokerage_id: B2, listing_id: L_X, attendance_prediction: null }],
    open_house_analytics: [],
    calendar_blocks: [], email_queue: [], notifications: [], seller_share_feed: [], trid_timeline: [], agent_action_ledger: [],
    client_portal_messages: [], ai_suggestions: [], communications: [],
    transaction_title_escrow: [{ transaction_id: TX1, brokerage_id: B1, title_company_email: "title@example.test" }],
  }, { uuidIds: true })
}

// ── the seams (installed BEFORE any app module loads) ───────────────────────────────────────────────────────────────
const G = globalThis as any
G.__S2 = {
  mem: world() as MemClient,
  seat: null as string | null,
  model: 0,
  modelText: "{}",
  json: null as unknown,
  sess: () => Object.assign(G.__S2.mem, { auth: { getUser: async () => ({ data: { user: G.__S2.seat ? { id: G.__S2.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) } }),
}
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const BY_URL: Record<string, string> = {
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__S2.sess() }; export async function createServerClient(){ return globalThis.__S2.sess() }",
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__S2.sess() }",
  // THE MODEL SEAMS — counted; a provider is never reached.
  "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__S2.model++; return { text: globalThis.__S2.modelText } }; export async function generateObjectRouted(){ globalThis.__S2.model++; return { object: {} } }; export async function streamTextRouted(){ globalThis.__S2.model++; return { textStream: (async function*(){ yield 'Hi there' })() } }",
  "lib/ai/generate.ts": "export async function generateAIJSON(){ globalThis.__S2.model++; return { data: globalThis.__S2.json } }; export async function generateAIText(){ globalThis.__S2.model++; return { text: 'stub' } }; export async function generateChatResponse(){ globalThis.__S2.model++; return { text: 'stub' } }; export async function generateAIObject(){ globalThis.__S2.model++; return { success: true, object: {} } }; export async function generateObject(){ globalThis.__S2.model++; return { object: {} } }; export function bookedGenerateObject(){ return async function(){ globalThis.__S2.model++; return { object: {} } } }",
  // Lane 155T3: the title seat is a VENDOR seat (title is a vendor category, CLAUDE.md §4) — the gate's own proof is
  // scripts/external-portal-session-identity-guard.ts G9; here it is a fixture: the deal's assigned title vendor.
  "lib/kernel/portal-auth.ts": `export class PortalAuthError extends Error {}; export async function requireTitleVendorActor(){ return { userId: '${u("a", 7)}', vendorId: '${u("8", 1)}', brokerageId: '${B1}', companyName: 'Fixture Title', companyPhone: null, email: 'title@example.test' } }`,
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: `data:text/javascript,${encodeURIComponent(BY_SPEC[spec])}`, shortCircuit: true }
    const r = next(spec, ctx)
    // The stub module re-exports the REAL file; that import comes from a data: parent and must reach the real file.
    if ((ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const key = Object.keys(BY_URL).find((k) => path === realUrl(k))
    if (!key) return r
    return { url: `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(realUrl(key))}; ${BY_URL[key]}`)}`, shortCircuit: true }
  },
})
delete process.env.AI_GATEWAY_API_KEY

const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)
/** A fresh database and a signed-in seat (null = nobody). */
function as(seat: string | null) { G.__S2.mem = world(); G.__S2.seat = seat; G.__S2.model = 0; G.__S2.modelText = "{}"; G.__S2.json = null; return G.__S2.mem as MemClient }
const T = (m: MemClient, t: string): Row[] => m.tables[t] ?? []
const refused = (x: { r: any; threw: string | null }) => !!x.threw || x.r?.success === false || x.r?.ok === false || (x.r && typeof x.r === "object" && "error" in x.r && !!x.r.error)

async function main() {
  // ═══ tc-actions ═══════════════════════════════════════════════════════════════════════════════════════════════════
  section("1 · transaction coordinators (app/dashboard/settings/team/tc/tc-actions.ts)")
  {
    const tc = await load("app/dashboard/settings/team/tc/tc-actions.ts")
    let m = as(null); let x = await drive(() => tc.updateTransactionCoordinator(TC1, { displayName: "Hacked", maxActiveDeals: 1, isActive: false }))
    check("NEG no session: updateTransactionCoordinator refused and the row is unchanged", refused(x) && T(m, "transaction_coordinators").find((r) => r.id === TC1)?.display_name === "Tess", x)
    m = as(U_AGENT); x = await drive(() => tc.updateTransactionCoordinator(TC1, { displayName: "Hacked", maxActiveDeals: 1, isActive: false }))
    check("NEG an agent seat (not on the tenant roster) is refused; row unchanged", refused(x) && T(m, "transaction_coordinators").find((r) => r.id === TC1)?.display_name === "Tess", x)
    m = as(U_BROKER); x = await drive(() => tc.createTransactionCoordinator({ userId: null, displayName: "Planted", maxActiveDeals: 3, brokerageId: B2 }))
    check("NEG a body brokerageId naming ANOTHER tenant is refused; nothing inserted", refused(x) && !T(m, "transaction_coordinators").some((r) => r.display_name === "Planted"), x)
    m = as(U_BROKER); x = await drive(() => tc.updateTransactionCoordinator(TC_X, { displayName: "Hacked", maxActiveDeals: 1, isActive: false }))
    check("NEG another tenant's coordinator id: not found (zero rows is not success); its row is unchanged", refused(x) && T(m, "transaction_coordinators").find((r) => r.id === TC_X)?.display_name === "Other TC", x)
    m = as(U_BROKER); x = await drive(() => tc.updateTransactionCoordinator(TC1, { displayName: "Tess R.", maxActiveDeals: 6, isActive: true }))
    check("POS the tenant's broker updates its own coordinator", (x.r as any)?.success === true && T(m, "transaction_coordinators").find((r) => r.id === TC1)?.display_name === "Tess R.", x)
  }

  // ═══ ai-closing-workflow ══════════════════════════════════════════════════════════════════════════════════════════
  section("2 · closing checklist (app/actions/ai-closing-workflow.ts)")
  {
    const cw = await load("app/actions/ai-closing-workflow.ts")
    let m = as(null); let x = await drive(() => cw.completeChecklistItem({ itemId: ITEM1, completedBy: U_AGENT2 }))
    check("NEG no session: completeChecklistItem refused; the item is not signed off", refused(x) && T(m, "closing_checklist_items").find((r) => r.id === ITEM1)?.completed === false, x)
    m = as(U_BROKER); x = await drive(() => cw.completeChecklistItem({ itemId: ITEM1, completedBy: U_AGENT2 }))
    const item = T(m, "closing_checklist_items").find((r) => r.id === ITEM1)
    check("NEG a body completedBy is NOT the attestation: completed_by is the SESSION user (a users.id — FK → users)", item?.completed === true && item?.completed_by === U_BROKER, item)
    check("POS the session's own completion succeeds", (x.r as any)?.success === true, x)
    m = as(U_BROKER); x = await drive(() => cw.completeChecklistItem({ itemId: ITEM_X, completedBy: U_BROKER }))
    check("NEG another tenant's checklist item: not found; unchanged", refused(x) && T(m, "closing_checklist_items").find((r) => r.id === ITEM_X)?.completed === false, x)
    m = as(U_BROKER); x = await drive(() => cw.aiGenerateClosingChecklist({ transactionId: TX1, agentId: AG_A, brokerageId: B2 }))
    check("NEG aiGenerateClosingChecklist naming another tenant is refused BEFORE the model (0 calls)", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    m = as(U_BROKER); x = await drive(() => cw.aiGenerateClosingChecklist({ transactionId: TX_X, agentId: AG_X, brokerageId: B1 }))
    check("NEG aiGenerateClosingChecklist on another tenant's deal: not found, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
  }

  // ═══ copilot ══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("3 · daily gameplan (app/actions/copilot.ts generateDailyGameplan)")
  {
    const cp = await load("app/actions/copilot.ts")
    as(null); let x = await drive(() => cp.generateDailyGameplan(U_AGENT))
    check("NEG no session: refused (throws), 0 model calls", !!x.threw && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_BROKER); x = await drive(() => cp.generateDailyGameplan(U_X))
    check("NEG a broker naming ANOTHER tenant's user is refused, 0 model calls", !!x.threw && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => cp.generateDailyGameplan(U_AGENT2))
    check("NEG an agent naming another user of its own tenant is refused (not on the act-for-others roster)", !!x.threw, x)
    as(U_AGENT); x = await drive(() => cp.generateDailyGameplan(U_AGENT))
    check("POS the session's own gameplan is not refused", !x.threw || !/Unauthorized|Forbidden|Not authenticated/.test(x.threw), x)
  }

  // ═══ ai-training-coaching ═════════════════════════════════════════════════════════════════════════════════════════
  section("4 · coaching (app/actions/ai-training-coaching.ts)")
  {
    const tr = await load("app/actions/ai-training-coaching.ts")
    as(U_BROKER); let x = await drive(() => tr.analyzeAgentPerformance({ agentId: AG_X }))
    check("NEG a broker naming ANOTHER tenant's agent is refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => tr.analyzeAgentPerformance({ agentId: AG_B }))
    check("NEG an agent naming a colleague's agents.id is refused (own agent or tenant roster only)", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => tr.evaluatePracticeSession({ agentId: AG_A, brokerageId: B2, response: "hello" }))
    check("NEG evaluatePracticeSession with a body brokerageId of another tenant is refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => tr.analyzeAgentPerformance({ agentId: AG_A }))
    check("POS the agent's own analysis passes the gate and reaches the (counted) model", G.__S2.model === 1, { x, model: G.__S2.model })
    as(U_BROKER); x = await drive(() => tr.analyzeAgentPerformance({ agentId: AG_A }))
    check("POS tenant staff may analyze an agent of their own tenant", G.__S2.model === 1, { x, model: G.__S2.model })
  }

  // ═══ ai-voice-transcription ═══════════════════════════════════════════════════════════════════════════════════════
  section("5 · call intelligence (app/actions/ai-voice-transcription.ts)")
  {
    const vt = await load("app/actions/ai-voice-transcription.ts")
    as(U_BROKER); let x = await drive(() => vt.getAgentCallInsights({ agentId: AG_X, timeframe: "quarter" }))
    check("NEG getAgentCallInsights for another tenant's agent is refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_BROKER); x = await drive(() => vt.generateCallSummaryEmail({ analysisId: CA_X, recipientType: "client", agentId: AG_A }))
    check("NEG generateCallSummaryEmail on another tenant's analysis: not found, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(null); x = await drive(() => vt.generateCallSummaryEmail({ analysisId: u("5", 1), recipientType: "client", agentId: AG_A }))
    check("NEG no session: generateCallSummaryEmail refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => vt.getAgentCallInsights({ agentId: AG_A, timeframe: "quarter" }))
    check("POS the agent's own insights reach the (counted) model", G.__S2.model === 1, { x, model: G.__S2.model })
  }

  // ═══ source-analytics ═════════════════════════════════════════════════════════════════════════════════════════════
  section("6 · source analytics (app/actions/source-analytics.ts)")
  {
    const sa = await load("app/actions/source-analytics.ts")
    as(U_BROKER); let x = await drive(() => sa.generateSourceAIInsights(B2, []))
    check("NEG AI insights booked to ANOTHER tenant are refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    let m = as(U_BROKER); x = await drive(() => sa.emailSourceReport(B2, "outside@example.test", "Outside", "brokerage", { brokerageId: B2 }))
    check("NEG emailSourceReport naming another tenant is refused; nothing queued", refused(x) && T(m, "email_queue").length === 0, x)
    // A COMPLETE metrics row: with fields missing the export throws before its model and the canary would pass for the
    // wrong reason (measured at the base — the first draft of this check was green there).
    const metrics = { source: "zillow", source_family: "lead", raw_record_count: 0, lead_count: 4, contact_count: 2, lead_to_contact_rate: 50, appointment_count: 1, contact_to_appt_rate: 50, transaction_count: 1, closed_count: 1, close_rate: 50, total_spend: 100, revenue_attributed: 9000, roi_multiple: 90, cost_per_contact: 50 }
    as(null); x = await drive(() => sa.generateSourceAISummaryForSource(B1, metrics, [], []))
    check("NEG no session: per-source summary refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_BROKER); x = await drive(() => sa.generateSourceAIInsights(B1, []))
    check("POS the tenant's own insights reach the (counted) model", (x.r as any)?.success === true && G.__S2.model === 1, { x, model: G.__S2.model })
    // THE CALLER DOES NOT CHOOSE ITS OWN REPORT SCOPE (capToSessionScope). Two contacts from the same source, one per agent.
    const contactsSeen = (r: any) => ((r?.sources ?? []) as Array<{ source: string; contact_count: number }>).filter((s0) => s0.source === "zillow").reduce((n, s0) => n + (s0.contact_count ?? 0), 0)
    as(U_BROKER); x = await drive(() => sa.getSourcePerformance({ brokerageId: B1, agentIds: null }))
    check("POS a brokerage-wide seat asking for everything sees both agents' contacts", (x.r as any)?.success === true && contactsSeen(x.r) === 2, { r: (x.r as any)?.sources, threw: x.threw, error: (x.r as any)?.error })
    as(U_AGENT); x = await drive(() => sa.getSourcePerformance({ brokerageId: B1, agentIds: null }))
    check("NEG an agent posting `agentIds: null` (everything) gets ONLY their own work — not the brokerage's", (x.r as any)?.success === true && contactsSeen(x.r) === 1, { r: (x.r as any)?.sources, threw: x.threw, error: (x.r as any)?.error })
    as(U_AGENT); x = await drive(() => sa.getSourcePerformance({ brokerageId: B1, agentIds: [AG_B] }))
    check("NEG an agent naming a COLLEAGUE's agent id gets an empty report, never the colleague's figures", (x.r as any)?.success === true && contactsSeen(x.r) === 0, { r: (x.r as any)?.sources, threw: x.threw })
    as(U_BROKER); x = await drive(() => sa.getSourcePerformance({ brokerageId: B1, agentIds: [AG_B] }))
    check("POS a brokerage-wide seat may narrow to one agent", (x.r as any)?.success === true && contactsSeen(x.r) === 1, { r: (x.r as any)?.sources, threw: x.threw })
    as(null); x = await drive(() => sa.getSourcePerformance({ brokerageId: B1, agentIds: null }))
    check("NEG no session: refused", refused(x), x.r)
  }

  // ═══ ai-generate ══════════════════════════════════════════════════════════════════════════════════════════════════
  section("7 · model wrappers (app/actions/ai-generate.ts)")
  {
    const ag = await load("app/actions/ai-generate.ts")
    as(null); let x = await drive(() => ag.generateAIText("write a poem"))
    check("NEG no session: generateAIText refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(null); x = await drive(() => ag.generateChatResponse("hi", "ctx"))
    check("NEG no session: generateChatResponse refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); x = await drive(() => ag.generateAIText("write a poem"))
    check("POS a signed-in seat reaches the (counted) model", G.__S2.model === 1, { x, model: G.__S2.model })
  }

  // ═══ compliance-monitoring ════════════════════════════════════════════════════════════════════════════════════════
  section("8 · TRID and content approval (app/actions/compliance-monitoring.ts)")
  {
    const cm = await load("app/actions/compliance-monitoring.ts")
    let m = as(U_BROKER); let x = await drive(() => cm.createTRIDTimeline(TX_X))
    check("NEG createTRIDTimeline on another tenant's deal is refused; no trid_timeline row", !!x.threw && T(m, "trid_timeline").length === 0, x)
    m = as(U_AGENT); x = await drive(() => cm.reviewContentApproval({ approvalId: ACT1, reviewerId: U_AGENT, status: "approved" }))
    check("NEG an agent seat (not a reviewer on the roster) cannot decide an approval; activity unchanged", !!x.threw && T(m, "activities").find((r) => r.id === ACT1)?.status === "pending", x)
    m = as(U_BROKER); x = await drive(() => cm.reviewContentApproval({ approvalId: ACT1, reviewerId: U_AGENT2, status: "approved" }))
    check("NEG a body reviewerId naming someone else is refused; activity unchanged", !!x.threw && T(m, "activities").find((r) => r.id === ACT1)?.status === "pending", x)
    as(U_AGENT); x = await drive(() => cm.submitContentForApproval({ userId: U_AGENT2, contentType: "social", contentTitle: "t", contentBody: "b", targetAudience: "buyers", distributionChannels: ["email"], agentState: "FL" }))
    check("NEG submitting content in another person's name is refused", !!x.threw && /own name|Forbidden/.test(x.threw ?? ""), x)
    m = as(U_BROKER); x = await drive(() => cm.createTRIDTimeline(TX1))
    check("POS createTRIDTimeline on the tenant's own deal writes the row", !x.threw && T(m, "trid_timeline").some((r) => r.transaction_id === TX1), x)
  }

  // ═══ push-listing-to-seller-portal ════════════════════════════════════════════════════════════════════════════════
  section("9 · push a listing to the seller's portal (app/actions/push-listing-to-seller-portal.ts)")
  {
    const pl = await load("app/actions/push-listing-to-seller-portal.ts")
    let m = as(null); let x = await drive(() => pl.pushListingToSellerPortal({ listingId: L_A, brokerageId: B1, userId: U_AGENT }))
    check("NEG no session: refused; no seller notification", refused(x) && T(m, "notifications").length === 0, x)
    m = as(U_AGENT2); x = await drive(() => pl.pushListingToSellerPortal({ listingId: L_A, brokerageId: B1, userId: U_AGENT2 }))
    check("NEG a colleague (not the listing's agent, not staff) is refused; no notification", refused(x) && T(m, "notifications").length === 0, x)
    m = as(U_AGENT); x = await drive(() => pl.pushListingToSellerPortal({ listingId: L_A, brokerageId: B1, userId: U_AGENT2 }))
    check("NEG a body userId naming someone else is refused", refused(x) && T(m, "notifications").length === 0, x)
    m = as(U_AGENT); x = await drive(() => pl.pushListingToSellerPortal({ listingId: L_A, brokerageId: B1, userId: U_AGENT }))
    const receipt = T(m, "agent_action_ledger").find((r) => r.action === "listing.seller_share.push")
    check("POS the listing's own agent pushes: success and the seller's bell rings", (x.r as any)?.success === true && T(m, "notifications").some((r) => r.user_id === C_SELLER_USER), x)
    check("POS …and ONE receipt names the session actor and tenant (G12)", !!receipt && receipt.actor_user_id === U_AGENT && receipt.brokerage_id === B1, receipt)
  }

  // ═══ ai-referral-management ═══════════════════════════════════════════════════════════════════════════════════════
  section("10 · referral opportunities (app/actions/ai-referral-management.ts)")
  {
    const rf = await load("app/actions/ai-referral-management.ts")
    as(U_AGENT); const x = await drive(() => rf.identifyReferralOpportunities(AG_B))
    check("NEG mining a colleague's sphere is refused (the sibling's own-agent rule), 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); const y = await drive(() => rf.identifyReferralOpportunities(AG_A))
    check("POS the agent's own sphere is not refused by the gate", !(y.r as any)?.error || !/Forbidden|Unauthorized/.test((y.r as any).error), y)
  }

  // ═══ ai-calendar-management ═══════════════════════════════════════════════════════════════════════════════════════
  section("11 · calendar (app/actions/ai-calendar-management.ts)")
  {
    const cal = await load("app/actions/ai-calendar-management.ts")
    const block = (agentId: string) => cal.blockCalendarTime({ agentId, startTime: "2026-12-01T09:00:00Z", endTime: "2026-12-01T10:00:00Z", title: "Prospecting", type: "prospecting" })
    let m = as(U_AGENT); let x = await drive(() => block(AG_B))
    check("NEG blocking a colleague's calendar is refused; no block written", refused(x) && T(m, "calendar_blocks").length === 0, x)
    m = as(U_BROKER); x = await drive(() => block(AG_X))
    check("NEG a broker blocking ANOTHER tenant's agent is refused; no block written", refused(x) && T(m, "calendar_blocks").length === 0, x)
    m = as(null); x = await drive(() => block(AG_A))
    check("NEG no session: refused; no block written", refused(x) && T(m, "calendar_blocks").length === 0, x)
    m = as(U_AGENT); x = await drive(() => block(AG_A))
    check("POS the agent blocks its own calendar", (x.r as any)?.success === true && T(m, "calendar_blocks").some((r) => r.agent_id === AG_A), x)
    m = as(U_BROKER); x = await drive(() => block(AG_A))
    check("POS tenant staff may block an agent of their own tenant", (x.r as any)?.success === true && T(m, "calendar_blocks").length === 1, x)
  }

  // ═══ ai-predictions ═══════════════════════════════════════════════════════════════════════════════════════════════
  section("12 · predictions and auto-pilot (app/actions/ai-predictions.ts)")
  {
    const pr = await load("app/actions/ai-predictions.ts")
    let m = as(null); let x = await drive(() => pr.toggleAutoPilot(PLAN1, true))
    check("NEG no session: toggleAutoPilot refused; plan unchanged", refused(x) && T(m, "ai_autopilot_plans").find((r) => r.id === PLAN1)?.is_active === true, x)
    m = as(U_BROKER); x = await drive(() => pr.toggleAutoPilot(PLAN_X, true))
    check("NEG another tenant's plan: not found (zero rows is not success); unchanged", refused(x) && T(m, "ai_autopilot_plans").find((r) => r.id === PLAN_X)?.is_active === true, x)
    as(U_AGENT); x = await drive(() => pr.getActiveAutoPilotPlans(U_AGENT))
    check("POS getActiveAutoPilotPlans(the session's users.id) finds the agent's plan — crossed via agents.user_id (§3)", Array.isArray(x.r) && (x.r as Row[]).some((p) => p.id === PLAN1), x)
    as(U_AGENT); x = await drive(() => pr.getActiveAutoPilotPlans(U_X))
    check("NEG naming another user returns nothing", Array.isArray(x.r) && (x.r as Row[]).length === 0, x)
    m = as(U_AGENT); G.__S2.json = { touchpoints: [{ day: 1, channel: "email" }] }
    x = await drive(() => pr.enableAIPilot({ agentId: U_AGENT, leadId: C_A, autopilotLevel: "moderate" }))
    const plan = T(m, "ai_autopilot_plans").find((r) => r.id !== PLAN1 && r.id !== PLAN_X)
    check("POS enableAIPilot(the session's users.id) files the plan under the AGENTS id (ai_autopilot_plans.agent_id → agents)", !!plan && plan.agent_id === AG_A && plan.brokerage_id === B1, { x, plan })
    m = as(U_AGENT); G.__S2.json = { touchpoints: [{ day: 1 }] }
    x = await drive(() => pr.enableAIPilot({ agentId: U_AGENT, leadId: C_X, autopilotLevel: "moderate" }))
    check("NEG enableAIPilot on ANOTHER tenant's contact is refused BEFORE the model; no plan", refused(x) && G.__S2.model === 0 && T(m, "ai_autopilot_plans").length === 2, { x, model: G.__S2.model })
    as(U_BROKER); x = await drive(() => pr.predictDealCloseProbability(TX_X))
    check("NEG predictDealCloseProbability on another tenant's deal: refused, 0 model calls", !!x.threw && G.__S2.model === 0, { x, model: G.__S2.model })
    as(null); x = await drive(() => pr.findHiddenOpportunities(AG_A))
    check("NEG no session: findHiddenOpportunities refused, 0 model calls", !!x.threw && G.__S2.model === 0, { x, model: G.__S2.model })
  }

  // ═══ open-house-automation (TRUTH) ════════════════════════════════════════════════════════════════════════════════
  section("13 · open house — unmeasured is unknown (app/actions/open-house-automation.ts)")
  {
    const oh = await load("app/actions/open-house-automation.ts")
    as(U_AGENT); let x = await drive(() => oh.optimizeOpenHouseTiming({ propertyId: L_A, agentId: "not-a-uuid" }))
    const s = JSON.stringify(x.r ?? null)
    check("TRUTH an invalid id returns a refusal — no invented timing scores (no 92 / 88)", (x.r as any)?.success === false && !/"score"\s*:\s*(92|88)/.test(s) && !/recommended_times/.test(s), x.r)
    as(U_AGENT); x = await drive(() => oh.generatePerformanceInsights("not-a-uuid"))
    check("TRUTH an invalid event id returns { error } — no invented grade (no B+)", !!(x.r as any)?.error && !/B\+/.test(JSON.stringify(x.r)), x.r)
    as(null); x = await drive(() => oh.optimizeOpenHouseTiming({ propertyId: L_A, agentId: AG_A }))
    check("NEG no session: timing refused, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_X); x = await drive(() => oh.optimizeOpenHouseTiming({ propertyId: L_A, agentId: AG_X }))
    check("NEG another tenant's listing: not found, 0 model calls", refused(x) && G.__S2.model === 0, { x, model: G.__S2.model })
    as(U_AGENT); G.__S2.modelText = JSON.stringify({ recommended_times: [{ date: "2026-12-05", time: "13:00-15:00", reasoning: "r" }] })
    x = await drive(() => oh.optimizeOpenHouseTiming({ propertyId: L_A, agentId: AG_A }))
    check("POS real advice comes back with success: true (the caller renders only that) and an ungiven score stays null", (x.r as any)?.success === true && (x.r as any)?.recommended_times?.[0]?.score === null && G.__S2.model === 1, x.r)
  }

  // ═══ title-portal (BUG) ═══════════════════════════════════════════════════════════════════════════════════════════
  section("14 · title note to the agent (app/actions/title-portal.ts sendTitleMessageToAgent)")
  {
    const tp = await load("app/actions/title-portal.ts")
    const m = as(u("a", 7)); const x = await drive(() => tp.sendTitleMessageToAgent({ transactionId: TX1, message: "Title commitment is in." }))

    check("BUG no agents.id is written into a contacts column (client_portal_messages untouched)", !T(m, "client_portal_messages").some((r) => r.contact_id === AG_A) && T(m, "client_portal_messages").length === 0, T(m, "client_portal_messages"))
    check("POS the note reaches the agent's USER seat (agents.id → users.id via agents.user_id)", (x.r as any)?.success === true && T(m, "notifications").some((r) => r.user_id === U_AGENT && r.entity_id === TX1), { x, n: T(m, "notifications") })
    check("POS …and its durable record is on the DEAL'S TIMELINE (activities.transaction_id — the table the deal page reads), with the agents.id in an AGENTS column, the session tenant and no contact",
      T(m, "activities").some((r) => r.activity_type === "title_message" && r.transaction_id === TX1 && r.agent_id === AG_A && r.brokerage_id === B1 && !r.contact_id) && T(m, "communications").length === 0, T(m, "activities").filter((r) => r.activity_type === "title_message"))
    check("…and the deal page really reads that table by transaction (a durable record nobody reads is not a record)",
      /\.from\("activities"\)[\s\S]{0,200}?\.eq\("transaction_id",\s*transactionId\)/.test(readFileSync(join(ROOT, "app/transactions/[transactionId]/page.tsx"), "utf8")))

    // 14b. THE TABLES A VENDOR SEAT IS REFUSED BY POLICY (integrator, wave 155 — LIVE-VERIFIED 2026-11-20 against pg_policies:
    // transaction_title_escrow admits the deal's agents and broker / admin / tc seats; closing_disclosure_agreement admits
    // financial readers). The in-memory client has no row-level security, so a session-client read of either passes every driven
    // check and is successfully EMPTY in production — the title dashboard, the deal's title record, the status update and the
    // "is there a CDA?" branch all were. The rule, on stripped source: in this file every `.from(` of those two tables hangs
    // off the SERVICE client, and the file calls the title gate (the service client is only ever the second step — §4).
    const { stripComments: strip14 } = await import("./strip-comments")
    const VENDOR_REFUSED = ["transaction_title_escrow", "closing_disclosure_agreement"] as const
    /** PURE — `.from("<table>")` sites in `code` whose receiver is not the service client (directly, or a name bound to it). */
    const sessionReadsOf = (code: string): string[] => {
      const out: string[] = []
      for (const t of VENDOR_REFUSED) {
        const re = new RegExp(`([\\w$]+(?:\\(\\))?)\\s*\\.from\\(\\s*"${t}"\\s*\\)`, "g")
        for (let m = re.exec(code); m; m = re.exec(code)) {
          const recv = m[1]
          if (recv === "createServiceClient()") continue
          // a NAME: the nearest binding of it above the site must be the service client
          const name = recv.replace(/\(\)$/, "")
          const binds = [...code.slice(0, m.index).matchAll(new RegExp(`(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*([^\\n]+)`, "g"))]
          const last = binds[binds.length - 1]?.[1] ?? ""
          if (!/^createServiceClient\(\)/.test(last.trim())) out.push(`${t} via ${recv}`)
        }
      }
      return out
    }
    const tpSrc = strip14(readFileSync(join(ROOT, "app/actions/title-portal.ts"), "utf8"))
    const sites = (tpSrc.match(/\.from\(\s*"(?:transaction_title_escrow|closing_disclosure_agreement)"\s*\)/g) ?? []).length
    check(`title portal: all ${sites} reads / writes of the two tables a vendor seat is refused by policy run on the service client, after the title gate`,
      sites >= 4 && sessionReadsOf(tpSrc).length === 0 && /requireTitleVendorActor\(/.test(tpSrc), sessionReadsOf(tpSrc))
    check("POSITIVE CONTROL: the same read on the session client IS seen (directly, and through a name bound to createClient)",
      sessionReadsOf(`const supabase = await createClient()\nconst { data } = await supabase.from("transaction_title_escrow").select("*")`).length === 1
      && sessionReadsOf(`const db = await createClient()\nawait db\n  .from("closing_disclosure_agreement").select("id")`).length === 1)
    check("NEGATIVE CONTROL: the service client is accepted directly and through a bound name; a later rebinding to the session client is seen again",
      sessionReadsOf(`await createServiceClient().from("transaction_title_escrow").select("*")`).length === 0
      && sessionReadsOf(`const supabase = createServiceClient()\nawait supabase.from("closing_disclosure_agreement").select("id")`).length === 0
      && sessionReadsOf(`const supabase = createServiceClient()\nasync function g() { const supabase = await createClient()\nawait supabase.from("transaction_title_escrow").select("*") }`).length === 1)
  }

  // ═══ chat stream route (BUG) ══════════════════════════════════════════════════════════════════════════════════════
  section("15 · agent chat stream (app/api/chat/stream/route.ts)")
  {
    const route = await load("app/api/chat/stream/route.ts")
    const req = (body: Row) => ({ json: async () => body }) as any
    as(U_AGENT); const { r } = await drive(() => route.POST(req({ sessionId: CONV1, message: "How can I help you find the right home?" })))
    const res = r as Response | undefined
    const text = res ? await res.text().catch(() => "") : ""
    check("BUG FIXED the route streams an answer (200, event-stream carrying the model's text) instead of a 500", res?.status === 200 && /Hi there/.test(text) && /"done":true/.test(text), { status: res?.status, text: text.slice(0, 200) })
    check("…through the COUNTED model seam, exactly once", G.__S2.model === 1, G.__S2.model)
    as(null); const n = await drive(() => route.POST(req({ sessionId: CONV1, message: "hi" })))
    check("NEG no session: 401, 0 model calls", (n.r as Response | undefined)?.status === 401 && G.__S2.model === 0, (n.r as Response | undefined)?.status)
  }

  // ═══ strategy-session ═════════════════════════════════════════════════════════════════════════════════════════════
  section("16 · seller floor (app/actions/strategy-session.ts setSellerFloorAction)")
  {
    const ss = await load("app/actions/strategy-session.ts")
    let m = as(U_AGENT2); let x = await drive(() => ss.setSellerFloorAction({ listingId: L_A, floor: 420000 }))
    check("NEG a colleague (not the listing's agent, not staff) cannot set the seller's floor; unchanged", refused(x) && T(m, "listings").find((r) => r.id === L_A)?.seller_walkaway_price === null, x)
    m = as(U_BROKER); x = await drive(() => ss.setSellerFloorAction({ listingId: L_X, floor: 420000 }))
    check("NEG another tenant's listing: not found; unchanged", refused(x) && T(m, "listings").find((r) => r.id === L_X)?.seller_walkaway_price === null, x)
    m = as(U_AGENT); x = await drive(() => ss.setSellerFloorAction({ listingId: L_A, floor: 420000 }))
    check("POS the listing's own agent sets it", (x.r as any)?.ok === true && T(m, "listings").find((r) => r.id === L_A)?.seller_walkaway_price === 420000, x)
    m = as(U_BROKER); x = await drive(() => ss.setSellerFloorAction({ listingId: L_A, floor: 430000 }))
    check("POS tenant staff set it", (x.r as any)?.ok === true && T(m, "listings").find((r) => r.id === L_A)?.seller_walkaway_price === 430000, x)
  }

  // ═══ the four rows the corrected census exposed in this lane's files (integrator) ═══════════════════════════════════════
  section("17 · receipts and gates on four session writes (attendance forecast, fair-housing review, coaching booking, competitive intel)")
  {
    const receipts = (m: MemClient, action: string) => T(m, "agent_action_ledger").filter((r) => r.action === action)
    const oh = await load("app/actions/open-house-automation.ts")
    let m = as(U_AGENT); let x = await drive(() => oh.predictAttendance("not-a-uuid"))
    check("TRUTH an invalid event id is refused — no invented forecast (no 12 / 18 / 24, no confidence 0.78), 0 model calls",
      refused(x) && !/predicted_attendance|confidence_level|serious_buyers/.test(JSON.stringify(x.r ?? null)) && G.__S2.model === 0, x.r)
    m = as(null); x = await drive(() => oh.predictAttendance(EV1))
    check("NEG no session: the forecast is refused, 0 model calls, no receipt", refused(x) && G.__S2.model === 0 && T(m, "agent_action_ledger").length === 0, { x, model: G.__S2.model })
    m = as(U_AGENT); x = await drive(() => oh.predictAttendance(EV_X))
    check("NEG another tenant's open house: not found, 0 model calls, its row unchanged", refused(x) && G.__S2.model === 0 && T(m, "open_house_events").find((r) => r.id === EV_X)?.attendance_prediction === null, { x, model: G.__S2.model })
    m = as(U_AGENT); G.__S2.modelText = JSON.stringify({ predicted_attendance_low: 3, predicted_attendance_mid: 7, predicted_attendance_high: 9 })
    x = await drive(() => oh.predictAttendance(EV1))
    const fr = receipts(m, "open_house.attendance.predict")
    check("POS the tenant's own event: the model's forecast comes back, is stored on the event, and leaves ONE receipt for the session tenant",
      (x.r as any)?.predicted_attendance_mid === 7 && G.__S2.model === 1 && T(m, "open_house_events").find((r) => r.id === EV1)?.attendance_prediction === 7 && fr.length === 1 && fr[0].brokerage_id === B1, { r: x.r, threw: x.threw, receipts: fr.length })

    const cm = await load("app/actions/compliance-monitoring.ts")
    m = as(null); x = await drive(() => cm.analyzeFairHousingRisk({ contactId: C_A, interactionType: "email", communicationText: "perfect for families" }))
    check("NEG no session: the fair-housing review is refused, 0 model calls, no receipt", refused(x) && G.__S2.model === 0 && T(m, "agent_action_ledger").length === 0, { x, model: G.__S2.model })
    m = as(U_AGENT); x = await drive(() => cm.analyzeFairHousingRisk({ contactId: C_X, interactionType: "email", communicationText: "perfect for families" }))
    check("NEG another tenant's contact: refused before the model; the receipt it leaves is the session tenant's, never the other tenant's",
      refused(x) && G.__S2.model === 0 && T(m, "agent_action_ledger").every((r) => r.brokerage_id === B1), { x, model: G.__S2.model })
    m = as(U_AGENT); G.__S2.modelText = JSON.stringify({ risk_score: 80, protected_class_mentioned: true, steering_detected: true, flagged_content: ["perfect for families"], explanation: "e", recommendation: "r" })
    x = await drive(() => cm.analyzeFairHousingRisk({ contactId: C_A, interactionType: "email", communicationText: "perfect for families" }))
    check("POS a review of the tenant's own contact leaves ONE receipt (compliance.fair_housing.review) for the session tenant",
      receipts(m, "compliance.fair_housing.review").length === 1 && receipts(m, "compliance.fair_housing.review")[0].brokerage_id === B1, { r: x.r, threw: x.threw })

    const cp = await load("app/actions/copilot.ts")
    const booking = (user_id: string) => ({ user_id, session_date: "2026-12-01T15:00:00.000Z", coach_id: U_BROKER, topic: "Listing presentations" })
    m = as(U_BROKER); x = await drive(() => cp.handleCoachingSessionBooked(booking(U_X)))
    check("NEG a roster seat naming ANOTHER tenant's user books nothing there (no calendar event, no task, no receipt)",
      refused(x) && T(m, "calendar_events").length === 0 && T(m, "tasks").length === 0 && T(m, "agent_action_ledger").length === 0, x)
    m = as(U_AGENT); x = await drive(() => cp.handleCoachingSessionBooked(booking(U_AGENT)))
    const br = receipts(m, "coaching.session.book")
    check("POS an agent books their own session: one calendar event and one task in the session tenant, ONE receipt",
      (x.r as any)?.success === true && T(m, "calendar_events").length === 1 && T(m, "calendar_events")[0].brokerage_id === B1 && T(m, "tasks").length === 1 && br.length === 1 && br[0].brokerage_id === B1, { r: x.r, threw: x.threw, receipts: br.length })

    // competitiveIntelligence reads a live IDX feed (not simulated here), so its receipt is held on the stripped source: the
    // gate comes first, the model call sits inside the receipt, and a refused claim throws.
    const { stripComments } = await import("./strip-comments")
    const { readFileSync } = await import("node:fs")
    const gatedThenReceipted = (src: string): boolean => {
      const at = src.search(/export async function competitiveIntelligence\b/)
      if (at < 0) return false
      const body = src.slice(at, src.indexOf("\nexport async function ", at + 10) < 0 ? undefined : src.indexOf("\nexport async function ", at + 10))
      const gate = body.search(/\brequirePredictionAgent\s*\(/), receipt = body.search(/\bledgerSessionAction\s*\(/), model = body.search(/\bgenerateAIJSON\s*\(/)
      return gate >= 0 && receipt > gate && model > receipt && /brokerageId:\s*intelCaller\.brokerageId/.test(body) && /if\s*\(\s*!intelRan\s*\)\s*throw\b/.test(body)
    }
    check("competitiveIntelligence: gate → receipt against the SESSION tenant → model inside the receipt; a refused claim throws",
      gatedThenReceipted(stripComments(readFileSync(join(ROOT, "app/actions/ai-predictions.ts"), "utf8"))))
    check("POSITIVE CONTROL: a model call outside any receipt is refused by the finder",
      !gatedThenReceipted(`export async function competitiveIntelligence(data) { const intelCaller = await requirePredictionAgent(data.agentId); const intel = await generateAIJSON(prompt); return { success: true, intel } }`))
    check("POSITIVE CONTROL: a receipt opened before the gate is refused by the finder",
      !gatedThenReceipted(`export async function competitiveIntelligence(data) { const r = await ledgerSessionAction({ brokerageId: intelCaller.brokerageId }, async () => generateAIJSON(prompt)); const intelCaller = await requirePredictionAgent(data.agentId); if (!intelRan) throw new Error("x"); return r }`))
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("❌ WAVE155_UNGATED_DEAL_FAIL"); process.exit(1) }
  console.log("✅ WAVE155_UNGATED_DEAL_PASS — deal-side and AI exports take tenant and person from the session; the truth bugs stay fixed")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
