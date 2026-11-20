/**
 * scripts/ledger-receipts-marketing1-guard.ts — wave 155, repair lane 155R13 (G12 list "marketing1").
 *
 * Owner (2026-11-19): "on os arbitration, finish 1,318 partial, 360 missing a link" → "add more lanes to get that
 * arbitration count down". G12 = a signed-in user's write that leaves NO action-ledger receipt. This list is the
 * marketing surface: content generation, podcasts, campaign sequences, screenshots, twin studio, social, blog, email
 * campaigns, direct-mail settings, neighbour notifications. Every mutating export on it now writes through the ONE
 * user-initiated-write helper, lib/kernel/action-ledger.ts ledgerSessionAction (lane 155B3) — never a second helper.
 *
 *   A  DRIVEN (one export per MODULE, against the in-memory client): exactly ONE agent_action_ledger row naming the
 *      SESSION user (actor_user_id), the SESSION tenant (brokerage_id), a three-segment action, the subject row and the
 *      risk class, settled `executed`; a refused write settles `failed` and the caller's value is unchanged; calling
 *      the SAME export twice writes TWO receipts and the write RUNS twice (the no-key rule — a person legitimately saves
 *      twice; a wrong idempotency key would turn the second save into a silent no-op). Negative: with NO session the
 *      export refuses and writes no receipt (a refusal is not an action).
 *   B  STATIC (stripped source — a tombstone is not a call site, CLAUDE.md §2): every export on the row list reaches
 *      ledgerSessionAction (or delegates to one that does — rescheduleSocialPost → updateSocialPost), every action name
 *      passed to it is three lowercase segments (the live CHECK refuses anything else, and the helper refuses a bad
 *      name BEFORE the action runs), the reason code is HUMAN_REQUESTED, the risk class is in the ToolRiskClass
 *      vocabulary, and NO wrap passes `cycle` / `idempotencyKey` (no export on this list is a once-only act).
 *   C  NO SECRET IN A RECEIPT: the stock-provider key export records the platform name, never the key.
 *
 * Positive controls: the static finder reports a planted export without the helper; the name check refuses a planted
 * two-segment name; the key check catches a planted `cycle:`; the driven harness sees a receipt when one is written
 * (the ledger row count moves from 0 → 1 inside the SAME run that later asserts 2 for the double call).
 *
 * RED AT THE BASE (e88c1baa): no export on this list called the helper — A finds 0 receipts for every module and B
 * reports all 94 wrapped exports missing.
 *
 * BLIND SPOTS (published): the session seams (getAgentContext, the act-as write seam, require-caller, policy-scope)
 * are STUBBED to a fixed session — this proof is about the receipt, not the gate (the gates have their own guards);
 * heavy collaborators of four exports are stubbed (chatgpt-campaign staging, the ads kernel command, Stripe — never
 * called live — and nothing else); the in-memory client models no CHECK, FK or uuid type, so the live table's refusals
 * (a malformed name, a non-uuid subject, an agents.id in actor_user_id) are asserted from source in B, not exercised.
 * Five superadmin screenshot rows have no tenant to record against (platform staff, brokerageId "platform") and three
 * tenant list exports are reads — both are excluded BY NAME below, with the reason, never silently.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n${t}`)

// ─── THE ROW LIST (S/b2/g12/marketing1-rows.json, 103 rows) ─────────────────────────────────────────────────────────
const ROWS: Record<string, string[]> = {
  "app/actions/lifetime-customers.ts": ["findReferralOpportunities", "generateTouchpoint", "scheduleTouchpoint"],
  "app/actions/marketing/image-library.ts": ["removeLibraryImageAction", "saveLibraryImageAction", "setStockProviderKeyAction"],
  "app/actions/chatgpt-ads.ts": ["stageChatgptCampaignAction"],
  "app/actions/vendor-billing.ts": ["createVendorSubscriptionCheckout"],
  "app/dashboard/campaigns/ads/ads-campaign-actions.ts": ["updateAdCampaignAction"],
  "app/actions/ai-content-generation.tsx": ["addSEOKeyword", "analyzeABTest", "createABTest", "createGeneratedContent", "generateContentPlan", "learnFromEdits", "recordContentTemplateUse", "saveContentTemplate", "saveDescriptionToListing", "trackContentPerformance", "trackContentUsage", "trackHashtagUsage", "updateABTestResults", "updateBrandVoiceProfile", "updateContentStatus"],
  "app/actions/podcast-generation.ts": ["createDistributionChannel", "createPodcastTemplate", "deletePodcastEpisode", "generatePodcastEpisodeDescription", "generatePodcastNewsletterTeaser", "generatePodcastSnippetSuggestions", "savePodcastShowSettings", "updateDistributionChannel", "updatePodcastTemplate", "uploadPodcastCoverArt"],
  "app/actions/campaign-sequences.ts": ["cancelEnrollment", "createCampaignSequence", "createSequenceStep", "deleteCampaignSequence", "enrollContactInSequence", "launchCampaignSequence", "saveSequenceSteps", "updateCampaignSequence", "updateSequenceStep"],
  "app/actions/marketing/tenant-screenshots.ts": ["captureEstimateComparisonAction", "captureEstimateStillAction", "captureTenantPublicPageStillAction", "composeEstimateComparisonAction", "confirmComparisonFigureAction", "listEstimateComparisonAction", "listTenantScreenshotStillsAction", "setTenantScreenshotUsesAction", "typeComparisonFigureAction"],
  "app/actions/twin-studio.ts": ["approveTwin", "createTwinDraft", "deleteTwin", "finalizeTwin", "rejectTwin", "setDefaultTwin", "setTwinStockVoice", "updateTwinDetails"],
  "app/actions/blog.ts": ["addSeoKeyword", "discoverKeywordsAI", "generateTopicIdeas", "saveBlogPost", "suggestSEOKeywords", "toggleKeywordActive"],
  "app/actions/social-media-automation.ts": ["approveSocialPost", "refreshPostEngagementFromSync", "rejectSocialPost", "rescheduleSocialPost", "trackPostPerformance", "updateSocialPost"],
  "app/actions/email-campaigns.ts": ["aiComposeEmail", "createEmailCampaign", "deleteEmailCampaign", "scheduleEmailCampaign", "updateEmailCampaign"],
  "app/actions/superadmin/screenshot-capture.ts": ["captureDemoStillAction", "capturePublicPropertyStillAction", "listDemoStillSurfacesAction", "listScreenshotStillsForUseAction", "setScreenshotUsesAction"],
  "app/actions/content-studio.ts": ["addCompetitor", "generateContentIdeas", "saveContentIdea", "scheduleContent"],
  "app/actions/direct-mail-settings.ts": ["addCompetitorToWatchlist", "removeCompetitorFromWatchlist", "retireSenderAddress", "setDefaultSenderAddress"],
  "app/actions/campaign-bundles.ts": ["deactivateCampaignBundle", "listCampaignBundles", "upsertCampaignBundle"],
  "app/actions/social-publishing.ts": ["createSocialPost", "disconnectSocialAccount", "generateSocialContent"],
  "app/actions/voice-avatar-settings.ts": ["updateMyAssistantAvatar", "updateMyProspectVoice", "updateMyVoicePreference"],
  "app/actions/direct-mail-variants-settings.ts": ["addCustomVariant", "setVariantActive"],
  "app/actions/neighbor-notifications.ts": ["grantSellerPermission", "launchNeighborNotification"],
}
/** Excluded BY NAME with the reason (never silently). */
const EXCLUDED: Record<string, string> = {
  "app/actions/superadmin/screenshot-capture.ts#captureDemoStillAction": "no tenant to record against (platform staff; brokerageId 'platform')",
  "app/actions/superadmin/screenshot-capture.ts#capturePublicPropertyStillAction": "no tenant to record against (platform staff)",
  "app/actions/superadmin/screenshot-capture.ts#setScreenshotUsesAction": "no tenant to record against (platform staff)",
  "app/actions/superadmin/screenshot-capture.ts#listDemoStillSurfacesAction": "read-only (returns the static registry)",
  "app/actions/superadmin/screenshot-capture.ts#listScreenshotStillsForUseAction": "read-only (listScreenshotStillsForUse selects)",
  "app/actions/marketing/tenant-screenshots.ts#listTenantScreenshotStillsAction": "read-only (listTenantScreenshotStills selects)",
  "app/actions/marketing/tenant-screenshots.ts#listEstimateComparisonAction": "read-only (listComparisonEvidence selects)",
  "app/actions/campaign-bundles.ts#listCampaignBundles": "read-only (campaign_bundles / items selects)",
}
/** Exports that reach the helper through ONE same-module export that is itself wrapped (one receipt, not two). */
const DELEGATES: Record<string, string> = { "app/actions/social-media-automation.ts#rescheduleSocialPost": "updateSocialPost" }
const RISK = new Set(["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"])
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

// ─── B · STATIC (stripped source) ───────────────────────────────────────────────────────────────────────────────────
/** The export's body (stripped of comments), from its `export async function` line to its column-0 close. */
function exportBody(src: string, fn: string): string | null {
  const s = stripComments(src)
  const m = new RegExp(`^export async function ${fn}\\b`, "m").exec(s)
  if (!m) return null
  // The body closes on a line that is exactly "}" — a destructured parameter's "}: {" is not it.
  const rest = s.slice(m.index)
  const close = rest.search(/\n\}[ \t]*(\r?\n|$)/)
  return close < 0 ? null : rest.slice(0, close + 2)
}
function reachesHelper(src: string, fn: string): boolean {
  const body = exportBody(src, fn)
  return !!body && /\bledgerSessionAction\s*(?:<[^()]*>)?\s*\(/.test(blankStrings(body))
}
/** Every ledgerSessionAction context literal in the file: its action name, reason, risk and whether it carries a key. */
function helperContexts(src: string): Array<{ action: string | null; reason: string | null; risk: string | null; keyed: boolean }> {
  const s = stripComments(src)
  const out: Array<{ action: string | null; reason: string | null; risk: string | null; keyed: boolean }> = []
  const re = /ledgerSessionAction\s*(?:<[^()]*>)?\(\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const head = s.slice(m.index, m.index + 900)
    const ends = [head.indexOf(", async () =>"), head.indexOf(", ledgered)"), head.indexOf(", run)")].filter((i) => i > 0)
    const lit = head.slice(0, ends.length ? Math.min(...ends) : 900)
    out.push({
      action: /action:\s*"([^"]*)"/.exec(lit)?.[1] ?? null,
      reason: /reasonCode:\s*"([^"]*)"/.exec(lit)?.[1] ?? null,
      risk: /riskClass:\s*"([^"]*)"/.exec(lit)?.[1] ?? null,
      keyed: /\b(cycle|idempotencyKey)\s*:/.test(lit),
    })
  }
  return out
}

section("B · every export on the row list reaches ledgerSessionAction (stripped source)")
{
  // Positive controls first — a finder that cannot see the defect reports a clean tree.
  const planted = `export async function plantedWrite() {\n  // TOMBSTONE: used to call ledgerSessionAction( — a comment is not a call site\n  const note = "ledgerSessionAction("\n  await svc.from("x").insert({})\n}\n`
  check("positive control: a planted export whose only 'call' is a comment / string is reported missing", !reachesHelper(planted, "plantedWrite"))
  check("positive control: a planted wrapped export is seen", reachesHelper(`export async function w() {\n  return ledgerSessionAction<Awaited<ReturnType<typeof w>>>({ action: "a.b.c" }, async () => 1)\n}\n`, "w"))
  const badName = helperContexts(`ledgerSessionAction({ brokerageId: b, action: "content.update", reasonCode: "HUMAN_REQUESTED", riskClass: "LOW_RISK_WRITE" }, run)`)
  check("positive control: the name check refuses a planted two-segment name", badName.length === 1 && !NAME_RE.test(badName[0].action ?? ""))
  const keyed = helperContexts(`ledgerSessionAction({ brokerageId: b, action: "a.b.c", cycle: \`x:\${id}\`, reasonCode: "HUMAN_REQUESTED", riskClass: "FINANCIAL" }, run)`)
  check("positive control: the key check catches a planted cycle", keyed.length === 1 && keyed[0].keyed)

  let total = 0, wrapped = 0, excluded = 0, delegated = 0
  const missing: string[] = []
  for (const [file, fns] of Object.entries(ROWS)) {
    const src = readFileSync(join(ROOT, file), "utf8")
    for (const fn of fns) {
      total++
      const id = `${file}#${fn}`
      if (EXCLUDED[id]) { excluded++; continue }
      if (DELEGATES[id]) {
        const body = exportBody(src, fn) ?? ""
        const ok = new RegExp(`\\b${DELEGATES[id]}\\s*\\(`).test(blankStrings(body)) && reachesHelper(src, DELEGATES[id])
        if (ok) delegated++; else missing.push(id)
        continue
      }
      if (reachesHelper(src, fn)) wrapped++; else missing.push(id)
    }
  }
  check(`row list is the 103 rows (${total})`, total === 103)
  check(`every non-excluded export reaches the helper — wrapped ${wrapped}, delegated ${delegated}, excluded by name ${excluded} (of ${total})`, missing.length === 0, missing.join(", "))

  const names: string[] = [], badNames: string[] = [], badReason: string[] = [], badRisk: string[] = [], keyedAt: string[] = []
  for (const file of Object.keys(ROWS)) {
    for (const c of helperContexts(readFileSync(join(ROOT, file), "utf8"))) {
      names.push(c.action ?? "?")
      if (!c.action || !NAME_RE.test(c.action)) badNames.push(`${file}: ${c.action}`)
      if (c.reason !== "HUMAN_REQUESTED") badReason.push(`${file}: ${c.action}`)
      if (!c.risk || !RISK.has(c.risk)) badRisk.push(`${file}: ${c.action}=${c.risk}`)
      if (c.keyed) keyedAt.push(`${file}: ${c.action}`)
    }
  }
  check(`every action name is domain.entity.action (${names.length} wraps)`, names.length >= 94 && badNames.length === 0, badNames.join(", "))
  check("every wrap names reasonCode HUMAN_REQUESTED (the live CHECK's closed list)", badReason.length === 0, badReason.join(", "))
  check("every wrap names a ToolRiskClass risk class", badRisk.length === 0, badRisk.join(", "))
  check("NO wrap passes cycle / idempotencyKey (no export on this list is a once-only act)", keyedAt.length === 0, keyedAt.join(", "))
  // Not unique by design: two doors doing ONE act share ONE name (§6) — content.seo_keyword.add is the agent-scoped and the
  // brokerage-scoped keyword add. A name used by MORE than two wraps would be a copy-paste slip.
  const counts = new Map<string, number>(); for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  check("no action name is reused by more than two doors (a copy-paste slip reads as one act)", [...counts.values()].every((k) => k <= 2), [...counts].filter(([, k]) => k > 2).map(([n]) => n).join(", "))
}

// ─── A · DRIVEN ─────────────────────────────────────────────────────────────────────────────────────────────────────
const TENANT = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
const AGENT = "33333333-3333-4333-8333-333333333333"
const SESSION: { userId: string | null } = { userId: USER }
let ACTIVE: MemClient = memSupabase({})
const counters = { stripe: 0, chatgptStage: 0, adsUpdate: 0 }

function withAuth(c: MemClient): MemClient {
  ;(c as any).auth = { getUser: async () => ({ data: { user: SESSION.userId ? { id: SESSION.userId, email: "agent@tenant.test" } : null }, error: null }) }
  return c
}
const agentCtx = () => SESSION.userId
  ? { userId: USER, agentId: AGENT, brokerageId: TENANT, teamId: null, userType: "broker", role: "broker", isAuthenticated: true }
  : { userId: "", agentId: null, brokerageId: null, teamId: null, userType: "", role: "", isAuthenticated: false }
const writeCtx = () => SESSION.userId
  ? { ok: true, userId: USER, agentId: AGENT, brokerageId: TENANT, userType: "broker", isImpersonating: false, impersonatorUserId: null, actorUserId: USER, db: ACTIVE }
  : { ok: false, error: "Unauthorized" }

/** The REAL module (loaded through the CJS path, where the supabase leaves are already stubbed) — a session-seam stub
 *  overrides ONLY the session resolvers and keeps every other export real (decideClaimedTenant, resolveCallerIdentity, …). */
const real = (rel: string): Record<string, unknown> => _require(join(ROOT, rel)) as Record<string, unknown>
const STUBS: Record<string, () => unknown> = {
  "@/lib/supabase/service": () => ({ createServiceClient: () => ACTIVE }),
  "@/lib/supabase/server": () => ({ createClient: async () => ACTIVE }),
  "next/cache": () => ({ revalidatePath: () => {}, revalidateTag: () => {} }),
  "@/lib/identity": () => ({ ...real("lib/identity/index.ts"), getAgentContext: async () => agentCtx() }),
  "@/lib/identity/get-agent-context": () => ({ ...real("lib/identity/get-agent-context.ts"), getAgentContext: async () => agentCtx() }),
  "@/lib/platform/acting-context": () => ({ ...real("lib/platform/acting-context.ts"), resolveWriteContextForTenant: async () => writeCtx(), resolveActingContext: async () => writeCtx(), resolveWriteContext: async () => writeCtx() }),
  "@/lib/auth/require-caller": () => ({
    ...real("lib/auth/require-caller.ts"),
    requireAdsActor: async () => SESSION.userId ? { actor: { userId: USER, brokerageId: TENANT } } : { error: "Not authenticated" },
    requireTenantAdminOrSoloOwner: async () => SESSION.userId ? { ok: true, userId: USER, brokerageId: TENANT } : { ok: false, error: "Unauthorized" },
    requireCallerTenant: async () => SESSION.userId ? { ok: true, userId: USER, brokerageId: TENANT, userType: "broker" } : { ok: false, error: "Unauthorized" },
    requireCaller: async () => SESSION.userId ? { ok: true, userId: USER, brokerageId: TENANT, userType: "broker" } : { ok: false, error: "Unauthorized" },
  }),
  "@/lib/identity/policy-scope": () => ({
    ...real("lib/identity/policy-scope.ts"),
    resolvePolicyScopeAccess: async () => SESSION.userId
      ? { canEditAgent: true, canEditTeam: false, canEditBrokerage: true, agentScopeId: AGENT, teamScopeIds: [], brokerageScopeId: TENANT, effectiveRole: "broker_admin" }
      : { canEditAgent: false, canEditTeam: false, canEditBrokerage: false, agentScopeId: null, teamScopeIds: [], brokerageScopeId: null, effectiveRole: "solo_agent" },
    buildScopeFilters: () => [],
  }),
  // Never a live provider: Stripe is a counting fake.
  "@/lib/stripe": () => ({ stripe: {
    customers: { create: async () => { counters.stripe++; return { id: "cus_fake" } } },
    checkout: { sessions: { create: async () => { counters.stripe++; return { url: "https://checkout.fake/session" } } } },
  } }),
  "@/lib/ads/chatgpt-campaign": () => ({
    stageChatgptCampaign: async (a: { listingId: string }) => { counters.chatgptStage++; return a.listingId === "refuse" ? { success: false, error: "listing not found" } : { success: true } },
    markChatgptCampaignLaunched: async () => ({ success: true }), importChatgptPerformance: async () => ({ success: true }), launchChatgptCampaignOnOpenai: async () => ({ dispatched: false, reason: "stub" }),
  }),
  "@/lib/kernel/ads": () => ({ updateAdCampaign: async (a: { campaignId: string }) => { counters.adsUpdate++; return a.campaignId === "44444444-4444-4444-8444-000000000000" ? { success: false, error: "Campaign not found" } : { success: true } } }),
}
{
  const isLeaf = (r: string) => r in STUBS ? r : /[\\/]lib[\\/]supabase[\\/]service(\.ts)?$/.test(r) ? "@/lib/supabase/service" : /[\\/]lib[\\/]supabase[\\/]server(\.ts)?$/.test(r) ? "@/lib/supabase/server" : null
  const nodeModule: any = _require("node:module")
  const realLoad = nodeModule._load
  const cache = new Map<string, unknown>()
  const stubOf = (k: string) => { if (!cache.has(k)) cache.set(k, STUBS[k]()); return cache.get(k) as Record<string, unknown> }
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    const k = isLeaf(request)
    if (k) return stubOf(k)
    if (request === "server-only" || /[\\/]node_modules[\\/]server-only[\\/]/.test(request)) return {}
    return realLoad.call(this, request, ...rest)
  }
  // The ESM path (an app module imported from this ESM script resolves its imports through the module hooks, not
  // Module._load): the SAME stubs, served as shim modules whose named exports are read from the one cache above.
  ;(globalThis as any).__R13_STUB__ = stubOf
  const SHIM = "vipre-r13-stub:"
  const shimSource = (k: string) => `const m = globalThis.__R13_STUB__(${JSON.stringify(k)}); export const { ${Object.keys(stubOf(k)).join(", ")} } = m; export default m;`
  const table = Object.fromEntries(Object.keys(STUBS).map((k) => [k, shimSource(k)]))
  const loader = `
const TABLE = ${JSON.stringify(table)}
const leaf = (u) => /[\\\\/]lib[\\\\/]supabase[\\\\/]service\\.ts$/.test(u) ? "@/lib/supabase/service" : /[\\\\/]lib[\\\\/]supabase[\\\\/]server\\.ts$/.test(u) ? "@/lib/supabase/server" : null
export async function resolve(specifier, context, next) {
  if (specifier in TABLE) return { shortCircuit: true, url: ${JSON.stringify(SHIM)} + encodeURIComponent(specifier) }
  if (specifier === "server-only") return { shortCircuit: true, url: ${JSON.stringify(SHIM)} + "server-only" }
  const r = await next(specifier, context)
  const l = leaf(r.url ?? "")
  return l ? { shortCircuit: true, url: ${JSON.stringify(SHIM)} + encodeURIComponent(l) } : r
}
export async function load(url, context, next) {
  if (url.startsWith(${JSON.stringify(SHIM)})) {
    const k = decodeURIComponent(url.slice(${SHIM.length}))
    return { shortCircuit: true, format: "module", source: k === "server-only" ? "export default {}" : TABLE[k] }
  }
  return next(url, context)
}`
  const { register } = await import("node:module")
  try { register(`data:text/javascript,${encodeURIComponent(loader)}`) } catch { /* hooks unavailable — the CJS patch above still holds */ }
}

const LEDGER = "agent_action_ledger"
function fresh(seed: Record<string, Row[]> = {}, refuse?: Record<string, string>): MemClient {
  ACTIVE = withAuth(memSupabase({ users: [{ id: USER, brokerage_id: TENANT, user_type: "broker", platform_role: null }], [LEDGER]: [], ...seed }, { refuse }))
  return ACTIVE
}
const receipts = () => (ACTIVE.tables[LEDGER] ?? []) as Row[]

interface Case { module: string; fn: string; action: string; subjectType: string; risk: string; table: string; seed: () => Record<string, Row[]>; call: (mod: any) => Promise<unknown>; refuse?: Record<string, string>; failCall?: (mod: any) => Promise<unknown>; counter?: keyof typeof counters; /** no explicit gate on the export (RLS only) — the no-session case asserts only "no receipt" */ noGate?: boolean }
const ID = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`
const threw = (x: unknown) => !!x && typeof x === "object" && "threw" in (x as object)
const isFail = (r: unknown) => !!r && typeof r === "object" && ((r as any).success === false || (r as any).ok === false || ((r as any).error && (r as any).success !== true))

const CASES: Case[] = [
  { module: "app/actions/lifetime-customers.ts", fn: "scheduleTouchpoint", action: "sphere.touchpoint.schedule", subjectType: "contact", risk: "LOW_RISK_WRITE", table: "scheduled_touchpoints", seed: () => ({}),
    call: (m) => m.scheduleTouchpoint({ contactId: ID(1), touchpointType: "check_in", scheduledFor: "2030-01-01T00:00:00Z" }), refuse: { scheduled_touchpoints: "permission denied" }, noGate: true },
  { module: "app/actions/marketing/image-library.ts", fn: "saveLibraryImageAction", action: "marketing.library_image.save", subjectType: "marketing_asset", risk: "LOW_RISK_WRITE", table: "marketing_assets", seed: () => ({}),
    call: (m) => m.saveLibraryImageAction({ name: "Front porch", url: "https://images.example/porch.jpg", scope: "brokerage", source: "upload" }), refuse: { marketing_assets: "permission denied" } },
  { module: "app/actions/chatgpt-ads.ts", fn: "stageChatgptCampaignAction", action: "ads.chatgpt_campaign.stage", subjectType: "listing", risk: "LOW_RISK_WRITE", table: "", counter: "chatgptStage", seed: () => ({}),
    call: (m) => m.stageChatgptCampaignAction({ listingId: ID(2) }), failCall: (m) => m.stageChatgptCampaignAction({ listingId: "refuse" }) },
  { module: "app/actions/vendor-billing.ts", fn: "createVendorSubscriptionCheckout", action: "billing.vendor_subscription.checkout", subjectType: "vendor_marketplace_profile", risk: "FINANCIAL", table: "vendor_marketplace_profiles", counter: "stripe",
    seed: () => ({ vendor_marketplace_profiles: [{ id: ID(3), user_id: USER, stripe_customer_id: "cus_existing", company_name: "Acme Title" }], brokerage_settings: [{ brokerage_id: TENANT, settings: { vendor_tier_pricing: { standard: 49 } } }] }),
    call: (m) => m.createVendorSubscriptionCheckout("standard"), failCall: (m) => m.createVendorSubscriptionCheckout("premium") /* no administered price → price_not_configured, nothing charged */ },
  { module: "app/dashboard/campaigns/ads/ads-campaign-actions.ts", fn: "updateAdCampaignAction", action: "ads.campaign.update", subjectType: "ad_campaign", risk: "FINANCIAL", table: "", counter: "adsUpdate", seed: () => ({}),
    call: (m) => m.updateAdCampaignAction(ID(4), { dailyBudget: 25 }), failCall: (m) => m.updateAdCampaignAction(ID(0), { dailyBudget: 25 }) },
  { module: "app/actions/ai-content-generation.tsx", fn: "saveContentTemplate", action: "content.template.create", subjectType: "content_template", risk: "LOW_RISK_WRITE", table: "content_templates", seed: () => ({}),
    call: (m) => m.saveContentTemplate({ templateName: "Just listed", contentType: "social", category: "listing", structure: {} }), refuse: { content_templates: "permission denied" } },
  { module: "app/actions/podcast-generation.ts", fn: "createPodcastTemplate", action: "podcast.template.create", subjectType: "agent", risk: "LOW_RISK_WRITE", table: "podcast_templates", seed: () => ({}),
    call: (m) => m.createPodcastTemplate({ name: "Market minute", templateType: "market_update" }), refuse: { podcast_templates: "permission denied" } },
  { module: "app/actions/campaign-sequences.ts", fn: "updateCampaignSequence", action: "campaign.sequence.update", subjectType: "campaign_sequence", risk: "LOW_RISK_WRITE", table: "campaign_sequences",
    seed: () => ({ campaign_sequences: [{ id: ID(5), brokerage_id: TENANT, name: "Seller nurture", is_active: false }] }),
    call: (m) => m.updateCampaignSequence(ID(5), { name: "Seller nurture v2" }), failCall: (m) => m.updateCampaignSequence(ID(6), { name: "x" }) /* not this tenant's */ },
  { module: "app/actions/marketing/tenant-screenshots.ts", fn: "setTenantScreenshotUsesAction", action: "marketing.screenshot_uses.set", subjectType: "marketing_asset", risk: "LOW_RISK_WRITE", table: "marketing_assets",
    seed: () => ({ marketing_assets: [{ id: ID(7), brokerage_id: TENANT, asset_type: "image", source_table: "screenshot_capture", metadata: { asset_kind: "screenshot", screenshot_subject: "general", uses: ["image_library"] } }] }),
    call: (m) => m.setTenantScreenshotUsesAction({ assetId: ID(7), uses: ["image_library"] }), failCall: (m) => m.setTenantScreenshotUsesAction({ assetId: ID(8), uses: ["image_library"] }) },
  { module: "app/actions/twin-studio.ts", fn: "updateTwinDetails", action: "avatar.twin.update", subjectType: "agent_avatar_asset", risk: "LOW_RISK_WRITE", table: "agent_avatar_assets",
    seed: () => ({ agent_avatar_assets: [{ id: ID(9), agent_id: AGENT, label: "Studio", status: "ready", approval_status: "approved" }] }),
    call: (m) => m.updateTwinDetails({ twinId: ID(9), label: "Studio 2" }), failCall: (m) => m.updateTwinDetails({ twinId: ID(10), label: "x" }) },
  { module: "app/actions/blog.ts", fn: "toggleKeywordActive", action: "content.seo_keyword.set_active", subjectType: "seo_keyword", risk: "LOW_RISK_WRITE", table: "seo_keywords",
    seed: () => ({ seo_keywords: [{ id: ID(11), brokerage_id: TENANT, keyword: "homes for sale", is_active: true }] }),
    call: (m) => m.toggleKeywordActive(ID(11), false), refuse: { seo_keywords: "permission denied" } },
  { module: "app/actions/social-media-automation.ts", fn: "rescheduleSocialPost", action: "social.post.update", subjectType: "social_post", risk: "LOW_RISK_WRITE", table: "social_posts",
    seed: () => ({ social_posts: [{ id: ID(12), brokerage_id: TENANT, status: "scheduled", user_id: USER }] }),
    call: (m) => m.rescheduleSocialPost(ID(12), USER, "2030-02-02T10:00:00Z"), refuse: { social_posts: "permission denied" } },
  { module: "app/actions/email-campaigns.ts", fn: "updateEmailCampaign", action: "email.campaign.update", subjectType: "email_campaign", risk: "LOW_RISK_WRITE", table: "email_campaigns",
    seed: () => ({ email_campaigns: [{ id: ID(13), brokerage_id: TENANT, status: "draft", campaign_name: "Spring" }] }),
    call: (m) => m.updateEmailCampaign(ID(13), USER, { campaignName: "Spring market" }), failCall: (m) => m.updateEmailCampaign(ID(14), USER, { campaignName: "x" }) },
  { module: "app/actions/content-studio.ts", fn: "addCompetitor", action: "content.competitor.add", subjectType: "brokerage", risk: "LOW_RISK_WRITE", table: "competitors", seed: () => ({}),
    call: (m) => m.addCompetitor("Rival Realty", "https://rival.example"), refuse: { competitors: "permission denied" } },
  { module: "app/actions/direct-mail-settings.ts", fn: "retireSenderAddress", action: "direct_mail.sender_address.retire", subjectType: "direct_mail_sender_address", risk: "LOW_RISK_WRITE", table: "direct_mail_sender_addresses",
    seed: () => ({ direct_mail_sender_addresses: [{ id: ID(15), brokerage_id: TENANT, status: "active", is_default: true }] }),
    call: (m) => m.retireSenderAddress(ID(15)), failCall: (m) => m.retireSenderAddress(ID(16)) },
  { module: "app/actions/direct-mail-variants-settings.ts", fn: "setVariantActive", action: "direct_mail.variant.set_active", subjectType: "direct_mail_variant", risk: "LOW_RISK_WRITE", table: "direct_mail_variants",
    seed: () => ({ direct_mail_variants: [{ id: ID(17), brokerage_id: TENANT, is_active: true }, { id: ID(18), brokerage_id: null, is_active: true }] }),
    call: (m) => m.setVariantActive({ variantId: ID(17), isActive: false }), failCall: (m) => m.setVariantActive({ variantId: ID(18), isActive: false }) /* platform-wide row */ },
  { module: "app/actions/campaign-bundles.ts", fn: "deactivateCampaignBundle", action: "campaign.bundle.deactivate", subjectType: "campaign_bundle", risk: "LOW_RISK_WRITE", table: "campaign_bundles",
    seed: () => ({ campaign_bundles: [{ id: ID(19), brokerage_id: TENANT, scope_type: "brokerage", scope_id: TENANT, is_active: true }] }),
    call: (m) => m.deactivateCampaignBundle(ID(19)), failCall: (m) => m.deactivateCampaignBundle(ID(20)) },
  { module: "app/actions/social-publishing.ts", fn: "disconnectSocialAccount", action: "social.account.disconnect", subjectType: "social_media_account", risk: "LOW_RISK_WRITE", table: "social_media_accounts",
    seed: () => ({ social_media_accounts: [{ id: ID(21), brokerage_id: TENANT, user_id: USER, is_active: true }] }), /* the live row carries its tenant (the OAuth route stamps it); the door now pins it — wave 155, lane 155R29 */
    call: (m) => m.disconnectSocialAccount(ID(21)), refuse: { social_media_accounts: "permission denied" } },
  { module: "app/actions/voice-avatar-settings.ts", fn: "updateMyVoicePreference", action: "voice.preference.update", subjectType: "user", risk: "LOW_RISK_WRITE", table: "agents",
    seed: () => ({ agents: [{ id: AGENT, user_id: USER, voice_preference: "clone" }] }),
    call: (m) => m.updateMyVoicePreference({ preference: "generic", assistantVoiceId: "voice-1" }), refuse: { agents: "permission denied" } },
  { module: "app/actions/neighbor-notifications.ts", fn: "grantSellerPermission", action: "neighbor.seller_permission.grant", subjectType: "neighbor_notification_campaign", risk: "LOW_RISK_WRITE", table: "neighbor_notification_campaigns",
    seed: () => ({ neighbor_notification_campaigns: [{ id: ID(22), brokerage_id: TENANT, status: "draft" }] }),
    call: (m) => m.grantSellerPermission({ campaignId: ID(22), sellerContactId: ID(23), brokerageId: TENANT }), failCall: (m) => m.grantSellerPermission({ campaignId: ID(24), sellerContactId: ID(23), brokerageId: TENANT }) },
]

const runs = (c: Case) => c.counter ? counters[c.counter] : ACTIVE.writes.filter((w) => w.table === c.table).length

section("A · one export per module, driven against the in-memory client")
const driven = new Set<string>()
for (const c of CASES) {
  let mod: any
  try { mod = await import(join(ROOT, c.module)) } catch (e) { check(`${c.module} loads`, false, (e as Error).message.slice(0, 200)); continue }
  const tag = `${c.module.replace(/^app\//, "")}#${c.fn}`
  // ONE receipt, every field.
  SESSION.userId = USER
  fresh(c.seed())
  let r: unknown
  try { r = await c.call(mod) } catch (e) { r = { threw: (e as Error).message } }
  const one = receipts()
  const row = one[0] ?? {}
  check(`${tag}: exactly one receipt (${one.length}) — executed, value unchanged (${String(JSON.stringify(r)).slice(0, 80)})`, one.length === 1 && row.status === "executed" && !isFail(r), JSON.stringify(row).slice(0, 300))
  check(`${tag}: receipt names the SESSION user, the SESSION tenant, ${c.action}, a ${c.subjectType} subject, ${c.risk}, HUMAN_REQUESTED`,
    row.actor_type === "user" && row.actor_user_id === USER && row.brokerage_id === TENANT && row.action === c.action && NAME_RE.test(String(row.action))
      && row.subject_type === c.subjectType && row.risk_class === c.risk && row.reason_code === "HUMAN_REQUESTED" && row.idempotency_key === null,
    JSON.stringify({ a: row.actor_user_id, b: row.brokerage_id, act: row.action, st: row.subject_type, rc: row.risk_class, reason: row.reason_code, key: row.idempotency_key }))
  // A refused write settles failed; the caller still gets its own failure value.
  fresh(c.seed(), c.refuse)
  let f: unknown
  try { f = await (c.failCall ?? c.call)(mod) } catch (e) { f = { threw: (e as Error).message } }
  const fr = receipts()
  check(`${tag}: a refused write settles failed (${fr.map((x) => x.status).join(",") || "none"}) and returns the export's own failure`, fr.length === 1 && fr[0].status === "failed" && (isFail(f) || threw(f)), String(JSON.stringify(f)).slice(0, 160))
  // The no-key rule: twice → two receipts, two runs.
  fresh(c.seed())
  const before = runs(c)
  try { await c.call(mod); await c.call(mod) } catch { /* the receipts below say what happened */ }
  const twice = receipts()
  check(`${tag}: called twice → TWO receipts and the write ran twice (no idempotency key)`, twice.length === 2 && twice.every((x) => x.status === "executed") && runs(c) - before >= 2,
    `receipts=${twice.length} runs=${runs(c) - before}`)
  // Negative: no session → refused, no receipt.
  SESSION.userId = null
  fresh(c.seed())
  let n: unknown
  try { n = await c.call(mod) } catch (e) { n = { threw: (e as Error).message } }
  check(`${tag}: no session → refused, NO receipt (a refusal is not an action)`, receipts().length === 0 && (c.noGate || isFail(n) || threw(n)))
  SESSION.userId = USER
  driven.add(c.module)
}
const wrappedModules = Object.keys(ROWS).filter((m) => ROWS[m].some((fn) => !EXCLUDED[`${m}#${fn}`]))
check(`every module with a wrapped export is driven (${driven.size} of ${wrappedModules.length})`, wrappedModules.every((m) => driven.has(m)), wrappedModules.filter((m) => !driven.has(m)).join(", "))

section("C · no secret in a receipt")
{
  const mod: any = await import(join(ROOT, "app/actions/marketing/image-library.ts"))
  fresh({})
  const key = "pexels-live-key-0123456789abcdef"
  let r: unknown
  try { r = await mod.setStockProviderKeyAction({ apiKey: key }) } catch (e) { r = { threw: (e as Error).message } }
  const rows = receipts()
  check(`setStockProviderKeyAction leaves one receipt (${rows.length}; ${String(JSON.stringify(r)).slice(0, 60)})`, rows.length === 1)
  check("…and the key appears nowhere in it (the platform name only)", rows.length === 1 && !JSON.stringify(rows[0]).includes(key) && (rows[0].detail as any)?.platform === "pexels")
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed) { console.log("❌ LEDGER_RECEIPTS_MARKETING1_FAIL"); process.exit(1) }
console.log("✅ LEDGER_RECEIPTS_MARKETING1_PASS — every marketing1 write leaves one receipt naming who, which tenant, what, on what and under which risk class; no key, so a second save runs")
