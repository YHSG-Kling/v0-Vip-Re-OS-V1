/**
 * scripts/ledger-receipts-platform2-guard.ts — wave 155, lane 155R11 (G12 list "platform2").
 *
 * The rows on this list were signed-in users' writes (settings, admin, onboarding and CRM writes) that left NO receipt on
 * agent_action_ledger. Each mutating export now runs inside `ledgerSessionAction` (lib/kernel/action-ledger.ts) with the
 * SESSION's user and tenant, a three-segment action, the subject row and a risk class.
 *
 *   §A DRIVEN (SIMULATED, in-memory client, no provider, no model): per driven module, one export is called against
 *      memSupabase with the session stubbed —
 *        · exactly ONE receipt: actor_user_id = the session user, brokerage_id = the session tenant, the expected
 *          domain.entity.action, subject_type, risk_class, reason_code HUMAN_REQUESTED, status executed;
 *        · the NO-KEY canary: the same call twice writes TWO receipts and the write runs twice (no idempotency key —
 *          a person's second save is never a silent replay);
 *        · a refused write settles the receipt `failed`;
 *        · RED AT THE BASE: before this lane the same calls wrote zero receipts.
 *   §B STATIC (stripped source): every export on the row list reaches `ledgerSessionAction` (directly or through the one
 *      named delegate), every action name at those calls is domain.entity.action, and NO call passes `cycle` /
 *      `idempotencyKey`. POSITIVE CONTROLS: the finder flags a planted export without the helper, a two-segment name
 *      and a planted key.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"

const ROOT = process.cwd()
const _require = createRequire(import.meta.url)
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const A = u(1), U = u(11), AG = u(21), T1 = u(31), X = u(41), V = u(42), C = u(43)
const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

// ─── the session stubs (installed BEFORE any app module loads) ──────────────────────────────────────────────────────
let MEM: MemClient = memSupabase({})
let USER_TYPE = "broker"
const withAuth = (c: MemClient): MemClient => Object.assign(c, { auth: { getUser: async () => ({ data: { user: { id: U, email: "broker@example.test" } }, error: null }) } })
const agentCtx = () => ({ userId: U, agentId: AG, brokerageId: A, teamId: null, userType: USER_TYPE, role: USER_TYPE, isAuthenticated: true, isImpersonating: false, impersonatorUserId: null, impersonationMode: null })
const writeCtx = () => ({ ok: true as const, userId: U, actorUserId: U, impersonatorUserId: null, brokerageId: A, agentId: AG, userType: USER_TYPE, db: MEM, readOnly: false })
{
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  const key = (r: string) => r.replace(/^@\//, "").replace(/\\/g, "/").replace(/\.tsx?$/, "")
  const is = (r: string, k: string) => { const n = key(r); return n === k || n.endsWith(`/${k}`) }
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    if (is(request, "lib/supabase/service")) return { createServiceClient: () => MEM }
    if (is(request, "lib/supabase/server")) return { createClient: async () => MEM }
    if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }
    if (request === "next/headers") return { headers: async () => new Map([["user-agent", "guard"]]), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, toString: () => "" }) }
    if (request === "@supabase/supabase-js") return { ...realLoad.call(this, request, ...rest), createClient: () => MEM }
    if (is(request, "lib/identity/get-agent-context")) return { ...realLoad.call(this, request, ...rest), getAgentContext: async () => agentCtx() }
    if (is(request, "lib/platform/acting-context")) return { ...realLoad.call(this, request, ...rest), resolveActingContext: async () => writeCtx(), resolveWriteContext: async () => writeCtx(), resolveWriteContextForTenant: async () => writeCtx() }
    return realLoad.call(this, request, ...rest)
  }
  // The guard is an ES module, so app modules arrive through the ESM loader, where Module._load is never consulted: the
  // SAME stubs are installed there. A module where one function is replaced re-exports the real module (`export *`) and
  // shadows only that name; every replacement calls into globalThis.__R11__ so the stub reads the CURRENT case's state.
  ;(globalThis as any).__R11__ = {
    createServiceClient: () => MEM, createClient: async () => MEM, supabaseJsClient: () => MEM,
    getAgentContext: async () => agentCtx(), writeCtx: async () => writeCtx(),
    headers: async () => new Map([["user-agent", "guard"]]), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [], toString: () => "" }),
  }
  const SHIMS: Record<string, string> = {
    "lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__R11__.createServiceClient(...a)",
    "lib/supabase/server": "export const createClient = (...a) => globalThis.__R11__.createClient(...a)",
    "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}",
    "next/headers": "export const headers = (...a) => globalThis.__R11__.headers(...a); export const cookies = (...a) => globalThis.__R11__.cookies(...a); export const draftMode = async () => ({ isEnabled: false })",
    "server-only": "export {}",
  }
  const PARTIAL: Record<string, string> = {
    "@supabase/supabase-js": "export const createClient = (...a) => globalThis.__R11__.supabaseJsClient(...a)",
    "lib/identity/get-agent-context": "export const getAgentContext = (...a) => globalThis.__R11__.getAgentContext(...a)",
    "lib/platform/acting-context": "export const resolveActingContext = (...a) => globalThis.__R11__.writeCtx(...a); export const resolveWriteContext = (...a) => globalThis.__R11__.writeCtx(...a); export const resolveWriteContextForTenant = (...a) => globalThis.__R11__.writeCtx(...a)",
  }
  const loader = `
const SHIMS = ${JSON.stringify(SHIMS)}, PARTIAL = ${JSON.stringify(PARTIAL)};
const norm = (s) => String(s).split(String.fromCharCode(92)).join("/").replace("file://", "").replace(/^@[/]/, "").replace(/[.](ts|tsx|js|mjs)$/, "");
const hit = (table, s) => Object.keys(table).find((k) => { const n = norm(s); return n === k || n.endsWith("/" + k) || n.endsWith("/node_modules/" + k + "/index") });
export async function resolve(specifier, context, next) {
  const k1 = hit(SHIMS, specifier); if (k1) return { shortCircuit: true, url: "vipre-r11:" + encodeURIComponent(k1) };
  const r = await next(specifier, context);
  const k2 = hit(SHIMS, r.url ?? ""); if (k2) return { shortCircuit: true, url: "vipre-r11:" + encodeURIComponent(k2) };
  const p = hit(PARTIAL, specifier) ?? (r.url && !String(r.url).startsWith("vipre-") && !(context.parentURL ?? "").startsWith("vipre-r11p:") ? hit(PARTIAL, r.url) : undefined);
  if (p && !(context.parentURL ?? "").startsWith("vipre-r11p:")) return { shortCircuit: true, url: "vipre-r11p:" + encodeURIComponent(p) + "?real=" + encodeURIComponent(r.url) };
  return r;
}
export async function load(url, context, next) {
  if (url.startsWith("vipre-r11:")) return { shortCircuit: true, format: "module", source: SHIMS[decodeURIComponent(url.slice(10))] };
  if (url.startsWith("vipre-r11p:")) {
    const [k, q] = url.slice(11).split("?real=");
    const real = decodeURIComponent(q);
    return { shortCircuit: true, format: "module", source: "export * from " + JSON.stringify(real) + "; " + PARTIAL[decodeURIComponent(k)] };
  }
  return next(url, context);
}`
  const { register } = await import("node:module")
  register(`data:text/javascript,${encodeURIComponent(loader)}`)
}

interface Case {
  mod: string; fn: string; userType?: string
  seed: () => Record<string, Row[]>
  call: (m: any) => Promise<unknown>
  action: string; subjectType: string; risk: string
  /** the business table whose write must run on every call */
  table: string
  /** a refusal of `table` must settle the receipt failed (only set where the export reads the write's error) */
  failCheck?: boolean
}
const users = (over: Row = {}): Row[] => [{ id: U, brokerage_id: A, user_type: USER_TYPE, email: "broker@example.test", ...over }]
const agents = (): Row[] => [{ id: AG, user_id: U, brokerage_id: A, is_active: true }]

const CASES: Case[] = [
  { mod: "app/actions/ai-teammates", fn: "setAiTeammateStatusAction", seed: () => ({ users: users(), tenant_ai_teammates: [{ id: X, brokerage_id: A, name: "Maya", status: "active" }] }), call: (m) => m.setAiTeammateStatusAction({ id: X, status: "paused" }), action: "tenant.ai_teammate.set_status", subjectType: "tenant_ai_teammate", risk: "LOW_RISK_WRITE", table: "tenant_ai_teammates", failCheck: true },
  { mod: "app/actions/embed-widgets", fn: "updateEmbed", seed: () => ({ embed_widgets: [{ id: X, brokerage_id: A, agent_id: null }] }), call: (m) => m.updateEmbed({ id: X, label: "Site" }), action: "tenant.embed_widget.update", subjectType: "embed_widget", risk: "LOW_RISK_WRITE", table: "embed_widgets", failCheck: true },
  { mod: "app/actions/income-engine", fn: "dismissRecommendedActionAction", seed: () => ({ users: users(), agents: agents(), income_gap_recommended_actions: [{ id: X, agent_id: AG, status: "open" }] }), call: (m) => m.dismissRecommendedActionAction({ actionId: X }), action: "income.recommended_action.dismiss", subjectType: "income_gap_recommended_action", risk: "LOW_RISK_WRITE", table: "income_gap_recommended_actions", failCheck: true },
  { mod: "app/actions/onboarding/progress", fn: "dismissCelebration", seed: () => ({ users: users(), agents: agents(), agent_onboarding: [{ id: X, agent_id: AG, brokerage_id: A }] }), call: (m) => m.dismissCelebration(), action: "onboarding.celebration.dismiss", subjectType: "user", risk: "LOW_RISK_WRITE", table: "agent_onboarding", failCheck: true },
  { mod: "app/actions/pattern-actions", fn: "acknowledgePattern", seed: () => ({ pattern_detections: [{ id: X, brokerage_id: A, status: "active" }] }), call: (m) => m.acknowledgePattern(X), action: "intel.pattern_detection.set_status", subjectType: "pattern_detection", risk: "LOW_RISK_WRITE", table: "pattern_detections", failCheck: true },
  { mod: "app/actions/reputation-kernel", fn: "markGiftSentAction", seed: () => ({ agents: agents(), client_gifts: [{ id: X, agent_id: AG, brokerage_id: A, status: "recommended" }] }), call: (m) => m.markGiftSentAction(X, 40), action: "reputation.client_gift.mark_sent", subjectType: "client_gift", risk: "FINANCIAL", table: "client_gifts", failCheck: true },
  { mod: "app/actions/settings/revenue-share-setting", fn: "setRevenueShareEnabled", seed: () => ({ brokerages: [{ id: A, plan_tier: "brokerage" }] }), call: (m) => m.setRevenueShareEnabled(true), action: "finance.revenue_share.set_enabled", subjectType: "brokerage", risk: "FINANCIAL", table: "brokerages" },
  { mod: "app/actions/settings/territories", fn: "setTerritoryActive", userType: "agent", seed: () => ({ users: users(), teams: [], subscriber_service_areas: [{ id: X, brokerage_id: A, zip_code: "32541", team_id: null, agent_user_id: U, active: true, is_primary: false }] }), call: (m) => m.setTerritoryActive(X, false), action: "tenant.territory.set_active", subjectType: "subscriber_service_area", risk: "LOW_RISK_WRITE", table: "subscriber_service_areas" },
  { mod: "app/dashboard/wealth/actions", fn: "markWealthActed", seed: () => ({ agents: agents(), wealth_advisor_recommendations: [{ id: X, agent_id: AG, status: "new" }] }), call: (m) => m.markWealthActed(X), action: "wealth.recommendation.mark_acted", subjectType: "wealth_advisor_recommendation", risk: "LOW_RISK_WRITE", table: "wealth_advisor_recommendations", failCheck: true },
  { mod: "app/actions/activities", fn: "completeActivity", seed: () => ({ activities: [{ id: X, brokerage_id: A, status: "pending" }] }), call: (m) => m.completeActivity(X, "seller said spring"), action: "crm.activity.complete", subjectType: "activity", risk: "LOW_RISK_WRITE", table: "activities", failCheck: true },
  { mod: "app/actions/admin/onboarding-steps", fn: "deleteOnboardingStepAction", seed: () => ({ onboarding_steps: [{ id: X, brokerage_id: A }, { id: V, brokerage_id: A }] }), call: (m) => m.deleteOnboardingStepAction(MEM.tables.onboarding_steps?.[0]?.id ?? X), action: "onboarding.curriculum_step.delete", subjectType: "onboarding_step", risk: "LOW_RISK_WRITE", table: "onboarding_steps" },
  { mod: "app/actions/admin/team-members", fn: "removeTeamMember", seed: () => ({ team_members: [{ id: X, brokerage_id: A, team_id: T1, is_active: true }] }), call: (m) => m.removeTeamMember(X), action: "team.member.remove", subjectType: "team_member", risk: "FINANCIAL", table: "team_members" },
  { mod: "app/actions/ai-client-gifting", fn: "createVendor", seed: () => ({ gift_vendors: [] }), call: (m) => m.createVendor({ name: "Bloom & Co", category: "florist" }), action: "reputation.gift_vendor.create", subjectType: "gift_vendor", risk: "LOW_RISK_WRITE", table: "gift_vendors", failCheck: true },
  { mod: "app/actions/challenges", fn: "enrollInChallenge", userType: "agent", seed: () => ({ agents: agents(), challenges: [{ id: X, brokerage_id: A, team_id: null, status: "active" }], challenge_participants: [] }), call: (m) => m.enrollInChallenge({ challengeId: X }), action: "recruiting.challenge.enroll", subjectType: "challenge", risk: "LOW_RISK_WRITE", table: "challenge_participants" },
  { mod: "app/actions/negotiation-strategy", fn: "dismissStrategyAction", userType: "agent", seed: () => ({ users: users(), negotiation_strategies: [{ id: X, brokerage_id: A, status: "open" }] }), call: (m) => m.dismissStrategyAction(X, "not now"), action: "transaction.negotiation_strategy.dismiss", subjectType: "negotiation_strategy", risk: "LOW_RISK_WRITE", table: "negotiation_strategies", failCheck: true },
  { mod: "app/actions/public/tos-acceptance", fn: "acceptCurrentTosAsCurrentUserAction", seed: () => ({ users: users(), platform_settings: [{ id: X, tos_version: "2026-07-01" }], platform_tos_acceptances: [] }), call: (m) => m.acceptCurrentTosAsCurrentUserAction(), action: "platform.tos_acceptance.accept", subjectType: "user", risk: "LEGAL", table: "platform_tos_acceptances" },
  { mod: "app/actions/settings/global-settings-actions", fn: "setByoCarrierPolicy", seed: () => ({ users: users(), global_settings: [{ id: X, brokerage_id: A, additional_settings: {} }] }), call: (m) => m.setByoCarrierPolicy(true), action: "tenant.byo_carrier_policy.set", subjectType: "brokerage", risk: "LOW_RISK_WRITE", table: "global_settings" },
  { mod: "app/actions/strategy-session", fn: "setSellerFloorAction", seed: () => ({ users: users(), listings: [{ id: X, brokerage_id: A, seller_walkaway_price: null }] }), call: (m) => m.setSellerFloorAction({ listingId: X, floor: 450000 }), action: "listing.seller_floor.set", subjectType: "listing", risk: "LOW_RISK_WRITE", table: "listings" },
  { mod: "app/actions/vendor-invite", fn: "revokeVendorInviteAction", seed: () => ({ users: users(), vendor_invitations: [{ id: X, brokerage_id: A, status: "pending" }, { id: V, brokerage_id: A, status: "pending" }] }), call: (m) => m.revokeVendorInviteAction(MEM.tables.vendor_invitations.find((r) => r.status === "pending")?.id ?? X), action: "vendor.invitation.revoke", subjectType: "vendor_invitation", risk: "LOW_RISK_WRITE", table: "vendor_invitations" },
  { mod: "app/actions/workflows", fn: "retryFailedWorkflow", seed: () => ({ automation_errors: [{ id: X, brokerage_id: A, status: "open" }] }), call: (m) => m.retryFailedWorkflow(X), action: "automation.error.resolve", subjectType: "automation_error", risk: "LOW_RISK_WRITE", table: "automation_errors" },
  { mod: "app/actions/admin/invitations", fn: "revokeInvitationAction", seed: () => ({ users: users(), user_invitations: [{ id: X, brokerage_id: A, status: "pending" }] }), call: (m) => m.revokeInvitationAction(X), action: "tenant.invitation.revoke", subjectType: "user_invitation", risk: "LOW_RISK_WRITE", table: "user_invitations", failCheck: true },
  { mod: "app/actions/agent-settings", fn: "updateAgentSettings", seed: () => ({ users: users() }), call: (m) => m.updateAgentSettings(U, { assistantWakeName: "Nova" }), action: "agent.assistant_settings.update", subjectType: "user", risk: "LOW_RISK_WRITE", table: "users" },
  { mod: "app/actions/ai-tools-hub", fn: "toggleToolFavorite", seed: () => ({ users: users(), ai_tool_favorites: [] }), call: (m) => m.toggleToolFavorite(U, "cma"), action: "ai_tools.favorite.toggle", subjectType: "user", risk: "LOW_RISK_WRITE", table: "ai_tool_favorites" },
  { mod: "app/actions/home-value", fn: "savePageConfig", seed: () => ({ users: users(), home_value_page_configs: [] }), call: (m) => m.savePageConfig({ agentId: AG, brokerageId: A, headline: "What is your home worth?" }), action: "marketing.home_value_page.save", subjectType: "agent", risk: "LOW_RISK_WRITE", table: "home_value_page_configs" },
  { mod: "app/actions/settings/recruiting-pitch", fn: "setRecruitingPitch", seed: () => ({ brokerages: [{ id: A }] }), call: (m) => m.setRecruitingPitch("Grow with us."), action: "recruiting.pitch.set", subjectType: "brokerage", risk: "LOW_RISK_WRITE", table: "brokerages", failCheck: true },
  { mod: "app/actions/settings/reputation-preferences", fn: "saveReputationPreferences", seed: () => ({ agents: [{ id: AG, brokerage_id: A, notification_preferences: {} }] }), call: (m) => m.saveReputationPreferences(AG, { autoRespondMode: "review", autoRespondApprovalHours: 12 }), action: "reputation.preferences.save", subjectType: "agent", risk: "LOW_RISK_WRITE", table: "agents" },
  { mod: "app/actions/settings/update-email-template", fn: "updateEmailTemplate", seed: () => ({ users: users(), email_templates: [{ id: X, brokerage_id: A, name: "Welcome" }] }), call: (m) => m.updateEmailTemplate(X, { name: "Welcome v2" }), action: "marketing.email_template.update", subjectType: "email_template", risk: "LOW_RISK_WRITE", table: "email_templates" },
  { mod: "app/actions/tasks", fn: "deleteTask", seed: () => ({ tasks: [{ id: X, brokerage_id: A }, { id: V, brokerage_id: A }] }), call: (m) => m.deleteTask(MEM.tables.tasks?.[0]?.id ?? X), action: "crm.task.delete", subjectType: "task", risk: "LOW_RISK_WRITE", table: "tasks" },
  { mod: "app/actions/voice-assistant/core/emit-audit-event", fn: "emitAuditEvent", seed: () => ({ users: users(), activities: [] }), call: (m) => m.emitAuditEvent({ event_type: "voice.command.executed", user_id: U, brokerage_id: A, entity_type: "contact", entity_id: C, metadata: {} }), action: "voice.command_event.record", subjectType: "contact", risk: "LOW_RISK_WRITE", table: "activities", failCheck: true },
  { mod: "app/actions/onboarding-decisions", fn: "adoptAssistantIdentityAction", seed: () => ({ users: users(), brokerages: [{ id: A, name: "Nexus Realty" }], ai_identity_profiles: [] }), call: (m) => { MEM.tables.ai_identity_profiles = []; return m.adoptAssistantIdentityAction() }, action: "onboarding.assistant_identity.adopt", subjectType: "brokerage", risk: "LOW_RISK_WRITE", table: "ai_identity_profiles" },
  { mod: "app/actions/gift-studio", fn: "orderGiftSelectionAction", seed: () => ({ users: users(), contacts: [{ id: C, brokerage_id: A, agent_id: AG, first_name: "Dana" }], client_gifts: [], tasks: [] }), call: (m) => m.orderGiftSelectionAction({ contactId: C, selection: { key: "candle", title: "Candle", personalization: "", priceBand: [20, 40], etsyUrl: "e", amazonUrl: "a" } }), action: "reputation.gift_selection.order", subjectType: "contact", risk: "LOW_RISK_WRITE", table: "tasks" },
  { mod: "app/actions/settings/create-email-template", fn: "createEmailTemplate", seed: () => ({ email_templates: [] }), call: (m) => m.createEmailTemplate({ name: "Closing thanks", subject: "Thank you" }), action: "marketing.email_template.create", subjectType: "email_template", risk: "LOW_RISK_WRITE", table: "email_templates", failCheck: true },
]

const ledger = () => (MEM.tables.agent_action_ledger ?? []) as Row[]
const runsOn = (table: string) => MEM.writes.filter((w) => w.table === table).length
function fresh(c: Case, opts: Parameters<typeof memSupabase>[1] = {}) {
  USER_TYPE = c.userType ?? "broker"
  MEM = withAuth(memSupabase({ agent_action_ledger: [], tenant_policy_versions: [], ...c.seed() }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...opts }))
}

async function driven() {
  console.log("\n[§A driven — SIMULATED: in-memory client, session stubbed, no provider, no model]")
  for (const c of CASES) {
    let m: any
    try { m = await import(`../${c.mod}`) } catch (e) { check(`${c.mod} loads`, false, (e as Error).message.slice(0, 200)); continue }
    fresh(c)
    const r1 = await quiet(() => c.call(m)).catch((e) => ({ threw: String(e) }))
    const rows = ledger()
    const row = rows[0] ?? {}
    check(`${c.fn}: exactly one receipt — ${c.action} on ${c.subjectType} (${c.risk}), actor = session user, tenant = session tenant, executed`,
      rows.length === 1 && row.action === c.action && NAME.test(String(row.action)) && row.actor_user_id === U && row.brokerage_id === A
        && row.subject_type === c.subjectType && row.risk_class === c.risk && row.reason_code === "HUMAN_REQUESTED" && row.status === "executed" && row.idempotency_key === null,
      `rows=${rows.length} ${JSON.stringify({ a: row.action, s: row.subject_type, r: row.risk_class, st: row.status, err: row.error, u: row.actor_user_id === U, t: row.brokerage_id === A })} result=${JSON.stringify(r1).slice(0, 160)}`)
    const before = runsOn(c.table)
    await quiet(() => c.call(m)).catch(() => null)
    check(`${c.fn}: NO-KEY canary — a second call writes a SECOND receipt and the write runs again (never a silent replay)`,
      ledger().length === 2 && runsOn(c.table) > before, `receipts=${ledger().length} writes ${before}→${runsOn(c.table)}`)
    if (c.failCheck) {
      fresh(c, { refuse: { [c.table]: "permission denied (guard)" } })
      await quiet(() => c.call(m)).catch(() => null)
      const f = ledger()
      check(`${c.fn}: a refused write settles its receipt failed`, f.length === 1 && f[0].status === "failed", `rows=${f.length} status=${f[0]?.status}`)
    }
  }
}

// ─── §B static ───────────────────────────────────────────────────────────────────────────────────────────────────────
const S = "ledgerSessionAction"
function exportBody(src: string, fn: string): string | null {
  const i = src.search(new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`))
  if (i < 0) return null
  const rest = src.slice(i + 10)
  const j = rest.search(/\nexport\s/)
  return src.slice(i, j < 0 ? undefined : i + 10 + j)
}
/** The ONE delegation each export below rides (its delegate is itself on the list and wrapped). */
const DELEGATES: Record<string, { file: string; fn: string }> = {
  "app/actions/pattern-actions.ts#acknowledgePattern": { file: "app/actions/pattern-actions.ts", fn: "updatePatternStatus" },
  "app/actions/pattern-actions.ts#dismissPattern": { file: "app/actions/pattern-actions.ts", fn: "updatePatternStatus" },
  "app/actions/voice-assistant/handle-voice-command.ts#handleVoiceCommand": { file: "app/actions/voice-assistant/core/emit-audit-event.ts", fn: "emitAuditEvent" },
}
/** Rows left OPEN with their reason (notes: "no tenant to record against" / re-classification) — never claimed here. */
const OPEN: Record<string, string> = {
  "app/actions/public/tos-acceptance.ts#recordTosAcceptanceAction": "pre-account public signup consent: no session, no tenant",
  "app/actions/demo-auth.ts#demoSignIn": "pre-session sign-in/provisioning door (demo-gated): no session user",
  "app/actions/career-tier.ts#getAgentCareerProgress": "read-only (analyzer attributes runCareerTierEvaluation's writes)",
  "app/actions/network-intelligence.ts#getNetworkBenchmarksBeside": "read-only (analyzer attributes runNetworkBenchmarkAggregation's writes)",
  "app/actions/superadmin/platform-providers.ts#getPlatformProvidersAction": "superadmin read, no tenant",
  "app/actions/tenant-safety-actions.ts#resolveTenantSafetyFindingAction": "platform-wide table with no brokerage_id: no tenant",
  "http:/api/seed/users": "platform maintenance seed across tenants: no tenant",
}
const callWindows = (src: string): string[] => [...src.matchAll(new RegExp(`\\b${S}\\s*(?:<[^>]*>)?\\s*\\(`, "g"))].map((m) => {
  const w = src.slice(m.index!, m.index! + 1600)
  const end = w.search(/},\s*(?:async\s*\(|\(\)\s*=>|run\))/)
  return end < 0 ? w : w.slice(0, end)
})
function scan(files: Record<string, string>, rows: string[]) {
  const missing: string[] = [], badNames: string[] = [], keyed: string[] = []
  for (const raw of rows) {
    const id = raw.replace(/^server_action:/, "")
    if (OPEN[id]) continue
    const [file, fn] = id.split("#")
    const d = DELEGATES[id]
    const body = d ? exportBody(files[d.file] ?? "", d.fn) : exportBody(files[file] ?? "", fn)
    const delegates = d ? (exportBody(files[file] ?? "", fn) ?? "").includes(`${d.fn}(`) : true
    if (!body || !body.includes(S) || !delegates) missing.push(raw)
  }
  for (const [file, src] of Object.entries(files)) for (const w of callWindows(src)) {
    for (const n of w.matchAll(/\baction:\s*["']([^"']+)["']/g)) if (!NAME.test(n[1])) badNames.push(`${file}: ${n[1]}`)
    if (/\b(?:cycle|idempotencyKey)\s*:/.test(w)) keyed.push(file)
  }
  return { missing, badNames, keyed }
}

function staticChecks() {
  console.log("\n[§B static — stripped source]")
  const rows = JSON.parse(readFileSync(join(ROOT, "scripts/ledger-receipts-platform2-rows.json"), "utf8")) as string[]
  const files: Record<string, string> = {}
  for (const id of rows) {
    const f = id.replace(/^server_action:/, "").split("#")[0]
    if (f.startsWith("app/") && !files[f]) files[f] = stripComments(readFileSync(join(ROOT, f), "utf8"))
  }
  for (const d of Object.values(DELEGATES)) files[d.file] ??= stripComments(readFileSync(join(ROOT, d.file), "utf8"))
  const r = scan(files, rows)
  const closed = rows.filter((id) => !OPEN[id.replace(/^server_action:/, "")]).length
  check(`every export on the row list reaches ${S} (${closed - r.missing.length}/${closed}; ${Object.keys(OPEN).length} rows open with a named reason)`, r.missing.length === 0, r.missing.join(", "))
  check(`every action name at a ${S} call is domain.entity.action`, r.badNames.length === 0, r.badNames.join("; "))
  check(`no ${S} call passes cycle / idempotencyKey (recording-only receipts — a second save is never a replay)`, r.keyed.length === 0, r.keyed.join(", "))
  check(`the row list is the lane's 93 rows`, rows.length === 93, String(rows.length))
  // POSITIVE CONTROLS — the finder still recognises each defect it was written for.
  const planted = {
    "app/x.ts": `export async function wrapped() { const { ${S} } = await import("x")\n  return ${S}({ action: "a.b" , cycle: "k" }, async () => 1) }\nexport async function bare() { return 1 }`,
  }
  const p = scan(planted, ["server_action:app/x.ts#wrapped", "server_action:app/x.ts#bare"])
  check("POSITIVE CONTROL: a planted export without the helper, a two-segment name and a planted key are each caught",
    p.missing.join() === "server_action:app/x.ts#bare" && p.badNames.length === 1 && p.keyed.length === 1)
  check("POSITIVE CONTROL: a helper named only in a comment is not a call site (stripped source)",
    !(exportBody(stripComments(`export async function c() {\n  // ${S}(\n  return 1\n}`), "c") ?? "").includes(S))
}

async function main() {
  console.log("ledger-receipts-platform2 — lane 155R11")
  staticChecks()
  await driven()
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("❌ LEDGER_RECEIPTS_PLATFORM2_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_PLATFORM2_PASS")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
