#!/usr/bin/env tsx
/**
 * scripts/wave155-ungated-platform-guard.ts   (npm run test:wave155-ungated-platform)   — wave 155, lane 155S3
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * UNGATED MARKETING / PLATFORM EXPORTS AND SILENT SUCCESSES — closed, and kept closed.
 *
 * Every `"use server"` export is a PUBLIC HTTP ENDPOINT (CLAUDE.md §4). The exports below had no session gate, or took the
 * user / agent / tenant from an argument, or reported success for a write that changed nothing (§3: supabase-js RESOLVES a
 * refusal, and an update / delete that matched nothing is byte-identical to one that worked). Each is now gated with its
 * module's SIBLING gate (or the canonical one), takes identity and tenant from the SESSION, refuses a caller-named tenant
 * through decideClaimedTenant / requireCallerTenant, and counts what it changed.
 *
 *   §A DRIVEN (SIMULATED — scripts/in-memory-supabase.ts; the session, every model call, the enrichment queue door and the
 *      paid CMA pipeline are injected seams that COUNT calls; no database, provider or model is reached). Per fix:
 *        · a NEGATIVE canary — no session / another tenant / another user / a zero-row write — that is RED at the base
 *          81cdddae (measured: this file run against the base sources; see the RED-AT-BASE list printed at the end);
 *        · a POSITIVE twin — the rightful caller still works (a dead door that refuses everyone cannot pass).
 *      The in-memory `eq(col, null)` is patched to PostgREST's behavior (`col=eq.null` matches NO row) — the stand-in otherwise
 *      matches NULL rows and would hide the defect the license-tracking fix closes.
 *   §B STATIC (stripped source, scripts/strip-comments.ts): no `"use server"` directive in emit-audit-event and the two route
 *      files; no "enriched" / invented-confidence stamp in serviceEnrichLead; each gated export reaches its gate token.
 *      POSITIVE CONTROLS: the directive finder flags a planted directive, the stamp finder flags a planted stamp, the gate
 *      finder flags a planted ungated export.
 *
 * BLIND SPOTS: RLS is not modelled (the stand-in admits every session read), so a refusal here is the CODE's refusal; the
 * real database adds RLS underneath. The governance cycle's routing / SLA libraries run for real but against an in-memory
 * tenant with no assignment rules. The lead-lineage page's own route gate is not driven. Route files are proven to ANSWER
 * (a JSON response to an invalid body) and to export only HTTP verbs — the full widget session mint is driven elsewhere
 * (test:public-door-decision, test:public-agent).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"

const ROOT = process.cwd()
const _require = createRequire(import.meta.url)
let passed = 0, failed = 0
const redAtBase: string[] = []
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
/** A negative canary — the control the base fails. */
function neg(name: string, ok: boolean, detail = "") { redAtBase.push(name); check(`[NEG] ${name}`, ok, detail) }
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
// A = the session's tenant, B = another tenant. U = session user, AG = session agents.id. V = another user / VA their agents.id.
const A = u(1), B = u(2), U = u(11), AG = u(21), V = u(12), VA = u(22), CU = u(13), C = u(31), C2 = u(32), X = u(41), Y = u(42), Z = u(43), L = u(51), L2 = u(52), M = u(61)

// ─── the session + seams (installed BEFORE any app module loads) ────────────────────────────────────────────────────
type Sess = { userId: string | null; email?: string | null; userType?: string; brokerageId?: string | null; agentId?: string | null; platformRole?: string | null }
let SESSION: Sess = { userId: null }
let MEM: MemClient = memSupabase({})
const SEAM = { model: 0, enrichDoor: [] as Row[], aicma: [] as Row[], sphere: 0, referral: 0, emits: [] as Row[] }
const MODEL_OBJECT = {
  plan_name: "Seven-day follow-up", next_action: "Call", next_action_date: "2026-12-01", steps: [{ day: 1, action: "Call", channel: "call" }],
  conversionProbability: 42, projectedTimeline: "unknown", confidenceLevel: "low", keyFactors: [], riskFactors: [], accelerators: [], recommendation: "Keep in touch",
  plan: [{ day: "Monday", contentType: "market_update", platform: "facebook", hook: "Inventory rose", suggestedTime: "9:00 AM" }],
}
const withAuth = (c: MemClient): MemClient => Object.assign(c, { auth: { getUser: async () => ({ data: { user: SESSION.userId ? { id: SESSION.userId, email: SESSION.email ?? null } : null }, error: null }) } })
/** PostgREST renders eq(col, null) as `col=eq.null`, which matches NO row; the stand-in would match NULL rows. */
function eqNullLikePostgrest(c: MemClient): MemClient {
  const from = c.from.bind(c)
  ;(c as any).from = (t: string) => { const b: any = from(t); const eq = b.eq.bind(b); b.eq = (col: string, v: unknown) => eq(col, v === null ? Symbol("eq.null matches nothing") : v); return b }
  return c
}
const agentCtx = () => SESSION.userId
  ? { userId: SESSION.userId, agentId: SESSION.agentId ?? null, brokerageId: SESSION.brokerageId ?? null, teamId: null, userType: SESSION.userType ?? "", role: SESSION.userType ?? "", isAuthenticated: true, isImpersonating: false, impersonatorUserId: null, impersonationMode: null }
  : { userId: "", agentId: null, brokerageId: null, teamId: null, userType: "", role: "", isAuthenticated: false, isImpersonating: false, impersonatorUserId: null, impersonationMode: null }
{
  const G: any = globalThis as any
  G.__S3__ = {
    createServiceClient: () => MEM, createClient: async () => MEM,
    getAgentContext: async () => agentCtx(),
    headers: async () => new Map([["user-agent", "guard"]]), cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [], toString: () => "" }),
    model: async () => { SEAM.model++; return { object: MODEL_OBJECT, usage: { inputTokens: 1, outputTokens: 1 } } },
    resolveModel: (id: string) => ({ id }),
    queueLeadEnrichment: async (p: Row) => { SEAM.enrichDoor.push(p); return { queued: true } },
    generateAICMA: async (p: Row) => { SEAM.aicma.push(p); return { success: true, cmaId: Z, comparables: [{}, {}] } },
    aiGenerateTouchpoint: async () => { SEAM.sphere++; return { success: true, data: { message: "hi" } } },
    identifyReferralOpportunities: async () => { SEAM.referral++; return { success: true, opportunities: [] } },
    resolveViewerHierarchy: async () => ({ ok: true, scope: { aggregate: true, locationIds: [] } }),
    emitKernelEvent: async (e: Row) => { SEAM.emits.push(e); return { ok: true } },
  }
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  const key = (r: string) => r.replace(/^@\//, "").replace(/\\/g, "/").replace(/\.tsx?$/, "")
  const is = (r: string, k: string) => { const n = key(r); return n === k || n.endsWith(`/${k}`) }
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    if (is(request, "lib/supabase/service")) return { createServiceClient: () => MEM }
    if (is(request, "lib/supabase/server")) return { createClient: async () => MEM }
    if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }
    if (request === "next/headers") return { headers: G.__S3__.headers, cookies: G.__S3__.cookies }
    if (is(request, "lib/identity/get-agent-context")) return { ...realLoad.call(this, request, ...rest), getAgentContext: G.__S3__.getAgentContext }
    return realLoad.call(this, request, ...rest)
  }
  const SHIMS: Record<string, string> = {
    "lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__S3__.createServiceClient(...a)",
    "lib/supabase/server": "export const createClient = (...a) => globalThis.__S3__.createClient(...a)",
    "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}",
    "next/headers": "export const headers = (...a) => globalThis.__S3__.headers(...a); export const cookies = (...a) => globalThis.__S3__.cookies(...a); export const draftMode = async () => ({ isEnabled: false })",
    "server-only": "export {}",
  }
  const PARTIAL: Record<string, string> = {
    "lib/identity/get-agent-context": "export const getAgentContext = (...a) => globalThis.__S3__.getAgentContext(...a)",
    "lib/ai/generate": "export const generateObject = (...a) => globalThis.__S3__.model(...a); export const bookedGenerateObject = () => (...a) => globalThis.__S3__.model(...a)",
    "lib/ai/resolve-model": "export const resolveModel = (...a) => globalThis.__S3__.resolveModel(...a)",
    "lib/enrichment/lead-enrichment-core": "export const queueLeadEnrichment = (...a) => globalThis.__S3__.queueLeadEnrichment(...a)",
    "app/actions/ai-cma": "export const generateAICMA = (...a) => globalThis.__S3__.generateAICMA(...a)",
    "app/actions/ai-sphere-management": "export const aiGenerateTouchpoint = (...a) => globalThis.__S3__.aiGenerateTouchpoint(...a)",
    "app/actions/ai-referral-management": "export const identifyReferralOpportunities = (...a) => globalThis.__S3__.identifyReferralOpportunities(...a)",
    "lib/kernel/resolve-user-office": "export const resolveViewerHierarchy = (...a) => globalThis.__S3__.resolveViewerHierarchy(...a)",
    "lib/kernel/emit": "export const emitKernelEvent = (...a) => globalThis.__S3__.emitKernelEvent(...a)",
  }
  const loader = `
const SHIMS = ${JSON.stringify(SHIMS)}, PARTIAL = ${JSON.stringify(PARTIAL)};
const norm = (s) => String(s).split(String.fromCharCode(92)).join("/").replace("file://", "").replace(/^@[/]/, "").replace(/[.](ts|tsx|js|mjs)$/, "");
const hit = (table, s) => Object.keys(table).find((k) => { const n = norm(s); return n === k || n.endsWith("/" + k) || n.endsWith("/node_modules/" + k + "/index") });
export async function resolve(specifier, context, next) {
  const k1 = hit(SHIMS, specifier); if (k1) return { shortCircuit: true, url: "vipre-s3:" + encodeURIComponent(k1) };
  const r = await next(specifier, context);
  const k2 = hit(SHIMS, r.url ?? ""); if (k2) return { shortCircuit: true, url: "vipre-s3:" + encodeURIComponent(k2) };
  const p = hit(PARTIAL, specifier) ?? (r.url && !String(r.url).startsWith("vipre-") && !(context.parentURL ?? "").startsWith("vipre-s3p:") ? hit(PARTIAL, r.url) : undefined);
  if (p && !(context.parentURL ?? "").startsWith("vipre-s3p:")) return { shortCircuit: true, url: "vipre-s3p:" + encodeURIComponent(p) + "?real=" + encodeURIComponent(r.url) };
  return r;
}
export async function load(url, context, next) {
  if (url.startsWith("vipre-s3:")) return { shortCircuit: true, format: "module", source: SHIMS[decodeURIComponent(url.slice(9))] };
  if (url.startsWith("vipre-s3p:")) {
    const [k, q] = url.slice(10).split("?real=");
    const real = decodeURIComponent(q);
    return { shortCircuit: true, format: "module", source: "export * from " + JSON.stringify(real) + "; " + PARTIAL[decodeURIComponent(k)] };
  }
  return next(url, context);
}`
  const { register } = await import("node:module")
  register(`data:text/javascript,${encodeURIComponent(loader)}`)
}

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────────
function fresh(seed: Record<string, Row[]>, opts: Parameters<typeof memSupabase>[1] = {}) {
  MEM = eqNullLikePostgrest(withAuth(memSupabase({ agent_action_ledger: [], tenant_policy_versions: [], ...seed }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...opts })))
  SEAM.model = 0; SEAM.enrichDoor = []; SEAM.aicma = []; SEAM.sphere = 0; SEAM.referral = 0; SEAM.emits = []
}
const T = (t: string): Row[] => (MEM.tables[t] ?? []) as Row[]
const receipts = (action: string) => T("agent_action_ledger").filter((r) => r.action === action)
const AS_BROKER: Sess = { userId: U, email: "broker@example.test", userType: "broker", brokerageId: A, agentId: null }
const AS_AGENT: Sess = { userId: U, email: "agent@example.test", userType: "agent", brokerageId: A, agentId: AG }
const AS_CONTACT: Sess = { userId: CU, email: "seller@example.test", userType: "client", brokerageId: A, agentId: null }
const ANON: Sess = { userId: null }
const usersRow = (s: Sess): Row => ({ id: s.userId, brokerage_id: s.brokerageId ?? null, user_type: s.userType ?? null, platform_role: s.platformRole ?? null, team_id: null, email: s.email ?? null })
const agentsRow = (): Row => ({ id: AG, user_id: U, brokerage_id: A, is_active: true, team_id: null })
async function as<T>(s: Sess, fn: () => Promise<T>): Promise<T | { threw: string }> { SESSION = s; return quiet(fn).catch((e) => ({ threw: String((e as Error)?.message ?? e) })) }
const ok = (r: any) => !!r && typeof r === "object" && (r.success === true || r.ok === true)
const mod = async (p: string): Promise<any> => import(`../${p}`)

async function driven() {
  console.log("\n[§A driven — SIMULATED: in-memory client, session + model + enrichment door + CMA pipeline are counted seams]")

  // 1. lifetime-customers ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/lifetime-customers")
    fresh({ scheduled_touchpoints: [] })
    const r = await as(ANON, () => m.scheduleTouchpoint({ contactId: C, touchpointType: "check_in", scheduledFor: "2026-12-01T10:00:00Z" }))
    neg("scheduleTouchpoint: no session → refused, ZERO touchpoints inserted", !ok(r) && T("scheduled_touchpoints").length === 0, `result=${JSON.stringify(r)} rows=${T("scheduled_touchpoints").length}`)
    fresh({ scheduled_touchpoints: [] })
    const r2 = await as(AS_AGENT, () => m.scheduleTouchpoint({ contactId: C, touchpointType: "check_in", scheduledFor: "2026-12-01T10:00:00Z" }))
    check("scheduleTouchpoint: the agent's own session → scheduled, stamped with the session agent + tenant, one receipt", ok(r2) && T("scheduled_touchpoints")[0]?.agent_id === AG && T("scheduled_touchpoints")[0]?.brokerage_id === A && receipts("sphere.touchpoint.schedule").length === 1, JSON.stringify(r2))
    fresh({})
    const g = await as(ANON, () => m.generateTouchpoint({ contactId: C, touchpointType: "birthday" }))
    const f = await as(ANON, () => m.findReferralOpportunities())
    neg("generateTouchpoint / findReferralOpportunities: no session → refused AT THE EXPORT (model delegates called 0 times)", !ok(g) && !ok(f) && SEAM.sphere === 0 && SEAM.referral === 0, `sphere=${SEAM.sphere} referral=${SEAM.referral}`)
    fresh({})
    const g2 = await as(AS_AGENT, () => m.generateTouchpoint({ contactId: C, touchpointType: "birthday" }))
    const f2: any = await as(AS_AGENT, () => m.findReferralOpportunities())
    check("generateTouchpoint / findReferralOpportunities: the agent's session reaches each delegate once, opportunities readable", ok(g2) && ok(f2) && Array.isArray(f2.opportunities) && SEAM.sphere === 1 && SEAM.referral === 1, `sphere=${SEAM.sphere} referral=${SEAM.referral}`)
  }

  // 2. podcast-generation updateDistributionChannel ──────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/podcast-generation")
    const seed = () => ({ podcast_distribution_channels: [{ id: X, brokerage_id: A, agent_user_id: null, channel_name: "spotify", is_enabled: true }, { id: Y, brokerage_id: A, agent_user_id: U, channel_name: "spotify", is_enabled: false }] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.updateDistributionChannel(X, { isEnabled: false }))
    neg("updateDistributionChannel: an agent editing the BROKERAGE channel (inherited by every agent) → refused, row unchanged", !ok(r) && T("podcast_distribution_channels").find((c) => c.id === X)?.is_enabled === true, JSON.stringify(r))
    fresh(seed())
    const r0 = await as(ANON, () => m.updateDistributionChannel(Y, { isEnabled: true }))
    check("updateDistributionChannel: no session → refused", !ok(r0) && T("podcast_distribution_channels").find((c) => c.id === Y)?.is_enabled === false)
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.updateDistributionChannel(Y, { isEnabled: true }))
    check("updateDistributionChannel: the agent's OWN personal channel → updated, one receipt", ok(r2) && T("podcast_distribution_channels").find((c) => c.id === Y)?.is_enabled === true && receipts("podcast.distribution_channel.update").length === 1, JSON.stringify(r2))
    fresh(seed())
    const r3 = await as(AS_BROKER, () => m.updateDistributionChannel(X, { isEnabled: false }))
    check("updateDistributionChannel: the tenant roster may edit the brokerage channel", ok(r3) && T("podcast_distribution_channels").find((c) => c.id === X)?.is_enabled === false, JSON.stringify(r3))
  }

  // 3. social-media-automation retryFailedPost / deleteSocialPost ─────────────────────────────────────────────────
  {
    const m = await mod("app/actions/social-media-automation")
    const seed = () => ({ social_posts: [{ id: X, brokerage_id: B, status: "failed", platform: "facebook" }, { id: Y, brokerage_id: A, user_id: U, status: "scheduled", platform: "facebook" } /* the author (social_posts.user_id, stamped by every creator) — the cancel door now keeps an agent to their own post: wave 155, lane 155R29 */, { id: Z, brokerage_id: A, status: "failed", platform: "facebook" }], social_publish_log: [] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.deleteSocialPost(X, U))
    const r1 = await as(AS_AGENT, () => m.retryFailedPost(X, U))
    neg("deleteSocialPost / retryFailedPost: ANOTHER tenant's post → not found, row unchanged", !ok(r) && !ok(r1) && T("social_posts").find((p) => p.id === X)?.status === "failed", `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.deleteSocialPost(Y, V))
    neg("deleteSocialPost: a body userId naming ANOTHER user (forged actor) → refused", !ok(r2) && T("social_posts").find((p) => p.id === Y)?.status === "scheduled", JSON.stringify(r2))
    fresh(seed())
    const r3 = await as(AS_AGENT, () => m.deleteSocialPost(Y, U))
    const r4 = await as(AS_AGENT, () => m.retryFailedPost(Z, U))
    check("deleteSocialPost / retryFailedPost: own tenant's post → cancelled / re-queued, events name the SESSION user", ok(r3) && ok(r4) && T("social_posts").find((p) => p.id === Y)?.status === "cancelled" && T("social_posts").find((p) => p.id === Z)?.status === "scheduled" && SEAM.emits.length === 2 && SEAM.emits.every((e) => e.actorUserId === U), `${JSON.stringify(r3)} ${JSON.stringify(r4)} emits=${JSON.stringify(SEAM.emits.map((e) => e.actorUserId))}`)
  }

  // 4. ai-content-generation updateBrandVoiceProfile ─────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/ai-content-generation")
    fresh({ brand_voice_profile: [] })
    const r = await as(AS_BROKER, () => m.updateBrandVoiceProfile({ agentId: VA, tone: "hijacked" }))
    neg("updateBrandVoiceProfile: a seat with NO agents row naming another agent in the body → refused, nothing written for that agent", T("brand_voice_profile").length === 0 && !ok(r), JSON.stringify(r))
    fresh({ brand_voice_profile: [] })
    const r1 = await as(AS_AGENT, () => m.updateBrandVoiceProfile({ agentId: VA, tone: "hijacked" }))
    check("updateBrandVoiceProfile: an agent naming ANOTHER agent → refused", T("brand_voice_profile").length === 0, JSON.stringify(r1))
    fresh({ brand_voice_profile: [] })
    const r2: any = await as(AS_AGENT, () => m.updateBrandVoiceProfile({ agentId: AG, tone: "warm" }))
    check("updateBrandVoiceProfile: the agent's own profile → written for the session agent, one receipt", T("brand_voice_profile")[0]?.agent_id === AG && T("brand_voice_profile")[0]?.tone === "warm" && receipts("content.brand_voice.update").length === 1, JSON.stringify(r2).slice(0, 160))
  }

  // 5. ai-tools-hub favorites ────────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/ai-tools-hub")
    const seed = () => ({ users: [usersRow(AS_AGENT)], ai_tool_favorites: [{ id: X, user_id: V, tool_name: "cma" }] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.toggleToolFavorite(V, "cma"))
    const favs: any = await as(AS_AGENT, () => m.getUserFavorites(V))
    neg("toggleToolFavorite / getUserFavorites: ANOTHER user's id → refused (their favorite survives) and nothing read", T("ai_tool_favorites").some((f) => f.user_id === V) && Array.isArray(favs) && favs.length === 0 && !!(r as any)?.error, `${JSON.stringify(r)} favs=${JSON.stringify(favs)}`)
    fresh(seed())
    const r0 = await as(ANON, () => m.toggleToolFavorite("", "cma"))
    check("toggleToolFavorite: no session → refused, nothing written", !!(r0 as any)?.error && T("ai_tool_favorites").length === 1)
    fresh(seed())
    const r2: any = await as(AS_AGENT, () => m.toggleToolFavorite(U, "cma"))
    const favs2: any = await as(AS_AGENT, () => m.getUserFavorites(U))
    check("toggleToolFavorite / getUserFavorites: the session user's own → favorited and read back", r2?.favorited === true && Array.isArray(favs2) && favs2.includes("cma") && receipts("ai_tools.favorite.toggle").length === 1, `${JSON.stringify(r2)} ${JSON.stringify(favs2)}`)
  }

  // 6. emitAuditEvent (no longer a public endpoint — §B proves the directive is gone) ───────────────────────────────
  {
    const m = await mod("app/actions/voice-assistant/core/emit-audit-event")
    fresh({ users: [usersRow(AS_AGENT)], activities: [] })
    const r = await as(AS_AGENT, () => m.emitAuditEvent({ event_type: "voice.command.executed", user_id: U, brokerage_id: A, metadata: {} }))
    check("emitAuditEvent: its server-side caller's injected (session) identity still records the audit row", ok(r) && T("activities").length === 1 && T("activities")[0].agent_user_id === U, JSON.stringify(r))
  }

  // 7. admin/invitations revokeInvitationAction ──────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/admin/invitations")
    const seed = () => ({ users: [usersRow(AS_BROKER)], user_invitations: [{ id: X, brokerage_id: A, status: "pending" }, { id: Y, brokerage_id: B, status: "pending" }, { id: Z, brokerage_id: A, status: "accepted" }, { id: M, brokerage_id: A, status: "revoked" }] })
    fresh(seed())
    const r = await as(AS_BROKER, () => m.revokeInvitationAction(Y))
    const r1 = await as(AS_BROKER, () => m.revokeInvitationAction(Z))
    neg("revokeInvitationAction: another tenant's / an ACCEPTED invitation (zero rows) → NOT reported as revoked", !ok(r) && !ok(r1) && T("user_invitations").find((i) => i.id === Y)?.status === "pending", `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_BROKER, () => m.revokeInvitationAction(X))
    const r3 = await as(AS_BROKER, () => m.revokeInvitationAction(M))
    check("revokeInvitationAction: a pending invitation → revoked; an already-revoked one → ok (the caller's desired outcome)", ok(r2) && ok(r3) && T("user_invitations").find((i) => i.id === X)?.status === "revoked", `${JSON.stringify(r2)} ${JSON.stringify(r3)}`)
  }

  // 8. workflows generateCopilotPlan ─────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/workflows")
    const seed = () => ({ contacts: [{ id: C, brokerage_id: A, first_name: "Ann", last_name: "Lee" }], copilot_plans: [{ id: X, contact_id: C, brokerage_id: A, status: "active" }] })
    fresh(seed(), { missingColumns: { copilot_plans: ["plan_data"] } })
    const r = await as(AS_AGENT, () => m.generateCopilotPlan(C))
    neg("generateCopilotPlan: a REFUSED plan insert → success:false, and the existing plan is still active", !ok(r) && T("copilot_plans").find((p) => p.id === X)?.status === "active", `${JSON.stringify(r)} old=${T("copilot_plans").find((p) => p.id === X)?.status}`)
    fresh(seed())
    const r2: any = await as(AS_AGENT, () => m.generateCopilotPlan(C))
    check("generateCopilotPlan: a saved plan → success, new plan active, the old one superseded", ok(r2) && T("copilot_plans").find((p) => p.id === X)?.status === "superseded" && T("copilot_plans").filter((p) => p.status === "active").length === 1, JSON.stringify(r2).slice(0, 160))
  }

  // 9. admin/locations deleteLocationAction ──────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/admin/locations")
    const seed = () => ({ users: [usersRow(AS_BROKER), { id: V, brokerage_id: A, location_id: L }], agents: [{ id: VA, user_id: V, brokerage_id: A, location_id: L }], locations: [{ id: L, brokerage_id: A }, { id: L2, brokerage_id: B }] })
    fresh(seed())
    const r = await as(AS_BROKER, () => m.deleteLocationAction(L2))
    const r1 = await as(AS_BROKER, () => m.deleteLocationAction(u(99)))
    neg("deleteLocationAction: another tenant's / an unknown office (zero rows) → failure, nobody unassigned", !ok(r) && !ok(r1) && T("locations").length === 2, `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_BROKER, () => m.deleteLocationAction(L))
    check("deleteLocationAction: own office → deleted, its people moved to Unassigned", ok(r2) && !T("locations").some((l) => l.id === L) && T("users").find((x) => x.id === V)?.location_id === null && T("agents")[0]?.location_id === null, JSON.stringify(r2))
  }

  // 10. activities logActivity ───────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/activities")
    fresh({ activities: [] })
    const r = await as(AS_AGENT, () => m.logActivity({ brokerageId: "", agentId: VA, activityType: "note", title: "x" }))
    neg("logActivity: a body agentId naming ANOTHER agent → refused, no activity filed under them", !ok(r) && T("activities").length === 0, `${JSON.stringify(r)} rows=${JSON.stringify(T("activities").map((a) => a.agent_id))}`)
    fresh({ activities: [] })
    const r2 = await as(AS_AGENT, () => m.logActivity({ brokerageId: "", agentId: AG, activityType: "note", title: "x" }))
    check("logActivity: the agent's own → filed under the SESSION agent and tenant", ok(r2) && T("activities")[0]?.agent_id === AG && T("activities")[0]?.brokerage_id === A, JSON.stringify(r2))
  }

  // 11. THE TRUTH FIX — serviceEnrichLead via enrichLead ─────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/lead-management")
    // A lead-desk seat that ALSO holds an agents row, on a lead assigned to it — the one shape the base's agent-filtered
    // update reached, so the base stamps "enriched" / 0.8 here (red at base); a desk seat with no agents row never got that far.
    const DESK_AGENT: Sess = { ...AS_BROKER, agentId: AG }
    const seed = (s: Sess) => ({ users: [usersRow(s)], agents: [agentsRow()], leads: [{ id: X, brokerage_id: A, agent_id: AG, enrichment_status: "pending", enrichment_confidence: null, last_enriched_at: null }] })
    fresh(seed(DESK_AGENT))
    const r: any = await as(DESK_AGENT, () => m.enrichLead(X))
    const lead = T("leads")[0]
    neg("enrichLead: NO enrichment is recorded that did not happen — no 'enriched' stamp, no invented confidence, no fresh last_enriched_at", lead.enrichment_status === "pending" && lead.enrichment_confidence === null && lead.last_enriched_at === null, JSON.stringify(lead))
    check("enrichLead: the request reaches THE governed enrichment door once (tenant = session), and says what it did", ok(r) && r.enrichment === "queued" && SEAM.enrichDoor.length === 1 && SEAM.enrichDoor[0].brokerageId === A && SEAM.enrichDoor[0].leadId === X, `${JSON.stringify(r)} door=${JSON.stringify(SEAM.enrichDoor)}`)
    fresh(seed(AS_AGENT))
    const r2 = await as(AS_AGENT, () => m.enrichLead(X))
    check("enrichLead: an agent seat (not the lead desk) → refused, the door is not called", !ok(r2) && SEAM.enrichDoor.length === 0, JSON.stringify(r2))
  }

  // 12. governLead ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/lead-governance/govern-lead")
    const seed = (s: Sess) => ({ users: [usersRow(s)], agents: [agentsRow()], leads: [{ id: X, brokerage_id: A, agent_id: null, lead_score: null, lead_stage: "new", created_at: "2026-11-01T00:00:00Z" }], activities: [], teams: [], team_members: [], assignment_rules: [], automation_errors: [] })
    fresh(seed(AS_AGENT))
    const r: any = await as(AS_AGENT, () => m.governLead(X))
    neg("governLead: an AGENT seat (not the lead desk) → refused; no score written, nothing reassigned", r?.success === false && T("leads")[0].lead_score === null && T("activities").length === 0, `${JSON.stringify(r).slice(0, 160)} score=${T("leads")[0].lead_score}`)
    fresh(seed(AS_BROKER))
    const r1: any = await as(AS_BROKER, () => m.governLead(X, B))
    check("governLead: a caller-named OTHER tenant → refused through decideClaimedTenant", r1?.success === false && T("leads")[0].lead_score === null, JSON.stringify(r1).slice(0, 160))
    fresh(seed(AS_BROKER))
    const r2: any = await as(AS_BROKER, () => m.governLead(X, A))
    const slots = T("activities").map((a) => a.agent_id)
    check("governLead: the lead desk governs (score written); no activities.agent_id holds a users.id", r2?.success === true && typeof T("leads")[0].lead_score === "number" && !slots.includes(U), `${JSON.stringify(r2).slice(0, 200)} slots=${JSON.stringify(slots)}`)
  }

  // 13. lead-magnets saveMagnetLandingContentAction ──────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/lead-magnets-actions")
    const seed = () => ({ lead_capture_forms: [{ id: X, brokerage_id: A, agent_id: VA, landing_content: null }, { id: Y, brokerage_id: A, agent_id: AG, landing_content: null }] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.saveMagnetLandingContentAction(X, { headline: "mine now" }))
    const r1 = await as(AS_AGENT, () => m.saveMagnetLandingContentAction(u(99), { headline: "ghost" }))
    neg("saveMagnetLandingContentAction: ANOTHER agent's magnet / an unknown id (zero rows) → failure, copy untouched", !ok(r) && !ok(r1) && T("lead_capture_forms").find((f) => f.id === X)?.landing_content === null, `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.saveMagnetLandingContentAction(Y, { headline: "Spring guide" }))
    const r3 = await as(AS_BROKER, () => m.saveMagnetLandingContentAction(X, { headline: "Office edit" }))
    check("saveMagnetLandingContentAction: the agent's own magnet, and the admin roster on any tenant magnet → saved", ok(r2) && ok(r3) && T("lead_capture_forms").find((f) => f.id === Y)?.landing_content?.headline === "Spring guide" && T("lead_capture_forms").find((f) => f.id === X)?.landing_content?.headline === "Office edit", `${JSON.stringify(r2)} ${JSON.stringify(r3)}`)
  }

  // 14. ai-lead-nurturing aiPredictConversion ────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/ai-lead-nurturing")
    const seed = () => ({ users: [usersRow(AS_AGENT)], contacts: [{ id: C, brokerage_id: A, ai_conversion_probability: null }, { id: C2, brokerage_id: B }], activities: [], property_views: [] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.aiPredictConversion({ contactId: C2 }))
    neg("aiPredictConversion: another tenant's contact → refused BEFORE the paid model (model seam: 0 calls)", !ok(r) && SEAM.model === 0, `${JSON.stringify(r)} model=${SEAM.model}`)
    fresh(seed(), { missingColumns: { contacts: ["ai_conversion_probability"] } })
    const r1: any = await as(AS_AGENT, () => m.aiPredictConversion({ contactId: C }))
    neg("aiPredictConversion: a REFUSED write → success:false, persisted:false (not a forecast the Contact never received)", r1?.success === false && r1?.persisted === false, JSON.stringify(r1).slice(0, 200))
    fresh(seed())
    const r2: any = await as(AS_AGENT, () => m.aiPredictConversion({ contactId: C }))
    check("aiPredictConversion: own tenant's contact → one model call, recorded, success", ok(r2) && r2.persisted === true && SEAM.model === 1 && T("contacts").find((c) => c.id === C)?.ai_conversion_probability === 42, JSON.stringify(r2).slice(0, 160))
  }

  // 15. ai-client-portal markResourceCompleted ───────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/ai-client-portal")
    const seed = (s: Sess) => ({ users: [usersRow(s)], contacts: [{ id: C, brokerage_id: A, contact_user_id: CU, email: "seller@example.test" }], learning_assignments: [], portal_contact_invites: [] })
    fresh(seed(AS_CONTACT))
    const r = await as(ANON, () => m.markResourceCompleted({ contactId: C, resourceId: M, brokerageId: B }))
    neg("markResourceCompleted: no session, body tenant B → refused, no completion filed", !ok(r) && T("learning_assignments").length === 0, `${JSON.stringify(r)} rows=${T("learning_assignments").length}`)
    fresh(seed(AS_CONTACT))
    const r1 = await as(AS_CONTACT, () => m.markResourceCompleted({ contactId: C, resourceId: M, brokerageId: B }))
    check("markResourceCompleted: the contact naming ANOTHER tenant in the body → refused", !ok(r1) && T("learning_assignments").length === 0, JSON.stringify(r1))
    fresh(seed(AS_BROKER))
    const r2 = await as(AS_BROKER, () => m.markResourceCompleted({ contactId: C, resourceId: M }))
    check("markResourceCompleted: a staff seat is refused (the row records the CLIENT's own act)", !ok(r2) && T("learning_assignments").length === 0, JSON.stringify(r2))
    fresh(seed(AS_CONTACT))
    const r3 = await as(AS_CONTACT, () => m.markResourceCompleted({ contactId: C, resourceId: M }))
    check("markResourceCompleted: the contact themselves → completed in the contact's tenant, one receipt", ok(r3) && T("learning_assignments")[0]?.brokerage_id === A && receipts("portal.learning_module.complete").length === 1, JSON.stringify(r3))
  }

  // 16. cma-generator generateCMA ────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/cma-presentation/cma-generator")
    const seed = () => ({ users: [usersRow(AS_AGENT)], agents: [agentsRow()], listings: [{ id: L, brokerage_id: A, address: "1 Main", city: "Destin", state: "FL", zip: "32541", sqft: 1800 }, { id: L2, brokerage_id: B, address: "9 Elm" }], activities: [], property_upgrades: [] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.generateCMA({ listingId: L2, contactId: C, agentId: AG }))
    neg("generateCMA: another tenant's listing → refused before ANY write or the paid CMA pipeline (0 activities, 0 pipeline calls)", !ok(r) && T("activities").length === 0 && SEAM.aicma.length === 0, `${JSON.stringify(r)} acts=${T("activities").length} cma=${SEAM.aicma.length}`)
    fresh(seed())
    const r1 = await as(AS_AGENT, () => m.generateCMA({ listingId: L, contactId: C, agentId: VA }))
    check("generateCMA: an agentId naming ANOTHER agent → refused", !ok(r1) && SEAM.aicma.length === 0, JSON.stringify(r1))
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.generateCMA({ listingId: L, contactId: C, agentId: AG }))
    check("generateCMA: own listing → the pipeline runs once AS the session agent; activities carry the session tenant + agents.id", ok(r2) && SEAM.aicma.length === 1 && SEAM.aicma[0].agentId === AG && T("activities").length === 2 && T("activities").every((a) => a.brokerage_id === A && a.agent_id === AG), `${JSON.stringify(r2)} acts=${JSON.stringify(T("activities").map((a) => [a.brokerage_id === A, a.agent_id]))}`)
  }

  // 17. seller-equity setSellerMortgageBalance ───────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/seller-equity")
    const seed = (s: Sess) => ({ users: [usersRow(s)], contacts: [{ id: C, brokerage_id: A, contact_user_id: CU, email: "seller@example.test", metadata: { mortgage_balance: 100000 } }], portal_contact_invites: [] })
    fresh(seed(AS_CONTACT))
    const r = await as(ANON, () => m.setSellerMortgageBalance(C, 1))
    neg("setSellerMortgageBalance: no session → refused, the seller's balance unchanged", !ok(r) && T("contacts")[0].metadata.mortgage_balance === 100000, `${JSON.stringify(r)} md=${JSON.stringify(T("contacts")[0].metadata)}`)
    fresh(seed(AS_CONTACT))
    const r2 = await as(AS_CONTACT, () => m.setSellerMortgageBalance(C, 250000))
    check("setSellerMortgageBalance: the seller themselves → saved (counted), one receipt that carries no amount", ok(r2) && T("contacts")[0].metadata.mortgage_balance === 250000 && receipts("portal.seller_mortgage_balance.set").length === 1 && !JSON.stringify(receipts("portal.seller_mortgage_balance.set")[0]).includes("250000"), JSON.stringify(r2))
  }

  // 18. generate-social-post generateWeeklyContentPlan ───────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/social/generate-social-post")
    const seed = () => ({ users: [usersRow(AS_AGENT)], campaign_calendar: [] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.generateWeeklyContentPlan({ brokerageId: B, agentId: U }))
    neg("generateWeeklyContentPlan: a body tenant naming ANOTHER brokerage → refused BEFORE the paid model (0 calls)", !ok(r) && SEAM.model === 0 && T("campaign_calendar").length === 0, `${JSON.stringify(r)} model=${SEAM.model}`)
    fresh(seed())
    const r1 = await as(AS_AGENT, () => m.generateWeeklyContentPlan({ brokerageId: A, agentId: V }))
    check("generateWeeklyContentPlan: a body agentId naming ANOTHER user → refused, 0 model calls", !ok(r1) && SEAM.model === 0, JSON.stringify(r1))
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.generateWeeklyContentPlan({ brokerageId: A, agentId: U }))
    check("generateWeeklyContentPlan: own session → one model call, calendar rows carry the session user + tenant, one receipt", ok(r2) && SEAM.model === 1 && T("campaign_calendar").length === 1 && T("campaign_calendar")[0].agent_user_id === U && T("campaign_calendar")[0].brokerage_id === A && receipts("social.weekly_plan.generate").length === 1, JSON.stringify(r2).slice(0, 160))
  }

  // 19. training progress route ──────────────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/api/onboarding/training/progress/route")
    const req = (body: unknown) => new Request("http://localhost/api/onboarding/training/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    fresh({ video_completion_tracking: [] })
    const r: any = await as(ANON, () => m.POST(req({ videoId: X, positionSeconds: 10, percentWatched: 50 })))
    neg("training progress route: an anonymous POST → 401, no completion row", r?.status === 401 && T("video_completion_tracking").length === 0, `status=${r?.status} rows=${T("video_completion_tracking").length}`)
    fresh({ video_completion_tracking: [] })
    const r2: any = await as(AS_AGENT, () => m.POST(req({ videoId: Y, positionSeconds: 10, percentWatched: 50 })))
    check("training progress route: the agent's session → 200, progress recorded under the session agent", r2?.status === 200 && T("video_completion_tracking")[0]?.agent_id === AG && T("video_completion_tracking")[0]?.brokerage_id === A, `status=${r2?.status}`)
  }

  // 20. idx-search saveProperty / unsaveProperty ─────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/idx-search")
    const seed = (s: Sess) => ({ users: [usersRow(s)], contacts: [{ id: C, brokerage_id: A, contact_user_id: CU, email: "seller@example.test", user_id: CU }], saved_properties: [{ id: X, contact_id: C, mls_number: "MLS-1" }], portal_contact_invites: [], behavioral_events: [] })
    fresh(seed(AS_CONTACT))
    const r = await as(ANON, () => m.saveProperty({ contactId: C, mlsNumber: "MLS-2", propertyData: { brokerageId: B } }))
    const r1 = await as(ANON, () => m.unsaveProperty({ contactId: C, mlsNumber: "MLS-1" }))
    neg("saveProperty / unsaveProperty: no session → refused; nothing saved onto the contact, nothing removed", !ok(r) && !ok(r1) && T("saved_properties").length === 1, `${JSON.stringify(r)} ${JSON.stringify(r1)} rows=${T("saved_properties").length}`)
    fresh(seed(AS_CONTACT))
    const r2 = await as(AS_CONTACT, () => m.saveProperty({ contactId: C, mlsNumber: "MLS-2", propertyData: { brokerageId: B, address: "2 Bay" } }))
    check("saveProperty: the contact themselves → saved in the CONTACT's tenant (the body tenant is ignored)", ok(r2) && T("saved_properties").find((p) => p.mls_number === "MLS-2")?.brokerage_id === A, JSON.stringify(r2))
    // 20b. the SECOND unsave door (app/actions/smart-insights.ts unsaveProperty, keyed by saved_properties.id). It called the
    // contact gate only to name its receipt and ran the delete whatever the gate said; it now refuses (CLAUDE.md §4 — fail closed).
    const si = await mod("app/actions/smart-insights")
    fresh(seed(AS_CONTACT))
    const r3 = await as(ANON, () => si.unsaveProperty(C, X))
    neg("smart-insights unsaveProperty: no session → refused; the saved home is still there", !ok(r3) && T("saved_properties").length === 1, `${JSON.stringify(r3)} rows=${T("saved_properties").length}`)
    fresh(seed(AS_CONTACT))
    const r4 = await as(AS_CONTACT, () => si.unsaveProperty(C, X))
    check("smart-insights unsaveProperty: the contact themselves → removed", ok(r4) && T("saved_properties").length === 0, `${JSON.stringify(r4)} rows=${T("saved_properties").length}`)
  }

  // 21. buyer-broker-agreements cancelBBAAction ──────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/buyer-broker-agreements")
    const seed = () => ({ users: [usersRow(AS_AGENT)], agents: [agentsRow()], buyer_broker_agreements: [{ id: X, brokerage_id: A, status: "active" }, { id: Y, brokerage_id: B, status: "active" }, { id: Z, brokerage_id: A, status: "executed" }, { id: M, brokerage_id: A, status: "cancelled", cancellation_reason: "first" }] })
    fresh(seed())
    const r = await as(AS_AGENT, () => m.cancelBBAAction({ agreementId: Y, reason: "changed plans" }))
    const r1 = await as(AS_AGENT, () => m.cancelBBAAction({ agreementId: Z, reason: "changed plans" }))
    neg("cancelBBAAction: another tenant's / an EXECUTED agreement (zero rows) → NOT reported cancelled", !ok(r) && !ok(r1) && T("buyer_broker_agreements").find((a) => a.id === Y)?.status === "active", `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_AGENT, () => m.cancelBBAAction({ agreementId: X, reason: "changed plans" }))
    const r3 = await as(AS_AGENT, () => m.cancelBBAAction({ agreementId: M, reason: "again please" }))
    check("cancelBBAAction: an active agreement → cancelled; an already-cancelled one → ok, its first reason stands", ok(r2) && ok(r3) && T("buyer_broker_agreements").find((a) => a.id === X)?.status === "cancelled" && T("buyer_broker_agreements").find((a) => a.id === M)?.cancellation_reason === "first", `${JSON.stringify(r2)} ${JSON.stringify(r3)}`)
  }

  // 22. isa-phone-numbers toggle / delete ────────────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/isa-phone-numbers")
    const seed = () => ({ users: [usersRow(AS_BROKER)], tenant_phone_numbers: [{ id: X, brokerage_id: A, is_active: true }, { id: Y, brokerage_id: B, is_active: true }] })
    fresh(seed())
    const r = await as(AS_BROKER, () => m.toggleIsaPhoneNumber({ id: Y, active: false }))
    const r1 = await as(AS_BROKER, () => m.deleteIsaPhoneNumber({ id: Y }))
    neg("toggleIsaPhoneNumber / deleteIsaPhoneNumber: another tenant's number (zero rows) → failure, its row untouched", !ok(r) && !ok(r1) && T("tenant_phone_numbers").find((p) => p.id === Y)?.is_active === true, `${JSON.stringify(r)} ${JSON.stringify(r1)}`)
    fresh(seed())
    const r2 = await as(AS_BROKER, () => m.toggleIsaPhoneNumber({ id: X, active: false }))
    const toggled = T("tenant_phone_numbers").find((p) => p.id === X)?.is_active === false
    const r3 = await as(AS_BROKER, () => m.deleteIsaPhoneNumber({ id: X }))
    check("toggleIsaPhoneNumber / deleteIsaPhoneNumber: own number → toggled, then deleted", ok(r2) && toggled && ok(r3) && !T("tenant_phone_numbers").some((p) => p.id === X), `${JSON.stringify(r2)} ${JSON.stringify(r3)}`)
  }

  // 23. license-tracking deleteEducationModule ───────────────────────────────────────────────────────────────────
  {
    const m = await mod("app/actions/admin/license-tracking")
    const staff: Sess = { userId: U, email: "staff@example.test", userType: "admin", brokerageId: A, agentId: null, platformRole: "superadmin" }
    fresh({ users: [usersRow(staff)], learning_modules: [{ id: X, brokerage_id: null, title: "Platform ethics" }, { id: Y, brokerage_id: A }] })
    const r = await as(staff, () => m.deleteEducationModule(X))
    neg("deleteEducationModule: a PLATFORM module (brokerage_id NULL) is really deleted — never a success that deleted nothing", ok(r) && !T("learning_modules").some((x) => x.id === X), `${JSON.stringify(r)} present=${T("learning_modules").some((x) => x.id === X)}`)
    const r2 = await as(staff, () => m.deleteEducationModule(Y))
    check("deleteEducationModule: own tenant module → deleted", ok(r2) && !T("learning_modules").some((x) => x.id === Y), JSON.stringify(r2))
  }

  // 24. the two route files answer as routes ─────────────────────────────────────────────────────────────────────
  for (const [path, name] of [["app/api/track/visitor/route", "track/visitor"], ["app/api/widget/session/route", "widget/session"]] as const) {
    fresh({ brokerages: [], global_settings: [] })
    let m: any
    try { m = await mod(path) } catch (e) { check(`${name}: route module loads`, false, (e as Error).message.slice(0, 200)); continue }
    const res: any = await as(ANON, () => m.POST(new Request(`http://localhost/api/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ brokerage_slug: "no-such-brokerage" }) })))
    const body = res && typeof res.json === "function" ? await res.json().catch(() => null) : null
    const exports = Object.keys(m).filter((k) => k !== "default")
    check(`${name}: the route still ANSWERS (a JSON ${res?.status} for an unknown brokerage) and exports only HTTP verbs`, typeof res?.status === "number" && res.status >= 400 && res.status < 500 && !!body && exports.every((k) => /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|runtime|dynamic|maxDuration|revalidate)$/.test(k)), `status=${res?.status} body=${JSON.stringify(body)} exports=${exports}`)
  }
}

// ─── §B static ──────────────────────────────────────────────────────────────────────────────────────────────────────
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** A `"use server"` / `'use server'` DIRECTIVE: the first statement of the stripped file. */
const hasDirective = (src: string) => /^\s*(["'])use server\1\s*;?/.test(stripComments(src))
/** A stamp of the invented enrichment: the literal "enriched" as a status, or a constant confidence. */
const stampsEnrichment = (src: string) => /enrichment_status\s*:\s*["']enriched["']|enrichment_confidence\s*:\s*0?\.\d/.test(stripComments(src))
/** The body of one export, from stripped source. */
function exportBody(src: string, fn: string): string {
  const s = stripComments(src)
  const i = s.search(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`))
  if (i < 0) return ""
  const next = s.slice(i + 10).search(/\nexport\s+(async\s+)?function\s/)
  return next < 0 ? s.slice(i) : s.slice(i, i + 10 + next)
}
const GATES: Array<[string, string, RegExp]> = [
  ["app/actions/lifetime-customers.ts", "scheduleTouchpoint", /isAuthenticated/],
  ["app/actions/lifetime-customers.ts", "generateTouchpoint", /isAuthenticated/],
  ["app/actions/lifetime-customers.ts", "findReferralOpportunities", /isAuthenticated/],
  ["app/actions/podcast-generation.ts", "updateDistributionChannel", /isAuthenticated/],
  ["app/actions/social-media-automation.ts", "retryFailedPost", /requireBrokerage\(\)/],
  ["app/actions/social-media-automation.ts", "deleteSocialPost", /requireBrokerage\(\)/],
  ["app/actions/ai-tools-hub.ts", "toggleToolFavorite", /requireCaller\(\)/],
  ["app/actions/ai-tools-hub.ts", "getUserFavorites", /resolveCallerIdentity\(\)/],
  ["app/actions/ai-client-portal.ts", "markResourceCompleted", /requireContactAccess\(/],
  ["app/actions/cma-presentation/cma-generator.ts", "generateCMA", /requireCallerWithAgent\(\)/],
  ["app/actions/seller-equity.ts", "setSellerMortgageBalance", /requireContactAccess\(/],
  ["app/actions/social/generate-social-post.ts", "generateWeeklyContentPlan", /requireCallerTenant\(params\.brokerageId\)/],
  ["app/actions/lead-governance/govern-lead.ts", "governLead", /resolveLeadVisibility\(/],
  ["app/actions/lead-magnets-actions.ts", "saveMagnetLandingContentAction", /isAdminOrBroker\(/],
]

function staticChecks() {
  console.log("\n[§B static — stripped source]")
  for (const p of ["app/actions/voice-assistant/core/emit-audit-event.ts", "app/api/track/visitor/route.ts", "app/api/widget/session/route.ts"]) {
    neg(`${p}: carries NO "use server" directive (not a public server-action endpoint)`, !hasDirective(read(p)))
  }
  check("emit-audit-event.ts is a server-only module (import \"server-only\")", /import\s+["']server-only["']/.test(stripComments(read("app/actions/voice-assistant/core/emit-audit-event.ts"))))
  check("POSITIVE CONTROL: the directive finder flags a planted 'use server' (behind a comment) and a planted \"use server\"", hasDirective("// header\n'use server'\nexport async function x() {}") && hasDirective(`"use server"\nexport const y = 1`) && !hasDirective(`// "use server" in prose only\nexport const z = 1`))
  neg("lead-application-service.ts: serviceEnrichLead stamps no invented enrichment (no 'enriched' status, no constant confidence)", !stampsEnrichment(exportBody(read("lib/application/lead-application-service.ts"), "serviceEnrichLead")) && exportBody(read("lib/application/lead-application-service.ts"), "serviceEnrichLead").includes("queueLeadEnrichment"))
  check("POSITIVE CONTROL: the stamp finder flags the base's exact stamp", stampsEnrichment(`.update({ enrichment_status: "enriched", enrichment_confidence: 0.8 })`) && !stampsEnrichment(`// enrichment_status: "enriched" was the lie\nconst x = 1`))
  for (const [file, fn, gate] of GATES) {
    const body = exportBody(read(file), fn)
    check(`${file} ${fn}: reaches its gate (${gate.source})`, body.length > 0 && gate.test(body), body ? "" : "export not found")
  }
  const planted = `export async function plantedExport(id: string) {\n  // requireContactAccess( named only in a comment\n  return id\n}\n`
  check("POSITIVE CONTROL: the gate finder flags a planted export whose gate exists only in a comment", !/requireContactAccess\(/.test(exportBody(planted, "plantedExport")))
}

async function main() {
  console.log("wave155-ungated-platform — lane 155S3")
  await driven()
  staticChecks()
  console.log(`\nNEGATIVE canaries (each RED at base 81cdddae): ${redAtBase.length}`)
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed (SIMULATED)`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
