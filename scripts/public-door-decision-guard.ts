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
 *                            catalog asks the session before the provider; track-share stores only a verified contact; the
 *                            landing counter never writes a caller's number.
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
  const verifiedContact = (s: string) => { const c = stripComments(s); return /viewer_contact_id:\s*viewerContactId/.test(c) && !/viewer_contact_id:\s*body\.contact_id/.test(c) }
  ok("track-share stores only a contact verified in the post's tenant", verifiedContact(read("app/api/blog/track-share/route.ts")))
  ok("CONTROL: the pre-155R5 track-share (body.contact_id stored) fails that rule", !verifiedContact(`insert({ viewer_contact_id: body.contact_id ?? null })`))
  const callerCount = (s: string) => /currentViewCount\s*\+\s*1/.test(stripComments(s))
  ok("the landing-page counter never writes a caller-supplied number", !callerCount(read("app/actions/listing-landing.ts")))
  ok("CONTROL: the pre-155R5 counter (currentViewCount + 1) is caught", callerCount(`update({ view_count: currentViewCount + 1 })`))

  console.log(`\n${"─".repeat(60)}\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(" ❌ PUBLIC_DOOR_DECISION_FAIL"); process.exit(1) }
  console.log(" ✅ PUBLIC_DOOR_DECISION_PASS — public doors decide from the session / the tenant's own opt-in / the cap, provider callbacks leave one receipt per event, AI spend leaves a receipt beside the same cost row (SIMULATED)")
}

main().catch((e) => { console.error(e); process.exit(1) })
