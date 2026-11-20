#!/usr/bin/env tsx
/**
 * scripts/public-door-decision-guard.ts — `npm run test:public-door-decision` (wave 155, lane 155R5).
 *
 * PUBLIC DOORS, PROVIDER CALLBACKS AND AI SPEND decide, record and can be read (arbitration groups G10 / G11 / G13 / G99).
 * Every case drives the REAL action or route against the in-memory client (scripts/in-memory-supabase.ts). Only the
 * session (the cookie client's auth.getUser / getAgentContext), the service-client constructor, the model / provider seams
 * and the Stripe signature resolver are replaced — every seam COUNTS its calls. All results are SIMULATED.
 *
 *   A  INJECT-001 / PRIV-001  the portal offer decision: the SESSION proves the client; a forged contactId, a staff preview and
 *                            another tenant's offer write nothing; the legitimate client still succeeds.
 *   B  SCOPE                  campaign step delete / reorder: no session → refused; another tenant's step → refused, zero
 *                            deletes; own step → deleted + ONE action-ledger row.
 *   C  INJECT-001            listing-media compliance: a body brokerageId other than the session's reaches no check.
 *   D  SCOPE-002 (spend)     knowledge re-embed: over the cap → ZERO model-seam calls and a typed refusal; another tenant's or
 *                            a platform row → refused; the platform-wide backfill → platform staff only.
 *   E  G11                   each AI generate-and-return action leaves ONE ledger row (risk READ) AND the SAME one cost row.
 *   F  G13                   the vendor Stripe webhook: forged signature refused before any write; a replayed event adds ZERO
 *                            ledger rows and ZERO writes; a tenant-signed delivery moves nothing.
 *   G  INJECT-001 / G99      the widget session: an un-opted-in slug writes nothing (body brokerage_id ignored); a legitimate
 *                            visitor gets a session under the SLUG's tenant + one ledger row naming it.
 *   H  rules over STRIPPED source, each with a positive control: no "use server" file exports a provider applier; the voice
 *                            catalog asks the session before the provider; track-share never stores the body's contact id; the
 *                            landing counter never writes a caller's number.
 *   I  (lane 155R18, G10)    lib/security/public-rate-limit.ts decidePublicDoor — the cap FIRST (the opt-in read is never reached
 *                            over it), then the tenant's own opt-in row, fail closed — driven through the real blog trackers, the
 *                            embed beacons (a forged two-hour report bills only the elapsed time), the dwell tracker, buyer intake,
 *                            outside-agent showing, recruiting, the landing counter and the collaborator token; plus a STRIPPED-source
 *                            order rule over all 16 doors (decision before the first write) with positive controls. RED AT 81cdddae:
 *                            11 of 59 with only the doors reverted; `decidePublicDoor is not a function` with the library reverted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const G = globalThis as any
G.__R5 = {
  svc: null as MemClient | null,
  user: null as { id: string; email?: string } | null,
  ctx: null as Record<string, unknown> | null,
  cap: { allowed: true, used: 0, limit: 100, percent: 0, soft_warning: false } as Record<string, unknown>,
  verification: null as Record<string, unknown> | null,
  calls: { compliance: [] as Row[], model: 0, embed: 0, backfill: 0, events: [] as Row[] },
}
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__R5.svc",
  "@/lib/supabase/server": "export const createClient = async () => ({ ...globalThis.__R5.svc, auth: { getUser: async () => ({ data: { user: globalThis.__R5.user }, error: null }) } })",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f",
  "@/lib/identity": "export const getAgentContext = async () => globalThis.__R5.ctx",
  "@/lib/identity/get-agent-context": "export const getAgentContext = async () => globalThis.__R5.ctx",
  "@/lib/kernel/brand-compliance": "export const checkBrandCompliance = async (p) => { globalThis.__R5.calls.compliance.push(p); return { passed: true, violations: [] } }",
  "@/lib/kernel/emit": "export const emitKernelEvent = async (e) => { globalThis.__R5.calls.events.push(e); return { inserted: true } }; export const asWriteResult = () => ({ error: null })",
  "@/lib/usage/check-cap": "export const checkUsageCap = async () => globalThis.__R5.cap",
  // The model seams: each call counts, and each writes the ONE cost row its real inner call writes (ai_tool_usage).
  "@/lib/workflow/intelligence/agent-pattern-insights": "export const getAgentPatternInsights = async (p) => { globalThis.__R5.calls.model++; await globalThis.__R5.svc.from('ai_tool_usage').insert({ brokerage_id: p.brokerageId, tool_name: 'agent_insights', cost_usd: 0.01 }); return { insights: [], generatedFor: p.agentUserId } }",
  "@/lib/workflow/intelligence/multi-offer-matrix": "export const buildCounterOfferDiff = async (p) => { globalThis.__R5.calls.model++; await globalThis.__R5.svc.from('ai_tool_usage').insert({ brokerage_id: 'from-seam', tool_name: 'counter_offer_diff', cost_usd: 0.02 }); return { offerId: p.offerId, changes: [] } }",
  "@/lib/knowledge/embedding-service": [
    "export const updateHelpTopicEmbedding = async () => { globalThis.__R5.calls.embed++ }",
    "export const updateArticleEmbedding = async () => { globalThis.__R5.calls.embed++ }",
    "export const backfillHelpTopicEmbeddings = async () => { globalThis.__R5.calls.backfill++; return { total: 0, processed: 0, failed: 0 } }",
    "export const ragSearch = async () => ({}); export const semanticSearchHelpTopics = async () => []; export const semanticSearchArticles = async () => []",
    "export const queueForEmbedding = async () => ({}); export const searchOsCopy = async () => []; export const renderOsCopyContext = () => ''",
  ].join("\n"),
  "@/lib/intelligence/kb-search": "export const embedAndStore = async () => { globalThis.__R5.calls.embed++ }; export const getArticlesNeedingEmbedding = async () => []",
  "@/lib/billing/stripe-webhook-secrets": "export const verifyStripeWebhook = async () => globalThis.__R5.verification",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK_A = "a1111111-1111-4111-8111-111111111111"
const BRK_B = "b2222222-2222-4222-8222-222222222222"
const U_AGENT = "a0000000-0000-4000-8000-0000000000a1"
const AGENT_A = "a0000000-0000-4000-8000-0000000000a2"
const U_CONTACT = "c0000000-0000-4000-8000-0000000000c1"
const CONTACT_A = "c0000000-0000-4000-8000-0000000000c2"
const CONTACT_A2 = "c0000000-0000-4000-8000-0000000000c3"
const OFFER_A = "f0000000-0000-4000-8000-0000000000f1"
const OFFER_B = "f0000000-0000-4000-8000-0000000000f2"

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const o = { log: console.log, warn: console.warn, error: console.error }
  console.warn = () => {}; console.error = () => {}
  try { return await f() } finally { console.warn = o.warn; console.error = o.error }
}
const ledger = (svc: MemClient, action?: string) => (svc.tables.agent_action_ledger ?? []).filter((r: Row) => !action || r.action === action)
const writesTo = (svc: MemClient, table: string) => svc.writes.filter((w: any) => w.table === table).length
const agentCtx = (brokerageId: string | null, authed = true) => ({ isAuthenticated: authed, userId: authed ? U_AGENT : "", agentId: AGENT_A, brokerageId, userType: "agent" })
const UNIQUE = { unique: { agent_action_ledger: [["idempotency_key"]] } }

async function main() {
  // ── A · portal offer decision ───────────────────────────────────────────────
  console.log("\n[A · INJECT-001 / PRIV-001 — the SESSION proves the client; the argument contactId is only a claim]")
  const pod = await import("../app/actions/portal-offer-decision")
  const worldA = () => memSupabase({
    users: [{ id: U_CONTACT, brokerage_id: BRK_A, user_type: "contact" }, { id: U_AGENT, brokerage_id: BRK_A, user_type: "agent" }],
    contacts: [
      { id: CONTACT_A, brokerage_id: BRK_A, email: "pat@example.test", contact_user_id: null },
      { id: CONTACT_A2, brokerage_id: BRK_A, email: "lee@example.test", contact_user_id: null },
    ],
    offers: [
      { id: OFFER_A, contact_id: CONTACT_A, agent_id: AGENT_A, brokerage_id: BRK_A, offer_price: 500000, status: "submitted", listing_id: null, transaction_id: null },
      { id: OFFER_B, contact_id: CONTACT_A, agent_id: AGENT_A, brokerage_id: BRK_B, offer_price: 900000, status: "submitted", listing_id: null, transaction_id: null },
    ],
    portal_contact_invites: [], client_portal_activity: [], tasks: [],
  })
  const runA = async (user: { id: string; email?: string } | null, input: { contactId: string; offerId: string }) => {
    G.__R5.svc = worldA(); G.__R5.user = user; G.__R5.calls.events = []
    const r = await quiet(() => pod.recordClientOfferDecision({ ...input, decision: "accept" }))
    const svc = G.__R5.svc as MemClient
    return { r, events: G.__R5.calls.events.length, wrote: writesTo(svc, "client_portal_activity") + writesTo(svc, "tasks") }
  }
  const legit = await runA({ id: U_CONTACT, email: "pat@example.test" }, { contactId: CONTACT_A, offerId: OFFER_A })
  ok("legitimate client (session email = the contact) → success, one decision event recorded", legit.r.success === true && legit.events === 1, JSON.stringify(legit))
  const forged = await runA({ id: U_CONTACT, email: "pat@example.test" }, { contactId: CONTACT_A2, offerId: OFFER_A })
  ok("forged contactId (another contact of the tenant) → refused, ZERO events, ZERO writes", forged.r.success === false && forged.events === 0 && forged.wrote === 0, JSON.stringify(forged))
  const cross = await runA({ id: U_CONTACT, email: "pat@example.test" }, { contactId: CONTACT_A, offerId: OFFER_B })
  ok("another tenant's offer naming the same contact → 'Offer not found' (indistinguishable from unknown), ZERO writes", cross.r.success === false && cross.r.error === "Offer not found" && cross.events === 0 && cross.wrote === 0, JSON.stringify(cross))
  const preview = await runA({ id: U_AGENT, email: "agent@example.test" }, { contactId: CONTACT_A, offerId: OFFER_A })
  ok("a staff preview of the portal cannot file the client's word → refused, ZERO events", preview.r.success === false && preview.events === 0, JSON.stringify(preview))
  const anon = await runA(null, { contactId: CONTACT_A, offerId: OFFER_A })
  ok("no session → refused, ZERO events", anon.r.success === false && anon.events === 0)

  // ── B · campaign steps ─────────────────────────────────────────────────────
  console.log("\n[B · campaign step delete / reorder — the step's own sequence must be the session tenant's]")
  const cs = await import("../app/actions/campaign-sequences")
  const worldB = () => memSupabase({
    campaign_sequences: [{ id: "seq-a", brokerage_id: BRK_A }, { id: "seq-b", brokerage_id: BRK_B }],
    campaign_sequence_steps: [{ id: "step-a1", sequence_id: "seq-a", step_number: 1 }, { id: "step-a2", sequence_id: "seq-a", step_number: 2 }, { id: "step-b1", sequence_id: "seq-b", step_number: 1 }],
    agent_action_ledger: [],
  }, UNIQUE)
  const has = (svc: MemClient, id: string) => (svc.tables.campaign_sequence_steps ?? []).some((r: Row) => r.id === id)
  G.__R5.svc = worldB(); G.__R5.ctx = agentCtx(null, false)
  const bAnon = await quiet(() => cs.deleteSequenceStep("step-b1", "seq-b"))
  ok("no session → refused; the step still exists", bAnon.success === false && has(G.__R5.svc, "step-b1"))
  G.__R5.ctx = agentCtx(BRK_A)
  const bForeign = await quiet(() => cs.deleteSequenceStep("step-b1", "seq-a"))
  ok("tenant A deleting tenant B's step (with A's sequence id) → Unauthorized, ZERO deletes, ZERO ledger rows", bForeign.success === false && has(G.__R5.svc, "step-b1") && writesTo(G.__R5.svc, "campaign_sequence_steps") === 0 && ledger(G.__R5.svc).length === 0)
  const bOwn = await quiet(() => cs.deleteSequenceStep("step-a1", "seq-a"))
  const bRow = ledger(G.__R5.svc, "marketing.sequence_step.delete")
  ok("own step → deleted, and ONE ledger row naming the tenant, the user and the step", bOwn.success === true && !has(G.__R5.svc, "step-a1") && bRow.length === 1 && bRow[0].brokerage_id === BRK_A && bRow[0].actor_user_id === U_AGENT && bRow[0].subject_id === "step-a1" && bRow[0].status === "executed", JSON.stringify(bRow))
  const reo = await quiet(() => cs.reorderSequenceSteps([{ id: "step-a2", step_number: 1 }, { id: "step-b1", step_number: 2 }], "seq-a"))
  ok("reorder mixing in another tenant's step → Unauthorized, ZERO updates", reo.success === false && (G.__R5.svc.tables.campaign_sequence_steps as Row[]).find((r) => r.id === "step-b1")!.step_number === 1 && writesTo(G.__R5.svc, "campaign_sequence_steps") === 1)

  // ── C · listing-media compliance ───────────────────────────────────────────
  console.log("\n[C · INJECT-001 — a body brokerageId reaches no compliance check]")
  const lm = await import("../app/actions/listing-media")
  G.__R5.svc = memSupabase({ users: [{ id: U_AGENT, brokerage_id: BRK_A, user_type: "agent", platform_role: null }] })
  G.__R5.user = { id: U_AGENT, email: "agent@example.test" }; G.__R5.calls.compliance = []
  const cForeign = await quiet(() => lm.runComplianceCheck("media-1", BRK_B))
  ok("claimed tenant B by a tenant-A session → refused, ZERO checks run", cForeign.passed === false && G.__R5.calls.compliance.length === 0, JSON.stringify(cForeign))
  const cOwn = await quiet(() => lm.runComplianceCheck("media-1", BRK_A))
  ok("own tenant → the check runs once, keyed to the SESSION tenant", cOwn.passed === true && G.__R5.calls.compliance.length === 1 && G.__R5.calls.compliance[0].brokerageId === BRK_A)

  // ── D · knowledge embeddings: cap before spend ─────────────────────────────
  console.log("\n[D · SCOPE-002 — the usage cap and the row's owner decide BEFORE the model is called]")
  const ks = await import("../app/actions/knowledge/search")
  const worldD = () => memSupabase({
    users: [{ id: U_AGENT, brokerage_id: BRK_A, user_type: "agent", platform_role: null }],
    knowledge_articles: [{ id: "art-a", brokerage_id: BRK_A }, { id: "art-b", brokerage_id: BRK_B }],
    help_topics_kb: [{ id: "topic-p", brokerage_id: null }],
    agent_action_ledger: [],
  })
  const tryD = async (f: () => Promise<unknown>) => { try { await quiet(f as () => Promise<unknown>); return null } catch (e) { return (e as Error).message } }
  G.__R5.svc = worldD(); G.__R5.user = { id: U_AGENT }; G.__R5.ctx = agentCtx(BRK_A); G.__R5.calls.embed = 0
  G.__R5.cap = { allowed: false, used: 100, limit: 100, percent: 100, soft_warning: false, message: "Monthly AI cap reached (100 of 100)." }
  const over = await tryD(() => ks.regenerateEmbedding("knowledge_articles", "art-a"))
  ok("over the cap → ZERO model-seam calls and a typed refusal naming the cap", over === "Monthly AI cap reached (100 of 100)." && G.__R5.calls.embed === 0, String(over))
  G.__R5.cap = { allowed: true, used: 1, limit: 100, percent: 1, soft_warning: false }
  const under = await tryD(() => ks.regenerateEmbedding("knowledge_articles", "art-a"))
  ok("under the cap, own row → ONE model call and ONE ledger row", under === null && G.__R5.calls.embed === 1 && ledger(G.__R5.svc, "knowledge.embedding.regenerate").length === 1)
  const foreign = await tryD(() => ks.regenerateEmbedding("knowledge_articles", "art-b"))
  const platform = await tryD(() => ks.regenerateEmbedding("help_topics_kb", "topic-p"))
  ok("another tenant's row, and a platform row for a non-staff seat → refused, ZERO further model calls", !!foreign && !!platform && G.__R5.calls.embed === 1)
  G.__R5.calls.backfill = 0
  const bf = await tryD(() => ks.backfillAllEmbeddings())
  ok("the platform-wide backfill by a tenant seat → refused, ZERO backfill calls", !!bf && G.__R5.calls.backfill === 0)

  // ── E · G11: one ledger row AND the same one cost row ──────────────────────
  console.log("\n[E · G11 — each AI generate-and-return action: ONE ledger row (READ) + the SAME one ai_tool_usage row]")
  const ai = await import("../app/actions/agent-insights")
  const cod = await import("../app/actions/counter-offer-diff")
  G.__R5.svc = memSupabase({ users: [{ id: U_AGENT, brokerage_id: BRK_A }], offers: [{ id: OFFER_A, brokerage_id: BRK_A }], agent_action_ledger: [], ai_tool_usage: [] })
  G.__R5.user = { id: U_AGENT }; G.__R5.calls.model = 0
  await quiet(() => ai.loadMyAgentInsights())
  const insightRows = ledger(G.__R5.svc, "ai.agent_insights.generate")
  ok("agent insights → one model call, ONE cost row, ONE ledger row (risk READ, HUMAN_REQUESTED, executed)", G.__R5.calls.model === 1 && (G.__R5.svc.tables.ai_tool_usage as Row[]).length === 1 && insightRows.length === 1 && insightRows[0].risk_class === "READ" && insightRows[0].reason_code === "HUMAN_REQUESTED" && insightRows[0].status === "executed", JSON.stringify(insightRows))
  const diff = await quiet(() => cod.loadCounterOfferDiff({ offerId: OFFER_A, counterPayload: { price: 1 } }))
  ok("counter-offer diff → the caller's result shape unchanged, ONE more cost row, ONE ledger row", diff.success === true && (G.__R5.svc.tables.ai_tool_usage as Row[]).length === 2 && ledger(G.__R5.svc, "ai.counter_offer_diff.generate").length === 1)
  G.__R5.user = null
  const anonAi = await quiet(() => ai.loadMyAgentInsights())
  ok("no session → null, ZERO model calls, ZERO cost rows added", anonAi === null && G.__R5.calls.model === 2 && (G.__R5.svc.tables.ai_tool_usage as Row[]).length === 2)

  // ── F · G13: the vendor Stripe webhook ─────────────────────────────────────
  console.log("\n[F · G13 — forged refused before any write; a replayed event adds ZERO rows; a tenant signer moves nothing]")
  const vendorRoute = await import("../app/api/webhooks/stripe/vendor/route")
  G.__R5.svc = memSupabase({
    vendor_marketplace_profiles: [{ id: "vp-1", user_id: "vu-1", stripe_customer_id: "cus_1", status: "approved", subscription_status: "active" }],
    users: [{ id: "vu-1", brokerage_id: BRK_A }], agent_action_ledger: [], vendor_payouts: [],
  }, UNIQUE)
  const post = (body = "{}") => vendorRoute.POST(new Request("http://localhost/api/webhooks/stripe/vendor", { method: "POST", body, headers: { "stripe-signature": "t=1,v1=x" } }) as never)
  const evt = { id: "evt_1", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000), data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { vendor_profile_id: "vp-1" } } } }
  G.__R5.verification = { status: "unverified", message: "No signatures found matching the expected signature" }
  const forgedRes = await quiet(() => post())
  ok("forged signature → 400 before any write (ZERO profile writes, ZERO ledger rows)", forgedRes.status === 400 && writesTo(G.__R5.svc, "vendor_marketplace_profiles") === 0 && ledger(G.__R5.svc).length === 0)
  G.__R5.verification = { status: "verified", event: evt, ownerType: "brokerage", ownerId: BRK_B }
  const tenantRes = await quiet(() => post())
  ok("a tenant-signed subscription event → acknowledged, applied:false, ZERO writes", tenantRes.status === 200 && (await tenantRes.json()).applied === false && writesTo(G.__R5.svc, "vendor_marketplace_profiles") === 0)
  G.__R5.verification = { status: "verified", event: evt, ownerType: "platform", ownerId: null }
  const first = await quiet(() => post())
  const vp = (G.__R5.svc.tables.vendor_marketplace_profiles as Row[])[0]
  const vRows = ledger(G.__R5.svc, "vendor.subscription.apply_provider_event")
  ok("platform-signed cancellation → suspended, ONE ledger row (system actor, tenant from OUR row, key stripe_vendor:evt_1)", first.status === 200 && vp.status === "suspended" && vRows.length === 1 && vRows[0].brokerage_id === BRK_A && vRows[0].actor_type === "system" && vRows[0].idempotency_key === "stripe_vendor:evt_1" && vRows[0].status === "executed", JSON.stringify(vRows))
  const writesAfterFirst = writesTo(G.__R5.svc, "vendor_marketplace_profiles")
  const replay = await quiet(() => post())
  ok("the SAME event redelivered → 200, ZERO new ledger rows, ZERO new profile writes", replay.status === 200 && ledger(G.__R5.svc, "vendor.subscription.apply_provider_event").length === 1 && writesTo(G.__R5.svc, "vendor_marketplace_profiles") === writesAfterFirst)

  // ── G · G99 / INJECT-001: the widget session ───────────────────────────────
  console.log("\n[G · the widget session — the slug's own opt-in decides; the body's brokerage_id is ignored]")
  const ws = await import("../app/api/widget/session/route")
  G.__R5.svc = memSupabase({
    brokerages: [{ id: BRK_A, slug: "alpha", name: "Alpha Realty", widget_enabled: true, deleted_at: null, status: "active" }, { id: BRK_B, slug: "beta", name: "Beta", widget_enabled: false, deleted_at: null, status: "active" }],
    agents: [], chat_sessions: [], agent_action_ledger: [],
  })
  const mint = (body: Record<string, unknown>) => ws.POST(new Request("http://localhost/api/widget/session", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "10.9.8.7" } }) as never)
  const off = await quiet(() => mint({ brokerage_slug: "beta", brokerage_id: BRK_A }))
  ok("un-opted-in slug (widget off) with a body brokerage_id → 403, ZERO sessions, ZERO ledger rows", off.status === 403 && (G.__R5.svc.tables.chat_sessions as Row[]).length === 0 && ledger(G.__R5.svc).length === 0)
  const on = await quiet(() => mint({ brokerage_slug: "alpha", brokerage_id: BRK_B }))
  const onBody = await on.json()
  const sess = (G.__R5.svc.tables.chat_sessions as Row[])
  const wRow = ledger(G.__R5.svc, "customer.widget_session.open")
  ok("legitimate visitor → 200 with a session token, filed under the SLUG's tenant (A), never the body's (B)", on.status === 200 && typeof onBody.session_token === "string" && sess.length === 1 && sess[0].brokerage_id === BRK_A)
  ok("…and ONE ledger row for tenant A whose settled ref is the new session id (never the bearer token)", wRow.length === 1 && wRow[0].brokerage_id === BRK_A && wRow[0].provider_ref === sess[0].id && !JSON.stringify(wRow[0]).includes(String(sess[0].widget_session_token)), JSON.stringify(wRow))

  // ── H · rules over stripped source ─────────────────────────────────────────
  console.log("\n[H · rules over STRIPPED source — each with a positive control]")
  const code = (s: string) => blankStrings(stripComments(s))
  const isUseServer = (s: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(s)
  const APPLIERS = ["applyVendorSubscriptionEvent", "recordCeCompletionFromProvider"]
  const exportsApplier = (s: string) => APPLIERS.filter((n) => new RegExp(`export\\s+async\\s+function\\s+${n}\\b`).test(code(s)))
  const files: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(join(ROOT, d))) { const p = join(d, e); if (statSync(join(ROOT, p)).isDirectory()) { if (e !== "node_modules" && !e.startsWith(".")) walk(p) } else if (/\.tsx?$/.test(e)) files.push(p) } }
  walk("app"); walk("lib")
  const offenders = files.filter((f) => { const s = read(f); return isUseServer(s) && exportsApplier(s).length > 0 })
  ok(`no "use server" module exports a provider applier (${files.length} files scanned)`, offenders.length === 0, offenders.join(", "))
  ok("POSITIVE CONTROL: the pre-155R5 shape (a use-server file exporting the applier) is caught", isUseServer(`"use server"\nexport async function applyVendorSubscriptionEvent(input) {}`) && exportsApplier(`"use server"\nexport async function applyVendorSubscriptionEvent(input) {}`).length === 1)
  ok("CONTROL: a tombstone naming the applier is not an export", exportsApplier(`// TOMBSTONE: applyVendorSubscriptionEvent DELETED — export async function applyVendorSubscriptionEvent( moved`).length === 0)
  const sessionBeforeProvider = (s: string) => { const c = code(s); const at = c.indexOf("export async function listElevenLabsVoices"); const body = c.slice(at); const g = body.indexOf("auth.getUser"); const p = body.indexOf("listVoices("); return at >= 0 && g > 0 && p > g }
  ok("the voice catalog asks the session BEFORE it calls the provider", sessionBeforeProvider(read("app/actions/avatar-voice-catalog.ts")))
  ok("CONTROL: the pre-155R5 voice catalog (provider call, no session) fails that rule", !sessionBeforeProvider(`export async function listElevenLabsVoices() { const res = await listVoices(apiKey) }`))
  // THE RULE, not the waypoint (CLAUDE.md §2): the claim in the body is never what is stored. Lane 155R5 stored a contact verified
  // in the post's tenant; lane 155K2 then stored none at all (a same-tenant id can be guessed). Both satisfy the rule; a write of
  // the body's id, or any other read of it on the way to the row, does not.
  const verifiedContact = (s: string) => { const c = stripComments(s); return /viewer_contact_id:\s*(?:null|viewerContactId)\b/.test(c) && !/viewer_contact_id:\s*body\.contact_id/.test(c) }
  ok("track-share never stores the body's contact id — the viewer is null, or a contact verified in the post's tenant", verifiedContact(read("app/api/blog/track-share/route.ts")))
  ok("CONTROL: the pre-155R5 track-share (body.contact_id stored) fails that rule", !verifiedContact(`insert({ viewer_contact_id: body.contact_id ?? null })`))
  const callerCount = (s: string) => /currentViewCount\s*\+\s*1/.test(stripComments(s))
  ok("the landing-page counter never writes a caller-supplied number", !callerCount(read("app/actions/listing-landing.ts")))
  ok("CONTROL: the pre-155R5 counter (currentViewCount + 1) is caught", callerCount(`update({ view_count: currentViewCount + 1 })`))

  // ── I · lane 155R18: the public-door decision (cap, then the tenant's own opt-in) BEFORE any write ──────────────────────────
  // Each door is driven for real against the in-memory client (SIMULATED). The NEGATIVE writes nothing; the POSITIVE writes under
  // the tenant of the opt-in row (never a body field); the cap refuses before the opt-in read. Red at 81cdddae: the doors wrote
  // for a draft post, a closed session, an archived brokerage, a draft listing; the beacon billed what the visitor reported.
  console.log("\n[I · lane 155R18 — every public door decides (cap → tenant opt-in) before it writes]")
  await sectionI()

  // ── J · lane 155R20: six more doors decide before they write or spend ────────────────────────────────────────────────────
  // RED AT 76fa3d53: an anonymous caller filed brand-template audit rows onto ANOTHER tenant's template stamped with a user it
  // named; an anonymous caller read any tenant's lead readiness and filed rows under it; the two public routes had only a rate
  // limit (no decision) in front of the write / the spend.
  console.log("\n[J · lane 155R20 — brand-template audit, lead readiness, the mail opt-out and the platform live agent decide first]")
  await sectionJ()

  console.log(`\n${"─".repeat(60)}\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(" ❌ PUBLIC_DOOR_DECISION_FAIL"); process.exit(1) }
  console.log(" ✅ PUBLIC_DOOR_DECISION_PASS — public doors decide from the session / the tenant's own opt-in / the cap, provider callbacks leave one receipt per event, AI spend leaves a receipt beside the same cost row (SIMULATED)")
}

/** Section I (lane 155R18) — its own scope so its names never collide with A–H. */
async function sectionI(): Promise<void> {
  const prl = await import("../lib/security/public-rate-limit")
  {
    let reads = 0
    const optIn = async () => { reads++; return { brokerageId: BRK_A, basis: "specimen" } }
    const first = await prl.decidePublicDoor({ surface: "r18-unit", callerKey: "10.0.0.1", cap: { limit: 1, windowMs: 60_000 }, optIn })
    const second = await prl.decidePublicDoor({ surface: "r18-unit", callerKey: "10.0.0.1", cap: { limit: 1, windowMs: 60_000 }, optIn })
    ok("POSITIVE: an opted-in caller under the cap is allowed and carries the tenant the opt-in row proved", first.allowed === true && first.brokerageId === BRK_A)
    ok("NEGATIVE: over the cap → 429, and the opt-in read is NEVER reached (the cap is evaluated first)", second.allowed === false && second.status === 429 && reads === 1, JSON.stringify(second))
    const none = await prl.decidePublicDoor({ surface: "r18-unit-b", callerKey: "x", cap: { limit: 9, windowMs: 60_000 }, optIn: async () => null })
    const thrown = await prl.decidePublicDoor({ surface: "r18-unit-b", callerKey: "x", cap: { limit: 9, windowMs: 60_000 }, optIn: async () => { throw new Error("db down") } })
    const tenantless = await prl.decidePublicDoor({ surface: "r18-unit-b", callerKey: "x", cap: { limit: 9, windowMs: 60_000 }, optIn: async () => ({ brokerageId: null, basis: "a tenant door with no tenant" }) })
    const platform = await prl.decidePublicDoor({ surface: "r18-unit-b", callerKey: "x", cap: { limit: 9, windowMs: 60_000 }, optIn: async () => ({ brokerageId: null, basis: "platform funnel", platform: true }) })
    ok("NEGATIVE: no opt-in, a read that throws, and a tenant-less opt-in on a tenant door are all refused (fail closed, 404)", [none, thrown, tenantless].every((v) => v.allowed === false && v.status === 404))
    ok("POSITIVE: only the platform's own funnel passes without a tenant", platform.allowed === true && platform.brokerageId === null)
  }
  const POST_DRAFT = "d1000000-0000-4000-8000-000000000001", POST_PUB = "d1000000-0000-4000-8000-000000000002"
  const blogWorld = () => memSupabase({ blog_posts: [{ id: POST_DRAFT, brokerage_id: BRK_A, publish_status: "draft" }, { id: POST_PUB, brokerage_id: BRK_A, publish_status: "published" }], blog_post_views: [], blog_post_share_clicks: [] })
  const jpost = (url: string, body: unknown, ip: string) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } }) as never
  const tv = await import("../app/api/blog/track-view/route"), ts = await import("../app/api/blog/track-share/route")
  G.__R5.svc = blogWorld()
  const vDraft = await quiet(() => tv.POST(jpost("/api/blog/track-view", { blog_post_id: POST_DRAFT }, "10.1.0.1")))
  const sDraft = await quiet(() => ts.POST(jpost("/api/blog/track-share", { blog_post_id: POST_DRAFT, share_channel: "copy_link" }, "10.1.0.1")))
  ok("NEGATIVE: a DRAFT post takes no view and no share (404, zero rows)", vDraft.status === 404 && sDraft.status === 404 && writesTo(G.__R5.svc, "blog_post_views") === 0 && writesTo(G.__R5.svc, "blog_post_share_clicks") === 0)
  const vPub = await quiet(() => tv.POST(jpost("/api/blog/track-view", { blog_post_id: POST_PUB, brokerage_id: BRK_B }, "10.1.0.2")))
  const sPub = await quiet(() => ts.POST(jpost("/api/blog/track-share", { blog_post_id: POST_PUB, share_channel: "copy_link" }, "10.1.0.2")))
  const views = G.__R5.svc.tables.blog_post_views as Row[]
  ok("POSITIVE: a PUBLISHED post takes one view and one share, filed under the post's tenant (a body brokerage_id is ignored)", vPub.status === 200 && sPub.status === 200 && views.length === 1 && views[0].brokerage_id === BRK_A && (G.__R5.svc.tables.blog_post_share_clicks as Row[]).length === 1)
  for (let i = 0; i < 60; i++) await quiet(() => ts.POST(jpost("/api/blog/track-share", { blog_post_id: POST_PUB, share_channel: "copy_link" }, "10.1.0.3")))
  const sharesAtCap = (G.__R5.svc.tables.blog_post_share_clicks as Row[]).length
  const over = await quiet(() => ts.POST(jpost("/api/blog/track-share", { blog_post_id: POST_PUB, share_channel: "copy_link" }, "10.1.0.3")))
  ok("NEGATIVE: the 61st share from one connection inside the window → 429 and no row", over.status === 429 && (G.__R5.svc.tables.blog_post_share_clicks as Row[]).length === sharesAtCap)

  const SES_ACTIVE = "e1000000-0000-4000-8000-000000000001", SES_ENDED = "e1000000-0000-4000-8000-000000000002"
  const startedAt = new Date(Date.now() - 30_000).toISOString()
  G.__R5.svc = memSupabase({ live_agent_sessions: [
    { id: SES_ACTIVE, brokerage_id: BRK_A, agent_id: null, contact_id: null, surface: "widget", provider: "did", status: "active", started_at: startedAt, created_at: startedAt },
    { id: SES_ENDED, brokerage_id: BRK_A, agent_id: null, contact_id: null, surface: "widget", provider: "did", status: "ended", started_at: startedAt, created_at: startedAt },
  ], vendor_usage_tracking: [] })
  const se = await import("../app/api/embed/session/end/route"), hb = await import("../app/api/embed/session/heartbeat/route")
  const hbEnded = await quiet(() => hb.POST(jpost("/api/embed/session/heartbeat", { liveSessionId: SES_ENDED }, "10.2.0.1")))
  const endEnded = await quiet(() => se.POST(jpost("/api/embed/session/end", { liveSessionId: SES_ENDED, seconds: 600 }, "10.2.0.1")))
  ok("NEGATIVE: a closed session takes no heartbeat and bills nothing (zero writes)", hbEnded.status === 200 && (await endEnded.json()).minutesLogged === 0 && writesTo(G.__R5.svc, "live_agent_sessions") === 0 && writesTo(G.__R5.svc, "vendor_usage_tracking") === 0)
  const hbOk = await quiet(() => hb.POST(jpost("/api/embed/session/heartbeat", { liveSessionId: SES_ACTIVE }, "10.2.0.2")))
  ok("POSITIVE: the active session the widget minted takes its heartbeat (one stamp)", hbOk.status === 200 && writesTo(G.__R5.svc, "live_agent_sessions") === 1)
  const forged = await quiet(() => se.POST(jpost("/api/embed/session/end", { liveSessionId: SES_ACTIVE, seconds: 7200 }, "10.2.0.2")))
  const billed = Number((await forged.json()).minutesLogged)
  ok(`NEGATIVE (P0 money truth): a 30-second session reported as two hours bills only the elapsed time — ${billed} min (≤ 1.5), never 120`, billed > 0 && billed <= 1.5, String(billed))

  const VIS = "sess-r18-known"
  G.__R5.svc = memSupabase({ website_visitors: [{ id: "v1", session_id: VIS, brokerage_id: BRK_A, contact_id: null, lead_id: null }] })
  const dw = await import("../app/api/track/dwell/route")
  await quiet(() => dw.POST(jpost("/api/track/dwell", { sessionId: "sess-r18-unknown", pageUrl: "https://alpha.test/a", seconds: 40 }, "10.3.0.1")))
  ok("NEGATIVE: a dwell for a session the tenant's pixel never minted stamps nothing", writesTo(G.__R5.svc, "website_visitors") === 0)
  await quiet(() => dw.POST(jpost("/api/track/dwell", { sessionId: VIS, pageUrl: "https://alpha.test/a", seconds: 40 }, "10.3.0.2")))
  ok("POSITIVE: a dwell for the pixel's own session stamps that row", (G.__R5.svc.tables.website_visitors as Row[])[0].time_on_page_seconds === 40)

  const TOK_OK = "tok-r18-pending", TOK_OLD = "tok-r18-expired", CT = "c1000000-0000-4000-8000-000000000001"
  G.__R5.svc = memSupabase({
    buyer_intake_tokens: [
      { id: "t1", token: TOK_OK, brokerage_id: BRK_A, contact_id: CT, agent_user_id: null, status: "pending", expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      { id: "t2", token: TOK_OLD, brokerage_id: BRK_A, contact_id: CT, agent_user_id: null, status: "pending", expires_at: new Date(Date.now() - 86_400_000).toISOString() },
    ],
    contacts: [{ id: CT, brokerage_id: BRK_A }], documents: [], notifications: [],
  })
  const bi = await import("../app/api/workflow/buyer-intake/submit/route")
  const intake = (token: string, ip: string) => quiet(() => bi.POST(jpost("/api/workflow/buyer-intake/submit", { token, legalFirstName: "Pat", legalLastName: "Lee", dlImageBlobUrl: "docref://x" }, ip)))
  const bad = await intake("tok-r18-forged", "10.4.0.1")
  ok("NEGATIVE: a forged intake token → 404 and ZERO writes", bad.status === 404 && G.__R5.svc.writes.length === 0)
  const old = await intake(TOK_OLD, "10.4.0.2")
  ok("NEGATIVE: an expired token → 410, and its expiry stamp is the ONLY write (in the refusal branch, after the decision)", old.status === 410 && G.__R5.svc.writes.length === 1 && G.__R5.svc.writes[0].table === "buyer_intake_tokens")
  const good = await intake(TOK_OK, "10.4.0.3")
  ok("POSITIVE: a pending token updates the contact under the TOKEN's tenant", good.status === 200 && (G.__R5.svc.tables.contacts as Row[])[0].legal_first_name === "Pat")

  const L_DRAFT = "11000000-0000-4000-8000-000000000001", L_LIVE = "11000000-0000-4000-8000-000000000002"
  G.__R5.svc = memSupabase({ listings: [{ id: L_DRAFT, brokerage_id: BRK_A, status: "draft" }, { id: L_LIVE, brokerage_id: BRK_A, status: "active", address: "1 Main", city: "Pace", state: "FL" }], showing_requests: [], notifications: [] })
  const oas = await import("../app/actions/outside-agent-showing")
  const req = (listingId: string) => quiet(() => oas.submitOutsideAgentShowingRequest({ listingId, buyerAgentName: "Sam", buyerAgentEmail: "sam@example.test", buyerAgentPhone: "5550000000", preferredDate: "2030-01-02", preferredStartTime: "10:00" }))
  const rDraft = await req(L_DRAFT)
  ok("NEGATIVE: a showing request on a DRAFT listing is refused with zero rows", rDraft.success === false && writesTo(G.__R5.svc, "showing_requests") === 0)
  const rLive = await req(L_LIVE)
  ok("POSITIVE: a publicly visible listing takes the request under the listing's tenant", rLive.success === true && (G.__R5.svc.tables.showing_requests as Row[]).some((r) => r.brokerage_id === BRK_A), JSON.stringify(rLive))

  G.__R5.svc = memSupabase({ brokerages: [{ id: BRK_A, slug: "alpha", name: "Alpha", is_active: true, archived_at: null, deleted_at: null }, { id: BRK_B, slug: "beta", name: "Beta", is_active: true, archived_at: "2026-01-01T00:00:00Z", deleted_at: null }], agents: [], recruits: [], users: [], notifications: [] })
  const rec = await import("../app/recruiting/[brokerageSlug]/actions")
  const inq = (slug: string) => quiet(() => rec.submitRecruitInquiry({ brokerageSlug: slug, firstName: "Ann", lastName: "Doe", email: "ann@example.test" }))
  const archived = await inq("beta")
  ok("NEGATIVE: an ARCHIVED brokerage's recruiting page collects nothing", archived.success === false && writesTo(G.__R5.svc, "recruits") === 0)
  const live = await inq("alpha")
  ok("POSITIVE: a live brokerage's page files the recruit under its tenant", live.success === true && (G.__R5.svc.tables.recruits as Row[])[0]?.brokerage_id === BRK_A, JSON.stringify(live))

  const LP_DRAFT = "12000000-0000-4000-8000-000000000001", LP_PUB = "12000000-0000-4000-8000-000000000002"
  G.__R5.svc = memSupabase({ listing_landing_pages: [{ id: LP_DRAFT, brokerage_id: BRK_A, status: "draft", view_count: 5 }, { id: LP_PUB, brokerage_id: BRK_A, status: "published", view_count: 5 }] })
  const ll = await import("../app/actions/listing-landing")
  await quiet(() => ll.incrementLandingPageViews(LP_DRAFT, 999))
  await quiet(() => ll.incrementLandingPageViews(LP_PUB, 999))
  const lp = G.__R5.svc.tables.listing_landing_pages as Row[]
  ok("NEGATIVE + POSITIVE: a draft page's counter does not move; a published page's moves by exactly one from its OWN count", lp[0].view_count === 5 && lp[1].view_count === 6)

  G.__R5.svc = memSupabase({ collaborative_search_members: [], collaborative_searches: [] })
  const cs = await import("../app/actions/collaborative-search")
  const forgedLink = await quiet(() => cs.submitFamilyOpinionAction({ token: "x".repeat(40), sharedHomeId: "h1", vote: "love" }))
  ok("NEGATIVE: a forged collaborator token is refused with the resolver's own words and ZERO writes", forgedLink.ok === false && G.__R5.svc.writes.length === 0, JSON.stringify(forgedLink))

  // STRIPPED-SOURCE ORDER RULE: in every door this lane decided, the decision is called before the door's first write.
  const DOORS: Array<[string, string]> = [
    ["app/api/blog/track-share/route.ts", "POST"], ["app/api/blog/track-view/route.ts", "POST"], ["app/api/embed/session/end/route.ts", "POST"],
    ["app/api/embed/session/heartbeat/route.ts", "POST"], ["app/api/open-house/register/route.ts", "POST"], ["app/api/track/dwell/route.ts", "POST"],
    ["app/api/track/identify/route.ts", "POST"], ["app/api/workflow/buyer-intake/submit/route.ts", "POST"], ["app/api/workflow/buyer-intake/upload/route.ts", "POST"],
    ["app/actions/listing-landing.ts", "incrementLandingPageViews"], ["app/actions/outside-agent-showing.ts", "submitOutsideAgentShowingRequest"],
    ["app/actions/superadmin/platform-growth.ts", "capturePlatformProspectAction"], ["app/actions/superadmin/platform-growth.ts", "requestPlatformDemoAction"],
    ["app/recruiting/[brokerageSlug]/actions.ts", "submitRecruitInquiry"], ["app/actions/collaborative-search.ts", "acceptInvitation"], ["app/actions/collaborative-search.ts", "submitFamilyOpinionAction"],
  ]
  const WRITE_TOKEN = /\.(?:insert|upsert|update|delete|upload)\s*\(|\b(?:sentinelWrite|registerForEvent|endLiveAgentSession|heartbeatLiveAgentSession|upsertPlatformProspect|collaboratorView|recordCollaboratorOpinion|processKernelEvent)\s*\(/
  const DECIDES = /\b(?:decidePublicDoor|collaboratorDoor|platformFunnelDoor)\s*\(/
  const decidesFirst = (src: string, fn: string): boolean => {
    const c = blankStrings(stripComments(src))
    const at = c.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`)); if (at < 0) return false
    const next = c.slice(at + 10).search(/\nexport\s/); const body = c.slice(at, next < 0 ? c.length : at + 10 + next)
    const d = body.search(DECIDES), w = body.search(WRITE_TOKEN)
    return d >= 0 && (w < 0 || d < w)
  }
  const undecided = DOORS.filter(([f, fn]) => !decidesFirst(read(f), fn)).map(([f, fn]) => `${f}#${fn}`)
  ok(`every door this lane decided calls the decision before its first write (${DOORS.length - undecided.length}/${DOORS.length})`, undecided.length === 0, undecided.join(", "))
  ok("POSITIVE CONTROL: a door that writes BEFORE it decides is caught", !decidesFirst(`export async function POST() { await svc.from("x").insert({}); await decidePublicDoor({}) }`, "POST"))
  ok("POSITIVE CONTROL: a door with no decision at all is caught", !decidesFirst(`export async function POST() { await svc.from("x").insert({}) }`, "POST"))
  ok("CONTROL: a decision named only in a comment is not a decision", !decidesFirst(`export async function POST() { // decidePublicDoor(\n await svc.from("x").insert({}) }`, "POST"))
}

/** Section J (lane 155R20) — counted reads, the real doors, SIMULATED. */
async function sectionJ(): Promise<void> {
  const counted = (mem: MemClient) => {
    const reads: string[] = []
    const proxy = new Proxy(mem, { get(t, k, r) { if (k === "from") return (tbl: string) => { reads.push(tbl); return t.from(tbl) }; return Reflect.get(t, k, r) } }) as MemClient
    return { proxy, reads }
  }
  const jpost = (url: string, body: unknown, ip: string) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } }) as never

  // J1 — the brand-template audit write: compute stays open, the WRITE needs the session tenant that owns the template.
  const TPL_A = "13000000-0000-4000-8000-000000000001", TPL_B = "13000000-0000-4000-8000-000000000002", EVIL = "e0000000-0000-4000-8000-0000000000e1"
  const bt = await import("../app/actions/brand-template-registry")
  const meta = { content_type: "email", channel_intent: "email", is_from_template: true, template_source: "brokerage" } as never
  const tplWorld = () => memSupabase({ brand_templates: [{ id: TPL_A, brokerage_id: BRK_A }, { id: TPL_B, brokerage_id: BRK_B }], activities: [], agent_action_ledger: [] })
  G.__R5.svc = tplWorld(); G.__R5.ctx = agentCtx(null, false)
  const anonCompute = await quiet(() => bt.classifyTemplateAction(meta))
  ok("J1 POSITIVE: the pure classification still answers an anonymous caller (no write, no login wall on compute)", anonCompute.success === true && writesTo(G.__R5.svc, "activities") === 0)
  const anonLog = await quiet(() => bt.classifyTemplateAction(meta, { contentId: TPL_A, logActivity: true, userId: EVIL }))
  ok("J1 NEGATIVE: an anonymous caller asking to LOG is refused — zero activities rows, zero receipts", anonLog.success === false && writesTo(G.__R5.svc, "activities") === 0 && ledger(G.__R5.svc).length === 0, JSON.stringify(anonLog))
  G.__R5.ctx = agentCtx(BRK_A)
  const foreign = await quiet(() => bt.validateBrandComplianceAction({ raw_content: "x" }, { required_elements: [], optional_elements: [], channel_specific_notes: [], legal_disclaimers: [], generated_at: "" } as never, { contentId: TPL_B, logActivity: true }))
  ok("J1 NEGATIVE: a signed-in seat of tenant A cannot file an audit row onto tenant B's template", foreign.success === false && writesTo(G.__R5.svc, "activities") === 0, JSON.stringify(foreign))
  const own = await quiet(() => bt.classifyTemplateAction(meta, { contentId: TPL_A, logActivity: true, userId: EVIL }))
  const acts = G.__R5.svc.tables.activities as Row[]
  const rc = ledger(G.__R5.svc, "brand.template.classify")
  ok("J1 POSITIVE: the owning tenant's seat files ONE row under the template's tenant, stamped with the SESSION user (never the argument), and ONE receipt",
    own.success === true && acts.length === 1 && acts[0].brokerage_id === BRK_A && acts[0].agent_user_id === U_AGENT && rc.length === 1 && rc[0].status === "executed" && rc[0].actor_user_id === U_AGENT,
    JSON.stringify({ own, acts, rc: rc.map((r) => [r.status, r.actor_user_id]) }))

  // J2 — lead readiness: the lead desk's resolver, then the lead in scope, before any read of the lead's facts or any write.
  const LEAD_A = "14000000-0000-4000-8000-000000000001", LEAD_B = "14000000-0000-4000-8000-000000000002", U_BROKER = "a0000000-0000-4000-8000-0000000000b1"
  const er = await import("../app/actions/lead-readiness/evaluate-readiness")
  const leadWorld = () => memSupabase({
    users: [{ id: U_BROKER, brokerage_id: BRK_A, user_type: "broker", platform_role: null }, { id: U_AGENT, brokerage_id: BRK_A, user_type: "agent", platform_role: null }],
    leads: [{ id: LEAD_A, brokerage_id: BRK_A, agent_id: null, lead_score: 80, lead_stage: "new", created_at: new Date().toISOString() }, { id: LEAD_B, brokerage_id: BRK_B, agent_id: null, lead_score: 90, lead_stage: "new", created_at: new Date().toISOString() }],
    activities: [], automation_errors: [], agent_action_ledger: [], user_role_assignments: [],
  })
  G.__R5.svc = leadWorld(); G.__R5.user = null
  const anonLead = await quiet(() => er.evaluateAndLogLeadReadiness(LEAD_A))
  ok("J2 NEGATIVE: an anonymous caller gets no evaluation and writes nothing (not even the crash-path anomaly row)", anonLead.evaluation === null && G.__R5.svc.writes.length === 0, JSON.stringify(anonLead))
  G.__R5.user = { id: U_AGENT }
  const agentLead = await quiet(() => er.evaluateAndLogLeadReadiness(LEAD_A))
  ok("J2 NEGATIVE: an AGENT (not on the lead desk — leads belong to the brokerage) is refused with zero writes", agentLead.evaluation === null && G.__R5.svc.writes.length === 0, JSON.stringify(agentLead))
  G.__R5.user = { id: U_BROKER }
  const crossLead = await quiet(() => er.evaluateAndLogLeadReadiness(LEAD_B))
  ok("J2 NEGATIVE: the broker of tenant A cannot read tenant B's lead (\"not found\", zero writes)", crossLead.evaluation === null && G.__R5.svc.writes.length === 0, JSON.stringify(crossLead))
  const ownLead = await quiet(() => er.evaluateAndLogLeadReadiness(LEAD_A))
  const lr = ledger(G.__R5.svc, "lead.readiness.evaluate")
  ok("J2 POSITIVE: the broker's own lead is evaluated and its log write leaves ONE receipt under the lead's tenant",
    ownLead.evaluation !== null && lr.length === 1 && lr[0].brokerage_id === BRK_A && lr[0].actor_user_id === U_BROKER, JSON.stringify({ e: ownLead.error, lr: lr.map((r) => [r.status, r.brokerage_id]) }))

  // J3 — the mail opt-out POST: cap first, then the row the printed code resolves to; an unreadable read stays a 503.
  const tokMod = await import("../lib/direct-mail/unsubscribe-token")
  const TOK = tokMod.normalizeMailUnsubToken("K7M2N-P4RQ8-TVWX")
  const REC = "15000000-0000-4000-8000-000000000001"
  const unsub = await import("../app/api/unsubscribe/token/route")
  const mailWorld = (refuse?: boolean) => memSupabase({ direct_mail_recipients: [{ id: REC, brokerage_id: BRK_A, campaign_id: null, lead_id: null, contact_id: null, first_name: "Pat", unsubscribed_at: null, unsubscribe_token: TOK }], contact_suppression_list: [], contact_consent_events: [] },
    refuse ? { refuse: { direct_mail_recipients: "permission denied for table direct_mail_recipients" } } : {})
  G.__R5.svc = mailWorld()
  const forgedTok = await quiet(() => unsub.POST(jpost("/api/unsubscribe/token", { token: "ZZZZZ-ZZZZZ-ZZZZ", request: "mail" }, "10.9.0.1")))
  ok("J3 NEGATIVE: an unknown code → 404 and ZERO writes", forgedTok.status === 404 && G.__R5.svc.writes.length === 0)
  G.__R5.svc = mailWorld(true)
  const down = await quiet(() => unsub.POST(jpost("/api/unsubscribe/token", { token: TOK, request: "mail" }, "10.9.0.2")))
  ok("J3 NEGATIVE: a refused read is OUR failure — 503, never \"invalid code\", zero writes", down.status === 503 && G.__R5.svc.writes.length === 0)
  // (this harness has no request headers for publicCallerIp, so every call shares ONE bucket — the positive runs before the cap
  // is spent, and the cap case then spends it.)
  G.__R5.svc = mailWorld()
  const real = await quiet(() => unsub.POST(jpost("/api/unsubscribe/token", { token: TOK, request: "mail" }, "10.9.0.4")))
  ok("J3 POSITIVE: the real printed code passes the decision and reaches the opt-out (not a 404 / 429)", real.status !== 404 && real.status !== 429 && G.__R5.svc.writes.length > 0, `status ${real.status}, writes ${G.__R5.svc.writes.map((w: any) => w.table).join(",")}`)
  const c3 = counted(mailWorld()); G.__R5.svc = c3.proxy
  for (let i = 0; i < 10; i++) await quiet(() => unsub.POST(jpost("/api/unsubscribe/token", { token: "ZZZZZ-ZZZZZ-ZZZZ", request: "mail" }, "10.9.0.3")))
  const before = c3.reads.length
  const capped = await quiet(() => unsub.POST(jpost("/api/unsubscribe/token", { token: TOK, request: "mail" }, "10.9.0.3")))
  ok("J3 NEGATIVE: past the cap → 429 and the recipient read is NEVER reached (the cap is first)", capped.status === 429 && c3.reads.length === before, `reads ${before} → ${c3.reads.length}`)

  // J4 — the platform live agent: cap first, then the platform's own showcase tenant, BEFORE any provider call.
  let fetches = 0
  const realFetch = G.fetch
  G.fetch = async () => { fetches++; return new Response("refused in test", { status: 503 }) }
  try {
    const la = await import("../app/api/platform/live-agent/session/route")
    const SHOW = "16000000-0000-4000-8000-000000000001"
    const c4 = counted(memSupabase({ brokerages: [], platform_settings: [] })); G.__R5.svc = c4.proxy
    const noShow = await quiet(() => la.POST(jpost("/api/platform/live-agent/session", { visitorId: "v-1" }, "10.8.0.1")))
    ok("J4 NEGATIVE: no seeded showcase tenant → 503 with the text fallback, ZERO provider calls", noShow.status === 503 && fetches === 0)
    G.__R5.svc = memSupabase({ brokerages: [{ id: SHOW, name: "Showcase", slug: "showcase", status: "active", is_demo: true, deleted_at: null, created_at: "2026-01-01T00:00:00Z" }], platform_settings: [], live_agent_sessions: [] })
    const passed = await quiet(() => la.POST(jpost("/api/platform/live-agent/session", { visitorId: "v-2" }, "10.8.0.2")))
    ok("J4 POSITIVE: with the showcase tenant seeded the decision ALLOWS and the route reaches the presenter step (an unconfigured presenter → 409, still no live session and no provider call)", passed.status === 409 && writesTo(G.__R5.svc, "live_agent_sessions") === 0 && fetches === 0, `status ${passed.status}, fetches ${fetches}`)
    G.__R5.svc = c4.proxy
    for (let i = 0; i < 9; i++) await quiet(() => la.POST(jpost("/api/platform/live-agent/session", { visitorId: "v-1" }, "10.8.0.1")))
    const r0 = c4.reads.length
    const over = await quiet(() => la.POST(jpost("/api/platform/live-agent/session", { visitorId: "v-1" }, "10.8.0.1")))
    ok("J4 NEGATIVE: past the cap → 429 and the showcase read is NEVER reached", over.status === 429 && c4.reads.length === r0 && fetches === 0, `reads ${r0} → ${c4.reads.length}`)
  } finally { G.fetch = realFetch }

  // J5 — the STRIPPED order rule for the six, with the same controls as section I.
  const WRITE_OR_SPEND = /\.(?:insert|upsert|update|delete)\s*\(|\b(?:applyMailUnsubscribe|ensurePlatformDIDAgent|issueClientKey|startLiveAgentSession|logTemplateClassification|logBrandRequirements|logBrandCompliance|logReadinessTransition|logReadinessAnomaly|evaluateLeadReadiness)\s*\(/
  const DECIDE = /\b(?:decidePublicDoor|logTemplateEvaluation|leadReadinessDoor)\s*\(/
  const firstIn = (src: string, fn: string): boolean => {
    const c = blankStrings(stripComments(src))
    const at = c.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`)); if (at < 0) return false
    const next = c.slice(at + 10).search(/\nexport\s/); const body = c.slice(at, next < 0 ? c.length : at + 10 + next)
    const d = body.search(DECIDE), w = body.search(WRITE_OR_SPEND)
    return d >= 0 && (w < 0 || d < w)
  }
  const SIX: Array<[string, string]> = [
    ["app/api/unsubscribe/token/route.ts", "POST"], ["app/api/platform/live-agent/session/route.ts", "POST"],
    ["app/actions/brand-template-registry.ts", "classifyTemplateAction"], ["app/actions/brand-template-registry.ts", "getBrandRequirementsAction"],
    ["app/actions/brand-template-registry.ts", "validateBrandComplianceAction"], ["app/actions/lead-readiness/evaluate-readiness.ts", "evaluateAndLogLeadReadiness"],
  ]
  const late = SIX.filter(([f, fn]) => !firstIn(read(f), fn)).map(([f, fn]) => `${f}#${fn}`)
  ok(`J5 every one of the six decides before its first write / spend (${SIX.length - late.length}/${SIX.length})`, late.length === 0, late.join(", "))
  ok("J5 POSITIVE CONTROL: the base shape of the lead-readiness door (evaluate + log, no decision) is caught", !firstIn(`export async function evaluateAndLogLeadReadiness(id) { const e = await evaluateLeadReadiness(id); await logReadinessTransition(id, e) }`, "evaluateAndLogLeadReadiness"))
  ok("J5 POSITIVE CONTROL: the base shape of the opt-out (rate limit only, then apply) is caught", !firstIn(`export async function POST(req) { checkPublicRateLimit("x", ip, L); await applyMailUnsubscribe({}) }`, "POST"))
}

main().catch((e) => { console.error(e); process.exit(1) })
