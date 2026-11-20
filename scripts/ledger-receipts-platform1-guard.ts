#!/usr/bin/env tsx
/**
 * scripts/ledger-receipts-platform1-guard.ts — WAVE 155 (repair lane 155R10, group G12 list "platform1").
 *
 * WHAT IT PROVES: a signed-in user's write on the PLATFORM list (credentials, provider connections, seats-adjacent settings,
 * vendor verification and vendor money, tenant webhooks, brand/team settings, the AI tools a user runs) leaves ONE receipt on
 * agent_action_ledger through the ONE session-write helper, `ledgerSessionAction` (lib/kernel/action-ledger.ts) — naming WHO
 * (the session user), WHICH TENANT (the session's), WHAT (a three-segment action), ON WHAT (the subject) and the risk class.
 *
 *   §A STATIC (stripped source — a tombstone or a string is never a call site, CLAUDE.md §2): every export on the row list
 *      that is not listed OPEN reaches `ledgerSessionAction(`; every OPEN row carries its reason and does NOT reach it (so the
 *      list cannot rot into a lie); every receipt context in these modules has a three-segment lowercase action, a risk class
 *      from the existing vocabulary, reasonCode HUMAN_REQUESTED, NO `cycle` / `idempotencyKey` (a key would turn a person's
 *      second save into a silent replay — none of these acts is once-only), and names no secret-bearing identifier.
 *      Positive controls: planted specimens (a call only inside a comment, only inside a string, a two-segment name, a key,
 *      a secret) must each be caught.
 *   §B DRIVEN (in-memory client, no network, no provider, no model): per MODULE one export runs for real with its imports
 *      replaced by counted stubs. Asserted: exactly one receipt (actor user, session tenant, action, subject, risk class,
 *      HUMAN_REQUESTED, status executed, no idempotency key); calling it TWICE writes TWO executed receipts (the no-key
 *      regression canary — a wrong key would replay the second call); a refused write settles the receipt `failed`.
 *
 * RED AT THE BASE (e88c1baa): none of these 27 modules called the helper — §A reports every wrapped row as not reaching it
 * and §B finds zero receipts. Run: `npm run test:ledger-receipts-platform1`.
 * BLIND SPOTS: §B drives ONE export per module (the others are proven by §A only); stubs stand in for every import of the
 * module under test except the ledger itself, so a defect inside a stubbed dependency is not this guard's to see.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { memSupabase, type Row, type MemClient } from "./in-memory-supabase"
import { blankComments, blankStrings } from "./strip-comments"
// The roster is written down ONCE (CLAUDE.md §4) — the stub below reads the Set, never a copied literal (test:admin-vocabulary).
import { TENANT_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"

const ROOT = process.env.R10_ROOT || process.cwd()
let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
  return ok
}

// ══ THE ROW LIST (102 rows) — WRAPPED unless named in OPEN with its reason ══════════════════════════════════════════════
const ROWS: Record<string, string[]> = {
  "app/actions/vendor-payments.ts": ["completeStripeConnectOnboarding", "createVendorInvoice", "initiateStripeConnectOnboarding", "markInvoicePaid", "markVendorChargePaid"],
  "app/actions/connections/connection-center.ts": ["connectApiKeyProvider", "disconnectProvider", "getConnectionCenter", "startStripeConnect"],
  "app/actions/tenant-webhooks.ts": ["createWebhookSubscription", "deleteWebhookSubscription", "updateWebhookSubscription"],
  "app/actions/crm-connect.ts": ["connectCrmAction", "disconnectCrmAction"],
  "app/actions/onboarding/tech-stack.ts": ["deleteCredentials", "saveCredentials"],
  "app/actions/phone-connect.ts": ["connectPhoneAction", "disconnectPhoneAction"],
  "app/actions/push-subscriptions.ts": ["subscribePush", "unsubscribePush"],
  "app/actions/vendor-premium-placement.ts": ["markPlacementPaidAction", "offerPremiumPlacementAction"],
  "app/actions/vendors/vendor-plan-subscriptions.ts": ["endVendorPackageEnrolmentAction", "enrolVendorInPackageAction"],
  "app/actions/vendor-verification.ts": ["approveVendor", "recordVendorInsuranceAction", "rejectVendor", "requestVendorInfo", "setVendorComplianceCredential", "submitVendorForVerification"],
  "app/actions/calculators.ts": ["calculateAffordability", "calculateHomeValue", "calculateRentVsBuy", "saveCalculation"],
  "app/actions/team-branding.ts": ["saveTeamBranding", "saveTeamRevenueGoal", "saveTeamSignature", "saveTeamSplits"],
  "app/actions/credit-copilot.ts": ["createCreditAccount", "referToCreditPartner", "updateContactCreditStatus"],
  "app/actions/user-profile.ts": ["saveAgentEmailSignature", "updateMyAgentIdentity", "updateMyProfile"],
  "app/actions/phone-provisioning.ts": ["searchBrokerageNumbersAction", "updateBrokeragePhoneSettings"],
  "app/actions/settings/integrations.ts": ["togglePlatformCredential", "upsertProviderOverride"],
  "app/actions/admin/subscription-agreement.ts": ["signSubscriptionAgreementAction"],
  "app/actions/brief-audio.ts": ["generateBriefAudio"],
  "app/actions/phone-port-in.ts": ["checkPortabilityAction"],
  "app/actions/superadmin/number-provisioning.ts": ["searchNumbersForTenant"],
  "app/actions/superadmin/subscription-contracts.ts": ["listSubscriptionContractTemplatesAction"],
  "app/actions/voice-tenancy.ts": ["setTwilioByoCredsAction"],
  "app/api/admin/billing/subscriptions/[brokerageId]/route.ts": ["POST"],
  "app/actions/ai-predictions.ts": ["aiNegotiationAdvisor", "aiPropertyMatchGenius", "analyzeConversation", "batchPredictLeadConversions", "detectClientChurn", "enableAIPilot", "findHiddenOpportunities", "findMarketArbitrage", "massGenerateCMAs", "mineSphereOfInfluence", "predictDealCloseProbability", "predictLeadConversion", "predictMarketShift", "predictWinningOffer", "refreshStalePredictions", "toggleAutoPilot"],
  "app/actions/services-config.ts": ["createAIAgentTemplate", "createPlaybook", "createStageRule", "deleteStageRule", "toggleAIAgentTemplate", "togglePlaybook"],
  "app/actions/onboarding/brand.ts": ["saveBrandColors", "saveBrandTypography", "saveBrandVoice", "saveTemplate", "uploadLogo"],
  "app/actions/vendors/vendor-plans.ts": ["createVendorPlanAction", "deleteVendorPlanAction", "setDefaultVendorPlanAction", "setVendorPlanStatusAction", "updateVendorPlanAction"],
  "app/actions/ai-calendar-management.ts": ["blockCalendarTime", "generateWeeklyPlan", "prepareMeetingBrief", "scheduleSmartFollowUps"],
  "app/actions/knowledge/search.ts": ["createKnowledgeArticle", "deleteHelpTopic", "deleteKnowledgeArticle", "updateKnowledgeArticle"],
  "app/actions/voice-assistant.ts": ["endVoiceSession", "getVoiceConfig", "startVoiceSession", "updateVoiceConfig"],
  "app/actions/admin/locations.ts": ["createLocationAction", "deleteLocationAction", "updateLocationAction"],
}
/** Rows deliberately NOT wrapped — each with the evidence-backed reason (re-classification proposals for the integrator).
 *  FOUR ROWS LEFT THIS LIST (wave 155, lane 155R15 — held as wrapped rows in scripts/ledger-receipts-late-guard.ts, and as wrapped
 *  rows here now): the three carrier lookups (searchBrokerageNumbersAction, checkPortabilityAction, searchNumbersForTenant — a
 *  lookup can provision a carrier subaccount, so it is receipted) and the platform-staff subscriptions route (receipted against the
 *  brokerage it changes, after the staff gate). Their entries here asserted "does not reach the helper" — true only until the
 *  work finished (CLAUDE.md §2: an assertion pinned to a waypoint). */
const OPEN: Record<string, string> = {
  "app/actions/connections/connection-center.ts#getConnectionCenter": "READ-ONLY: only selects (isProviderConnected reads platform_credentials / agent_api_credentials / social_media_accounts)",
  // WAVE 155 (lane 155R23): calculateAffordability / calculateRentVsBuy (a SIGNED-IN caller's usage row; an anonymous visitor
  // has no tenant and stays unrecorded) and getVoiceConfig (the once-per-agent SEED insert only — a view that finds its row
  // records nothing) now carry their receipt in their own span, so they left OPEN and are judged as wrapped rows.
  "app/actions/superadmin/subscription-contracts.ts#listSubscriptionContractTemplatesAction": "READ-ONLY + platform staff: lists templates and signature counts",
  "app/actions/ai-predictions.ts#batchPredictLeadConversions": "FAN-OUT: no write of its own; each lead runs through predictLeadConversion, which leaves the receipt",
  "app/actions/ai-predictions.ts#refreshStalePredictions": "FAN-OUT: no write of its own; re-runs predictLeadConversion per stale lead, which leaves the receipt",
}
const RISK = new Set(["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"]) // lib/ai-isa/persona-tool-policy.ts ToolRiskClass
const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/ // the live CHECK (m687)
const SECRET_RE = /\b(apiKey|api_key|authToken|auth_token|accountSid|secret|password|params\.fields|credentials|accessToken|access_token)\b/

// ══ §A STATIC ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
function exportSpan(src: string, name: string): string | null {
  const lines = src.split("\n")
  const s = lines.findIndex((l) => new RegExp(`^export async function ${name}\\b`).test(l))
  if (s < 0) return null
  let e = s + 1
  while (e < lines.length && lines[e].trimEnd() !== "}") e++
  return lines.slice(s, e + 1).join("\n")
}
const reaches = (code: string, name: string): boolean => /\bledgerSessionAction\s*\(/.test(exportSpan(code, name) ?? "")
/** Every receipt context object in a module: the text from `ledgerSessionAction(` up to the run argument. */
function receiptContexts(commentFree: string): string[] {
  const out: string[] = []
  const re = /\bledgerSessionAction\s*\(\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(commentFree))) {
    const rest = commentFree.slice(m.index)
    const end = rest.search(/\}\s*,\s*(async\b|ledgered\b)/)
    out.push(end > 0 ? rest.slice(0, end + 1) : rest.slice(0, 600))
  }
  return out
}
function contextFindings(ctx: string): string[] {
  const f: string[] = []
  const action = /\baction:\s*"([^"]*)"/.exec(ctx)?.[1]
  if (!action || !ACTION_RE.test(action)) f.push(`action ${JSON.stringify(action ?? null)} is not domain.entity.action`)
  const risk = /\briskClass:\s*"([^"]*)"/.exec(ctx)?.[1]
  if (!risk || !RISK.has(risk)) f.push(`riskClass ${JSON.stringify(risk ?? null)} outside the vocabulary`)
  if (!/\breasonCode:\s*"HUMAN_REQUESTED"/.test(ctx)) f.push("reasonCode is not HUMAN_REQUESTED")
  if (/\b(cycle|idempotencyKey)\s*:/.test(ctx)) f.push("carries cycle / idempotencyKey (a second save would replay)")
  if (!/\bactor:\s*\{\s*type:\s*"user"/.test(ctx)) f.push("actor is not a session user")
  if (SECRET_RE.test(ctx)) f.push(`names a secret-bearing identifier (${SECRET_RE.exec(ctx)![1]})`)
  return f
}
function staticSection(): void {
  console.log("\n§A — every wrapped row reaches the ONE helper; every receipt context is well-formed (stripped source)")
  let rows = 0, wrapped = 0, open = 0, contexts = 0
  for (const [file, names] of Object.entries(ROWS)) {
    const raw = readFileSync(join(ROOT, file), "utf8")
    const commentFree = blankComments(raw)
    const code = blankStrings(commentFree)
    for (const n of names) {
      rows++
      const key = `${file}#${n}`
      if (OPEN[key]) {
        open++
        if (file.endsWith("route.ts")) { check(`${key} OPEN — ${OPEN[key].split(":")[0]}`, !/\bledgerSessionAction\s*\(/.test(code)); continue }
        check(`${key} OPEN — ${OPEN[key].split(":")[0]} (does not reach the helper)`, exportSpan(code, n) !== null && !reaches(code, n))
        continue
      }
      wrapped++
      check(`${key} reaches ledgerSessionAction`, reaches(code, n), exportSpan(code, n) ? "no call in the export span" : "export not found")
    }
    for (const ctx of receiptContexts(commentFree)) {
      contexts++
      const f = contextFindings(ctx)
      if (f.length) check(`${file}: receipt context well-formed`, false, f.join("; ") + ` — ${ctx.slice(0, 140)}`)
    }
  }
  check(`row list complete: ${rows} rows = ${wrapped} wrapped + ${open} open`, rows === 102 && wrapped + open === rows)
  check(`${contexts} receipt contexts scanned, all well-formed`, contexts >= wrapped && failures.every((x) => !x.includes("receipt context")))
  // POSITIVE CONTROLS — each planted defect must be caught by the very functions above.
  const specimen = [
    "export async function inComment() {", "  // ledgerSessionAction({ action: \"a.b.c\" })", "  return 1", "}",
    "export async function inString() {", "  const s = \"ledgerSessionAction(\"", "  return s", "}",
  ].join("\n")
  const sc = blankStrings(blankComments(specimen))
  check("positive control: a call that exists only in a COMMENT does not count", !reaches(sc, "inComment"))
  check("positive control: a call that exists only in a STRING does not count", !reaches(sc, "inString"))
  const bad = (s: string) => contextFindings(`ledgerSessionAction({ brokerageId: b, action: "a.b.c", actor: { type: "user", userId: u }, subject: { type: "x", id: i }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED"${s} }`)
  check("positive control: a well-formed context passes", bad("").length === 0)
  check("positive control: a `cycle` is caught", bad(", cycle: `x:${1}`").some((x) => x.includes("cycle")))
  check("positive control: an `idempotencyKey` is caught", bad(", idempotencyKey: k").some((x) => x.includes("idempotencyKey")))
  check("positive control: a secret in detail is caught", bad(", detail: { t: params.authToken }").some((x) => x.includes("secret")))
  check("positive control: a two-segment action is caught", contextFindings(`{ action: "vendor.create", actor: { type: "user" }, riskClass: "FINANCIAL", reasonCode: "HUMAN_REQUESTED" }`).some((x) => x.includes("domain.entity.action")))
  check("positive control: a risk class outside the vocabulary is caught", contextFindings(`{ action: "a.b.c", actor: { type: "user" }, riskClass: "SECURITY", reasonCode: "HUMAN_REQUESTED" }`).some((x) => x.includes("vocabulary")))
}

// ══ §B DRIVEN — module interception (imports of the module under test → counted stubs; the ledger itself is REAL) ════════
const U = randomUUID(), B = randomUUID(), A = randomUUID(), V = randomUUID(), T = randomUUID(), X = randomUUID(), C = randomUUID()
const R: { db: MemClient; fail: boolean; calls: Record<string, number> } = { db: memSupabase({}), fail: false, calls: {} }
const count = (k: string) => { R.calls[k] = (R.calls[k] ?? 0) + 1 }
const acting = () => ({ ok: true, userId: U, actorUserId: U, agentId: A, brokerageId: B, userType: "broker", isImpersonating: false, impersonatorUserId: null, readOnly: false, db: R.db })
const agentCtx = () => ({ isAuthenticated: true, userId: U, brokerageId: B, agentId: A, userType: "broker", role: "broker" })
function realDecideClaimedTenant(input: { actingBrokerageId: string | null | undefined; claimedBrokerageId?: string | null }) {
  const actingTenant = input.actingBrokerageId
  if (!actingTenant) return { ok: false as const, reason: "no_session_tenant" as const }
  if (input.claimedBrokerageId && input.claimedBrokerageId !== actingTenant) return { ok: false as const, reason: "tenant_mismatch" as const }
  return { ok: true as const, brokerageId: actingTenant }
}
/** The session's own agents.id is A; any other target must be an agents row of the session tenant, and the seat a roster seat. */
async function realAuthorizeForAgent(targetAgentId?: string | null) {
  const s = agentCtx()
  const target = targetAgentId || s.agentId
  if (!target) return { ok: false as const, error: "No agent profile for this user yet — finish account setup." }
  const base = { userId: s.userId, brokerageId: s.brokerageId, userType: s.userType }
  if (target === s.agentId) return { ok: true as const, agentId: target, isSelf: true, ...base }
  if (!TENANT_ADMIN_USER_TYPES.has(s.userType)) return { ok: false as const, error: "Forbidden: that agent is not you" }
  const { data: row, error } = await R.db.from("agents").select("id").eq("id", target).eq("brokerage_id", s.brokerageId).maybeSingle()
  if (error) return { ok: false as const, error: "Could not verify that agent" }
  if (!row) return { ok: false as const, error: "Forbidden: that agent is not in your brokerage" }
  return { ok: true as const, agentId: target, isSelf: false, ...base }
}
/** Stubs shared by every module that imports the specifier (the session is ALWAYS the session's — never a body). */
const COMMON: Record<string, Record<string, unknown>> = {
  "@/lib/platform/acting-context": { resolveWriteContext: async () => acting(), resolveWriteContextForTenant: async () => acting(), resolveActingContext: async () => acting(), READ_ONLY_ACTING_ERROR: "read only", decideClaimedTenant: realDecideClaimedTenant },
  // THE REAL RULES, not always-yes stubs (a stub of a decision function that answers "ok" makes a negative pass for the wrong
  // reason). Both mirror their source line for line: lib/platform/acting-context.ts decideClaimedTenant, and
  // lib/auth/require-caller.ts authorizeForAgent (own agent, or a roster seat naming an agent of the SESSION's tenant).
  "@/lib/auth/require-caller": { authorizeForAgent: async (target?: string | null) => realAuthorizeForAgent(target) },
  "@/lib/identity": { getAgentContext: async () => agentCtx() },
  "@/lib/identity/get-agent-context": { getAgentContext: async () => agentCtx() },
  "@/lib/kernel/portal-auth": { requireVendorActor: async (v: string) => ({ userId: U, vendorId: v, brokerageId: B }) },
  "@/lib/auth/resolve-user-role": { isAdminOrBroker: () => true, isTenantCommerceAdmin: () => true, isBrokerageFinanceAdmin: () => true, resolveTenantAdmin: async () => ({ ok: true, isTenantAdmin: true }), isPlatformStaffIdentity: () => false },
  "@/lib/errors": { handleError: (e: any) => ({ success: false, error: e instanceof Error ? e.message : String(e?.message ?? e) }) },
  "@/lib/db/best-effort": { bestEffort: async (p: any) => { try { return await p } catch { return null } } },
  "@/lib/validations": { isValidUUID: (s: string) => /^[0-9a-f-]{36}$/i.test(s) },
  "@/lib/security/secret-crypto": { encryptSecret: (s: string) => `enc:${s.length}`, isEncryptionConfigured: () => true },
  "next/cache": { revalidatePath: () => {}, revalidateTag: () => {} },
  "next/headers": { headers: async () => new Map(), cookies: async () => ({ get() { return undefined }, getAll() { return [] } }) },
}
interface ModuleCase {
  file: string; fn: string; args: () => unknown[]; action: string; subject: [string, string | null]; risk: string
  seed?: () => Record<string, Row[]>; refuse?: string; flip?: boolean; throws?: boolean; stubs?: Record<string, Record<string, unknown>>
}
/** A read-only brand cascade stand-in: every property resolves (to another stand-in), never a value the proof asserts on. */
const deepNull = (): any => new Proxy({}, { get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : deepNull()) })
const users = () => [{ id: U, brokerage_id: B, user_type: "broker", role: "broker", email: "pat@example.test", platform_role: null, team_id: null }]
const CASES: ModuleCase[] = [
  { file: "app/actions/vendor-payments.ts", fn: "completeStripeConnectOnboarding", args: () => [V], action: "vendor.stripe_connect.complete", subject: ["vendor", V], risk: "FINANCIAL", flip: true,
    stubs: { "@/lib/connections/vendor-stripe": { readVendorStripeConnect: async () => (R.fail ? { accountId: null } : { accountId: "acct_test" }), setVendorStripeOnboarding: async () => ({}) },
             "@/lib/stripe": { stripe: { accounts: { retrieve: async () => { count("stripe.accounts.retrieve"); return { details_submitted: true, charges_enabled: true } } } } } } },
  { file: "app/actions/connections/connection-center.ts", fn: "disconnectProvider", args: () => [{ domain: "social", provider: "facebook" }], action: "platform.provider_connection.disconnect", subject: ["provider_connection", null], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users(), social_media_accounts: [] }), refuse: "social_media_accounts",
    stubs: { "@/lib/connections/field-spec": { connectionScopeForUserType: () => ({ scope: "agent", isBrokerageManager: false }) }, "@/lib/integrations/connection-manager": { canonicalProvider: (p: string) => p, aliasesFor: (p: string) => [p] } } },
  { file: "app/actions/tenant-webhooks.ts", fn: "deleteWebhookSubscription", args: () => [X], action: "webhook.subscription.delete", subject: ["tenant_webhook_subscription", X], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users(), tenant_webhook_subscriptions: [{ id: X, brokerage_id: B }] }), refuse: "tenant_webhook_subscriptions",
    stubs: { "@/lib/kernel/tenancy-principal": { isTenancyPrincipal: async () => true } } },
  { file: "app/actions/crm-connect.ts", fn: "disconnectCrmAction", args: () => ["lofty"], action: "platform.crm_connection.disconnect", subject: ["crm_connection", null], risk: "LOW_RISK_WRITE",
    seed: () => ({ integration_credentials: [], brokerage_integrations: [] }), refuse: "integration_credentials",
    stubs: { "@/lib/integrations/integration-status": { INTEGRATION_STATUS_CONNECTED: "connected", INTEGRATION_STATUS_NOT_CONFIGURED: "not_configured" } } },
  { file: "app/actions/onboarding/tech-stack.ts", fn: "deleteCredentials", args: () => ["follow_up_boss", B], action: "platform.provider_credential.delete", subject: ["provider_credential", null], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users(), platform_credentials: [], brokerage_integrations: [] }), refuse: "platform_credentials" },
  { file: "app/actions/phone-connect.ts", fn: "disconnectPhoneAction", args: () => ["twilio"], action: "platform.phone_connection.disconnect", subject: ["phone_connection", null], risk: "LOW_RISK_WRITE",
    seed: () => ({ platform_credentials: [] }), refuse: "platform_credentials" },
  { file: "app/actions/push-subscriptions.ts", fn: "unsubscribePush", args: () => [{ endpoint: "https://push.example.test/e" }], action: "platform.push_subscription.unsubscribe", subject: ["user", U], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users(), push_subscriptions: [] }), refuse: "push_subscriptions" },
  { file: "app/actions/vendor-premium-placement.ts", fn: "markPlacementPaidAction", args: () => [{ invoiceId: X, paymentMethod: "check" }], action: "vendor.premium_placement.mark_paid", subject: ["vendor_invoice", X], risk: "FINANCIAL", flip: true,
    stubs: { "@/lib/vendors/premium-placement": { markPlacementPaid: async () => { count("markPlacementPaid"); return R.fail ? { error: "refused" } : { placementUntil: "2027-01-01" } } } } },
  { file: "app/actions/vendors/vendor-plan-subscriptions.ts", fn: "endVendorPackageEnrolmentAction", args: () => [{ subscriptionId: X }], action: "vendor.package_enrolment.end", subject: ["vendor_subscription", X], risk: "FINANCIAL",
    seed: () => ({ vendor_subscriptions: [{ id: X, brokerage_id: B, status: "active" }] }), refuse: "vendor_subscriptions" },
  { file: "app/actions/vendor-verification.ts", fn: "requestVendorInfo", args: () => [V, ["w9"]], action: "vendor.verification.request_info", subject: ["vendor", V], risk: "LOW_RISK_WRITE", throws: true,
    seed: () => ({ users: users(), vendors: [{ id: V, brokerage_id: B, verification_flags: [] }] }), refuse: "vendors" },
  { file: "app/actions/calculators.ts", fn: "saveCalculation", args: () => [{ toolName: "seller_net_sheet", calculationData: { a: 1 }, visitorId: "visitor-1" }], action: "calculator.saved_calculation.create", subject: ["brokerage", B], risk: "LOW_RISK_WRITE",
    seed: () => ({ saved_calculations: [] }), refuse: "saved_calculations",
    stubs: { "@/lib/security/public-rate-limit": { publicCallerIp: async () => "203.0.113.9", checkPublicRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) } } },
  { file: "app/actions/team-branding.ts", fn: "saveTeamSignature", args: () => [{ teamId: null, signature: "Pat Broker" }], action: "team.signature.update", subject: ["team", T], risk: "LOW_RISK_WRITE",
    seed: () => ({ teams: [{ id: T, brokerage_id: B, branding_override: {} }] }), refuse: "teams",
    stubs: { "@/lib/kernel/resolve-user-team": { resolveLedTeamId: async () => ({ ok: true, teamId: T }) }, "@/lib/format/html": { escapeHtmlBasic: (s: string) => s }, "@/lib/branding/resolve-brand-context": { resolveBrandContext: async () => deepNull() } } },
  { file: "app/actions/credit-copilot.ts", fn: "referToCreditPartner", args: () => [{ contact_id: C, partner_id: X }], action: "credit.partner_referral.create", subject: ["contact", C], risk: "COMMUNICATION", flip: true, throws: true,
    seed: () => ({ users: users() }),
    stubs: { "@/lib/credit/credit-event-handlers": { recordCreditPartnerReferral: async () => { count("recordCreditPartnerReferral"); return R.fail ? { success: false, error: "refused" } : { success: true, taskWritten: true, referral: { id: "ref-1" } } } } } },
  { file: "app/actions/user-profile.ts", fn: "saveAgentEmailSignature", args: () => ["Pat Broker"], action: "profile.email_signature.update", subject: ["user", U], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users() }), refuse: "users" },
  { file: "app/actions/phone-provisioning.ts", fn: "updateBrokeragePhoneSettings", args: () => [{ autoProvisionPhoneNumbers: true }], action: "platform.phone_settings.update", subject: ["brokerage", B], risk: "LOW_RISK_WRITE",
    seed: () => ({ brokerages: [{ id: B }] }), refuse: "brokerages" },
  { file: "app/actions/settings/integrations.ts", fn: "togglePlatformCredential", args: () => [X, false], action: "platform.provider_credential.toggle", subject: ["platform_credential", X], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: users(), platform_credentials: [{ id: X, owner_type: "brokerage", owner_id: B, is_active: true }] }), refuse: "platform_credentials" },
  { file: "app/actions/admin/subscription-agreement.ts", fn: "signSubscriptionAgreementAction", args: () => [{ templateId: X, signedName: "Pat Broker" }], action: "subscription.agreement.sign", subject: ["subscription_contract_template", X], risk: "LEGAL",
    seed: () => ({ users: users(), platform_contract_templates: [{ id: X, contract_type: "subscription_agreement", is_active: true, body_text: "Agreement text", version: 1 }], tenant_contract_signatures: [], brokerages: [{ id: B, name: "Brokerage" }] }), refuse: "tenant_contract_signatures",
    stubs: { "next/headers": { headers: async () => new Map() },
             "@/lib/legal/subscription-agreement": { assessSignatoryAuthority: async () => { count("assessSignatoryAuthority"); return { ok: true, authority: { authorized: true } } }, acceptanceRefusal: () => null, buildAcceptanceRow: () => ({ ok: true, row: {} }) } } },
  { file: "app/actions/brief-audio.ts", fn: "generateBriefAudio", args: () => [{ brief: { summary: "Three closings this week.", priorities: [], metrics: [] } }], action: "brief.audio.generate", subject: ["user", U], risk: "LOW_RISK_WRITE", flip: true,
    stubs: { "@/lib/voice/voice-resolver": { resolveSelfVoice: async () => ({ voiceId: "voice-1", source: "generic" }) }, "@/lib/video/realism-profile": { elevenLabsModelForLane: () => "tts-model", withNaturalPauses: (s: string) => s },
             "@/lib/voice/elevenlabs-tts": { synthesizeSpeech: async () => { count("synthesizeSpeech"); return R.fail ? { success: false, error: "tts refused" } : { success: true, audioBuffer: Buffer.from("x") } }, audioBufferToDataUrl: () => "data:audio/mpeg;base64,eA==" } } },
  { file: "app/actions/voice-tenancy.ts", fn: "setTwilioByoCredsAction", args: () => [{ accountSid: `AC${"a".repeat(32)}`, authToken: "t".repeat(32) }], action: "platform.carrier_credential.set", subject: ["provider_credential", null], risk: "LOW_RISK_WRITE",
    seed: () => ({ brokerages: [{ id: B, plan_tier: "multi_location" }], platform_credentials: [] }), refuse: "platform_credentials" },
  { file: "app/actions/ai-predictions.ts", fn: "toggleAutoPilot", args: () => [X, true], action: "prediction.autopilot_plan.toggle", subject: ["ai_autopilot_plan", X], risk: "LOW_RISK_WRITE",
    // The toggle now reads the session's tenant and carries it on the update (wave 155, lane 155S2): the fixture row is the tenant's.
    seed: () => ({ ai_autopilot_plans: [{ id: X, is_active: true, brokerage_id: B, agent_id: A }] }), refuse: "ai_autopilot_plans" },
  { file: "app/actions/services-config.ts", fn: "togglePlaybook", args: () => [X, false], action: "services.playbook.toggle", subject: ["plan_task", X], risk: "LOW_RISK_WRITE", throws: true,
    seed: () => ({ plan_tasks: [{ id: X, brokerage_id: B, active: true }] }), refuse: "plan_tasks" },
  { file: "app/actions/onboarding/brand.ts", fn: "saveBrandColors", args: () => [{ primaryColor: "#112233", secondaryColor: "#445566" }], action: "brand.colors.update", subject: ["brokerage", B], risk: "LOW_RISK_WRITE",
    seed: () => ({ global_settings: [], brokerage_brand_settings: [] }), refuse: "global_settings",
    stubs: { "@/lib/format/style": { sanitizeCssColor: (s: string) => s } } },
  { file: "app/actions/vendors/vendor-plans.ts", fn: "setVendorPlanStatusAction", args: () => [{ planId: X, status: "archived" }], action: "vendor.plan.set_status", subject: ["vendor_plan", X], risk: "LOW_RISK_WRITE",
    seed: () => ({ vendor_plans: [{ id: X, brokerage_id: B, status: "active", is_default: false }] }), refuse: "vendor_plans",
    stubs: { "@/lib/vendors/vendor-validators": { VENDOR_PLAN_STATUSES: ["active", "archived"], validateVendorPlan: () => [] } } },
  { file: "app/actions/ai-calendar-management.ts", fn: "blockCalendarTime", args: () => [{ agentId: A, startTime: "2026-01-05T15:00:00Z", endTime: "2026-01-05T16:00:00Z", title: "Admin", type: "admin" }], action: "calendar.block.create", subject: ["user", U], risk: "LOW_RISK_WRITE",
    seed: () => ({ calendar_blocks: [] }), refuse: "calendar_blocks",
    stubs: { "@/lib/ai/generate": { bookedGenerateObject: () => async () => { count("model"); throw new Error("no model is called in this proof") } } } },
  { file: "app/actions/knowledge/search.ts", fn: "deleteHelpTopic", args: () => [X], action: "knowledge.help_topic.delete", subject: ["help_topic", X], risk: "LOW_RISK_WRITE",
    seed: () => ({ help_topics_kb: [{ id: X, brokerage_id: B }] }), refuse: "help_topics_kb" },
  { file: "app/actions/voice-assistant.ts", fn: "updateVoiceConfig", args: () => [undefined, { wake_word: "hey vip" }], action: "voice.assistant_config.update", subject: ["agent", A], risk: "LOW_RISK_WRITE",
    seed: () => ({ voice_assistant_config: [{ id: X, agent_id: A, wake_word: "hey assistant" }] }), refuse: "voice_assistant_config" },
  { file: "app/actions/admin/locations.ts", fn: "deleteLocationAction", args: () => [X], action: "office.location.delete", subject: ["location", X], risk: "LOW_RISK_WRITE",
    seed: () => ({ users: [], agents: [], locations: [{ id: X, brokerage_id: B }] }), refuse: "locations",
    stubs: { "@/lib/kernel/resolve-user-office": { resolveViewerHierarchy: async () => ({ ok: true, scope: { aggregate: true, locationIds: [] } }) } } },
]

/** The names a module imports from each specifier (static + `const { … } = await import(…)`), read from comment-free source. */
function importsOf(file: string): Map<string, Set<string>> {
  const src = blankComments(readFileSync(join(ROOT, file), "utf8"))
  const out = new Map<string, Set<string>>()
  const add = (spec: string, names: string[]) => { const s = out.get(spec) ?? new Set<string>(); names.forEach((n) => n && s.add(n)); out.set(spec, s) }
  for (const m of src.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (m[1]) continue
    const clause = m[2]
    const names: string[] = []
    const brace = /\{([\s\S]*)\}/.exec(clause)
    if (brace) for (const part of brace[1].split(",")) { const p = part.trim(); if (!p || p.startsWith("type ")) continue; names.push(p.split(/\s+as\s+/)[0].trim()) }
    const def = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim()
    if (def && !def.startsWith("*")) names.push("default")
    add(m[3], names)
  }
  for (const m of src.matchAll(/\b(?:const|let)\s*\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) add(m[2], m[1].split(",").map((p) => p.trim().split(":")[0].trim()))
  return out
}
const g = globalThis as any
g.__R10 = { bind: (file: string, spec: string, name: string) => {
  const own = CASES.find((c) => c.file === file)?.stubs?.[spec]
  if (own && name in own) return own[name]
  if (COMMON[spec] && name in COMMON[spec]) return COMMON[spec][name]
  return (..._a: unknown[]) => { throw new Error(`R10 harness: unstubbed ${spec}#${name} called from ${file}`) }
}, db: () => R.db }
const TARGETS = new Map(CASES.map((c) => [pathToFileURL(join(ROOT, c.file)).href, c.file]))
const IMPORTS = new Map(CASES.map((c) => [c.file, importsOf(c.file)]))
const dataUrl = (src: string) => `data:text/javascript,${encodeURIComponent(src)}`
const DB_STUB = "export const createClient = async () => globalThis.__R10.db(); export const createServerClient = createClient; export const createServiceClient = () => globalThis.__R10.db()"
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: dataUrl("export {}"), shortCircuit: true }
    if (spec === "@/lib/supabase/server" || spec === "@/lib/supabase/service") return { url: dataUrl(DB_STUB), shortCircuit: true }
    const file = ctx?.parentURL ? TARGETS.get(String(ctx.parentURL)) : undefined
    if (file && spec !== "@/lib/kernel/action-ledger" && (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("next/") || spec === "stripe")) {
      const names = new Set(IMPORTS.get(file)?.get(spec) ?? [])
      for (const n of Object.keys(CASES.find((c) => c.file === file)?.stubs?.[spec] ?? {})) names.add(n)
      const lines = [...names].map((n) => n === "default"
        ? `export default globalThis.__R10.bind(${JSON.stringify(file)}, ${JSON.stringify(spec)}, "default")`
        : `export const ${n} = globalThis.__R10.bind(${JSON.stringify(file)}, ${JSON.stringify(spec)}, ${JSON.stringify(n)})`)
      return { url: dataUrl(`/* ${file} */\n${lines.join("\n")}\nexport {}`), shortCircuit: true }
    }
    if (spec === "next/cache") return { url: dataUrl("export const revalidatePath = () => {}; export const revalidateTag = () => {}"), shortCircuit: true }
    if (spec === "next/headers") return { url: dataUrl("export const headers = async () => new Map(); export const cookies = async () => ({ get() {}, getAll() { return [] } })"), shortCircuit: true }
    return next(spec, ctx)
  },
})

function freshDb(c: ModuleCase, refuse: boolean): MemClient {
  const seed = c.seed?.() ?? {}
  const db = memSupabase({ ...seed, agent_action_ledger: [] }, { uuidIds: true, ...(refuse && c.refuse ? { refuse: { [c.refuse]: "refused by the proof (RLS-shaped)" } } : {}) })
  ;(db as any).auth = { getUser: async () => ({ data: { user: { id: U, email: "pat@example.test" } }, error: null }) }
  return db
}
const ledger = () => (R.db.tables.agent_action_ledger ?? []) as Row[]
function receiptOk(c: ModuleCase, r: Row): string[] {
  const bad: string[] = []
  if (r.action !== c.action) bad.push(`action ${r.action}`)
  if (r.actor_type !== "user" || r.actor_user_id !== U) bad.push(`actor ${r.actor_type}/${r.actor_user_id}`)
  if (r.brokerage_id !== B) bad.push(`tenant ${r.brokerage_id}`)
  if (r.subject_type !== c.subject[0] || (c.subject[1] !== null && r.subject_id !== c.subject[1])) bad.push(`subject ${r.subject_type}/${r.subject_id}`)
  if (r.risk_class !== c.risk) bad.push(`risk ${r.risk_class}`)
  if (r.reason_code !== "HUMAN_REQUESTED") bad.push(`reason ${r.reason_code}`)
  if (r.idempotency_key) bad.push(`idempotency_key ${r.idempotency_key}`)
  return bad
}
async function drivenSection(): Promise<void> {
  console.log("\n§B — per module, one export DRIVEN against the in-memory client (no network, no provider, no model)")
  // POSITIVE CONTROL for the receipt assertion itself: an empty ledger and a wrong-tenant row must both fail it.
  const probe = CASES[0]
  check("positive control: the receipt check rejects a wrong-tenant / wrong-actor row", receiptOk(probe, { action: probe.action, actor_type: "user", actor_user_id: randomUUID(), brokerage_id: randomUUID(), subject_type: "vendor", subject_id: V, risk_class: "FINANCIAL", reason_code: "HUMAN_REQUESTED" }).length >= 2)
  for (const c of CASES) {
    let mod: any
    try { mod = await import(pathToFileURL(join(ROOT, c.file)).href) } catch (e) { check(`${c.file} loads under the harness`, false, (e as Error).message.slice(0, 220)); continue }
    const call = async () => { try { return { value: await mod[c.fn](...c.args()) } } catch (e) { return { threw: (e as Error).message } } }
    // 1 — one receipt
    R.fail = false; R.db = freshDb(c, false)
    const once = await call()
    const rows = ledger()
    check(`${c.fn}: exactly one receipt, executed`, rows.length === 1 && rows[0].status === "executed", `${rows.length} rows ${rows.map((r) => r.status).join(",")} ${"threw" in once ? `threw: ${once.threw}` : JSON.stringify(once.value).slice(0, 160)}`)
    if (rows[0]) { const bad = receiptOk(c, rows[0]); check(`${c.fn}: receipt names session actor, session tenant, ${c.action}, subject ${c.subject[0]}, ${c.risk}`, bad.length === 0, bad.join("; ")) }
    // 2 — twice → two receipts, two runs (the no-key canary)
    R.db = freshDb(c, false)
    await call(); await call()
    const two = ledger()
    // Both calls RAN and settled their own row (a delete's second run honestly fails on the row the first removed); a replay would
    // add no second row at all — that is what a wrong key looks like.
    check(`${c.fn}: called twice → two receipts, both runs settled (no key, the second call is not a replay)`, two.length === 2 && two[0].status === "executed" && two.every((r) => r.status === "executed" || r.status === "failed"), two.map((r) => r.status).join(","))
    // 3 — a refused write settles failed
    R.fail = !!c.flip; R.db = freshDb(c, !c.flip)
    const failed = await call()
    const f = ledger()
    check(`${c.fn}: a refused write settles the receipt failed${c.throws ? " (and still throws)" : ""}`, f.length === 1 && f[0].status === "failed" && (!c.throws || "threw" in failed), `${f.map((r) => r.status).join(",")} ${"threw" in failed ? "threw" : "returned"}`)
    R.fail = false
  }
  const secretRow = JSON.stringify(ledger())
  check("no receipt carries a credential value (the Twilio token / SID never reach the ledger)", !secretRow.includes("t".repeat(32)) && !secretRow.includes("a".repeat(32)))
  check("provider seams were stubbed and counted, never live (stripe.accounts.retrieve / synthesizeSpeech)", (R.calls["stripe.accounts.retrieve"] ?? 0) >= 2 && (R.calls["synthesizeSpeech"] ?? 0) >= 2, JSON.stringify(R.calls))
}

async function main(): Promise<void> {
  console.log("LEDGER RECEIPTS — platform1 (wave 155, lane 155R10)")
  staticSection()
  if (!process.argv.includes("--static-only")) await drivenSection()
  console.log(`\nRESULT: ${pass} passed, ${failures.length} failed`)
  if (failures.length) { console.log("❌ LEDGER_RECEIPTS_PLATFORM1_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_PLATFORM1_PASS — every platform1 write leaves one receipt; no key turns a second save into a replay")
}
main().catch((e) => { console.error(e); process.exit(1) })
