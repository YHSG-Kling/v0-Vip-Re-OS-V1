/**
 * scripts/ledger-receipts-transaction1-guard.ts — test:ledger-receipts-transaction1 (wave 155, lane 155R3; group G12 list
 * "transaction1": offers, transactions, milestones, closing steps, showings — 28 modules, 100 rows).
 *
 * THE RULE PROVEN: a signed-in person's write on this list leaves ONE receipt on agent_action_ledger naming who (the SESSION
 * user), which tenant (the SESSION's), what (a three-segment action), on what (the subject row), under which risk class
 * (lib/ai-isa/persona-tool-policy.ts ToolRiskClass) and what happened — through the ONE helper, ledgerSessionAction
 * (lib/kernel/action-ledger.ts). No second helper, no second record.
 *
 *  §1 lint (stripped source, every ledgerSessionAction call in the list's files): the action name is domain.entity.action
 *     (the live CHECK's pattern), reasonCode is HUMAN_REQUESTED, riskClass is the vocabulary, the actor is a user, and NO call
 *     passes `cycle` or `idempotencyKey` — with a key a person's second save is a silent replay (the brief's one rule).
 *     Positive controls: each finder sees its defect in a planted specimen.
 *  §2 reach (stripped source): every row this lane closed reaches the helper — the export's own body, or the ONE receipt
 *     site it calls (named per row below). The rows left open are listed with their reason and asserted NOT to carry one
 *     (a read is never receipted to move a number).
 *  §3 runtime, per MODULE, against the in-memory client (scripts/canaries/_harness.ts: the service + session clients
 *     resolve to memSupabase; the session resolvers and the model doors are stubbed — no provider is ever called live):
 *     one export driven → exactly ONE receipt (actor = the session user, tenant = the session's, the action, the subject,
 *     the risk class, settled executed); a failed write → the receipt settles failed; the SAME call twice → TWO receipts
 *     and the body ran twice (the no-key regression canary).
 *  RED AT THE BASE (e88c1baa): §1/§2 find no helper call; §3 finds no receipt.
 *  BLIND SPOTS (published): RLS is not modelled (the stubs are the session); the model doors return canned output, so a
 *  model-shaped parse is exercised only as far as the canned text reaches; outside-offer-loop.ts is driven THROUGH
 *  respond-to-counter.ts (its only receipt site — authorize() needs a full outside chain); fillPropertyDataWithAI reports
 *  failure as `null`, which settles executed (the export's own contract — said, not hidden).
 */
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { stripComments } from "./strip-comments"
import { stubModule, setSvc, setSessionUser, canaryClient, type CanarySvc } from "./canaries/_harness"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(src(p))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

// ── the list (rows from $S/b2/g12/transaction1-rows.json) and where each closed row's receipt sits ──────────────────────────
const A = "app/actions/"
/** row → [module, export, receipt site "file#function"] — the site is the export itself unless named. */
const CLOSED: Array<[string, string, string?]> = [
  ...["aiCalculateEscalation", "aiCounterOfferStrategy", "aiGenerateBuyerLetter", "aiRecommendContingencies", "generateOfferDraft", "getOfferForms", "runCompleteOfferWorkflow"].map((e): [string, string] => [A + "ai-offer-creation.ts", e]),
  ...["addCommission", "addDeadline", "addParticipant", "calculateCommissions", "completeDeadline", "detectTransactionDelays", "detectTransactionIssues", "generateSmartChecklist", "markCommissionPaid", "respondToRepairRequest", "setDocumentClientVisibility", "setTaskItemCompleted", "updateMilestone"]
    .map((e): [string, string, string] => [A + "transactions.ts", e, `lib/application/transactions.ts#${e}`]),
  [A + "transactions.ts", "setMilestoneClientVisibility", "lib/application/transactions.ts#updateMilestone"],
  [A + "transactions.ts", "loadClientDashboard", "lib/application/transactions.ts#loadClientDashboard>stampClientUpdateReceipts"],
  [A + "transactions.ts", "withdrawCommissionTermChangeAction"],
  ...["analyzeAddressForBuyer", "requestComparisonReview", "requestPreApprovalRefresh", "signalAffordabilityChecked"].map((e): [string, string] => [A + "buyer-offer-tools.ts", e]),
  ...["analyzeOffer", "generateSellerPortalLink", "recordSellerView"].map((e): [string, string] => [A + "seller-offers.ts", e]),
  ...["aiAnalyzeShowingFeedback", "aiCollectShowingFeedback", "aiScheduleShowing", "aiSendShowingConfirmation", "getAIShowingInsights", "updateTour"].map((e): [string, string] => [A + "ai-showing-management.ts", e]),
  ...["aiAnalyzeContract", "aiClassifyDocument", "aiGenerateDocument", "aiGenerateDocumentReminders", "aiVerifySignatures"].map((e): [string, string] => [A + "ai-document-intelligence.ts", e]),
  ...["applyContractExtraction", "compareContractVersions"].map((e): [string, string] => [A + "ai-contract-review.ts", e]),
  ...["checkDuplicateOffer", "checkPendingOfferLimit"].map((e): [string, string, string] => [A + "buyer-offer/handle-multi-offer.ts", e, A + "buyer-offer/handle-multi-offer.ts#emitMultiOfferEvent"]),
  [A + "buyer-offer/outside-offer-loop.ts", "respondToOutsideCounter", A + "buyer-offer/respond-to-counter.ts#respondToCounter"],
  [A + "dotloop-integration.ts", "createDocumentFolder"],
  ...["acknowledgeOfferIntent", "dismissOfferIntent"].map((e): [string, string, string] => [A + "offer-intents.ts", e, A + "offer-intents.ts#transitionIntent"]),
  ...["aiAnalyzeCampaignPerformance", "aiPredictCampaignROI", "aiSelectTargetAudience", "aiSuggestDesign", "aiWritePostcardCopy", "createDirectMailCampaign", "validateMailingList"].map((e): [string, string] => [A + "ai-direct-mail.ts", e]),
  ...["aiCheckListingCompliance", "aiSuggestListPrice", "generateListingAgreement", "generateListingLandingPage"].map((e): [string, string] => [A + "ai-listing-intake.ts", e]),
  ...["generateIdentityPreview", "previewAssistantVoiceAction"].map((e): [string, string] => [A + "ai-identity.ts", e]),
  [A + "ai-property-matching.ts", "analyzePropertyForBuyer"],
  [A + "ai-property-matching.ts", "learnFromBuyerFeedback"],
  [A + "buyer-offer/prefill-offer.ts", "fillPropertyDataWithAI"],
  [A + "buyer-offer/prefill-storage-form.ts", "prefillStorageFormAction"],
  [A + "buyer-offer/respond-to-counter.ts", "respondToCounter"],
  [A + "buyer-offer/track-offer-lifecycle.ts", "markOfferExpired"],
  [A + "buyer-offers.ts", "confirmSigningOrderAction"],
  [A + "compliance-bridge-actions.ts", "emitCompliancePassedAction"],
  [A + "offers/present-to-seller.ts", "unpresentOfferFromSeller"],
  [A + "transaction-document-signatures.ts", "resendDocumentForSignature"],
  ...["assignLenderToTransaction", "assignTransactionCoordinator", "bulkUpdateMilestones", "createTeam", "createWorkflowAutomation", "saveClientJourneyPreferences", "submitComplianceReviewDecision", "trackConditionClearance"].map((e): [string, string] => [A + "multi-persona.ts", e]),
  ...["analyzeTransactionHealth", "draftTransactionCommunication", "generatePostClosingPlan", "generateSmartTasks", "monitorTransactionRisks", "predictAndManageDeadlines"].map((e): [string, string] => [A + "ai-transaction-coordinator.ts", e]),
  ...["createTRIDTimeline", "monitorTRIDCompliance", "reviewContentApproval", "submitContentForApproval", "updateTRIDMilestone"].map((e): [string, string] => [A + "compliance-monitoring.ts", e]),
  ...["generateMarketingInsight", "launchListingCampaign", "runPrelaunchCheck"].map((e): [string, string] => ["app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts", e]),
  ...["analyzeCompetitorLandscape", "repurposeContent"].map((e): [string, string, string] => ["app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts", e, "app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts#generateMarketingInsight"]),
]
/** Rows left OPEN, each with its reason — never receipted to move a number. */
const OPEN: Array<[string, string, string]> = [
  [A + "transactions.ts", "getClosingDates", "READ-ONLY: selects only; resolveClosingDates is pure (the analyzer credits seedContractClosing's write in the same file)"],
  [A + "buyer-offer/outside-offer-loop.ts", "listOutsideOffers", "READ-ONLY: loadOutsideChain + governingContractTerms select only"],
  [A + "dotloop-integration.ts", "getDocumentAccessLog", "READ-ONLY: selects document_access_log + a name lookup"],
]
// The entitlements route is platform staff acting ON a tenant: there is no session tenant, so the receipt is filed against the
// brokerage the override changes (the URL's), and only after the platform-staff gate has passed. It was left open here while it
// carried no receipt; wave 155 (lanes R15/R17) closed it, so this guard now holds the rule instead of the waypoint.
const ROUTE_PLATFORM_ON_TENANT = "app/api/admin/billing/entitlements/[brokerageId]/route.ts"
/** A platform-staff route's write is receipted after its gate, against the brokerage it changes. */
function platformRouteReceiptedAfterGate(src: string): boolean {
  const post = src.slice(Math.max(0, src.search(/export async function POST\b/)))
  const gate = post.search(/\brequireSuperadminAuth\s*\(/)
  const refuse = post.search(/if\s*\(\s*!auth\.ok\s*\)\s*return\b/)
  const receipt = post.search(/\bledgerSessionAction\s*\(\s*\{\s*brokerageId:\s*brokerageId\b/)
  return gate >= 0 && refuse > gate && receipt > refuse && /subject:\s*\{\s*type:\s*"brokerage",\s*id:\s*brokerageId\s*\}/.test(post.slice(receipt))
}

/** The stripped body of a top-level function (export or not) — from its declaration to the next top-level `}`. */
function fnBody(file: string, name: string): string | null {
  const c = code(file)
  const m = new RegExp(`^(?:export )?async function ${name}\\b`, "m").exec(c)
  if (!m) return null
  const rest = c.slice(m.index)
  const end = rest.search(/\n}\n/)
  return end < 0 ? rest : rest.slice(0, end + 2)
}
const CALL_RE = /ledgerSessionAction\(\{([\s\S]*?)\},\s*async\s*\(/g
const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const RISK = new Set(["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"])
function lintCall(ctx: string): string[] {
  const bad: string[] = []
  const action = /action:\s*"([^"]+)"/.exec(ctx)?.[1]
  if (!action || !NAME_RE.test(action)) bad.push(`action ${action ?? "(not a literal)"}`)
  if (!/reasonCode:\s*"HUMAN_REQUESTED"/.test(ctx)) bad.push("reasonCode")
  if (!/actor:\s*\{\s*type:\s*"user"/.test(ctx)) bad.push("actor")
  const risks = [...ctx.matchAll(/"(READ|LOW_RISK_WRITE|COMMUNICATION|FINANCIAL|LEGAL|IRREVERSIBLE|[A-Z_]{4,})"/g)].map((m) => m[1]).filter((r) => r !== "HUMAN_REQUESTED")
  if (!/riskClass:/.test(ctx) || risks.length === 0 || risks.some((r) => !RISK.has(r))) bad.push(`riskClass ${risks.join("/")}`)
  if (/\b(cycle|idempotencyKey)\s*:/.test(ctx)) bad.push("a key (cycle / idempotencyKey)")
  return bad
}

async function main() {
  const files = [...new Set([...CLOSED.map((r) => r[0]), ...CLOSED.map((r) => (r[2] ?? "").split("#")[0]).filter(Boolean)])]

  section("1 · lint — every ledgerSessionAction call on the list: three-segment name, HUMAN_REQUESTED, user actor, vocabulary risk, NO key")
  {
    let calls = 0
    const defects: string[] = []
    for (const f of files) for (const m of code(f).matchAll(CALL_RE)) { calls++; const b = lintCall(m[1]); if (b.length) defects.push(`${f}: ${b.join(", ")} @ ${m[1].slice(0, 80)}`) }
    check(`${calls} helper calls across ${files.length} files, every one well-formed and keyless`, calls >= 80 && defects.length === 0, defects.slice(0, 4).join(" | "))
    check("POSITIVE CONTROL: a two-segment name is caught", lintCall(`action: "offer.accept", actor: { type: "user" }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED"`).some((x) => x.startsWith("action")))
    check("POSITIVE CONTROL: a cycle key is caught", lintCall(`action: "offer.counter.respond", actor: { type: "user" }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED", cycle: "x"`).some((x) => x.includes("key")))
    check("POSITIVE CONTROL: an off-vocabulary risk class is caught", lintCall(`action: "a.b.c", actor: { type: "user" }, riskClass: "OPERATIONAL", reasonCode: "HUMAN_REQUESTED"`).some((x) => x.startsWith("riskClass")))
    check("POSITIVE CONTROL: a comment is not a call site (stripped source)", ![...stripComments(`// ledgerSessionAction({ action: "x" }, async () => {`).matchAll(CALL_RE)].length)
  }

  section("2 · reach — every closed row reaches the helper; every open row is open for its stated reason")
  {
    const miss: string[] = []
    for (const [file, exp, site] of CLOSED) {
      const body = fnBody(file, exp)
      if (!body) { miss.push(`${exp}: export not found`); continue }
      if (!site) { if (!/ledgerSessionAction\(/.test(body)) miss.push(`${exp}: no helper call in its body`); continue }
      // "file#via>fn": the export calls `via` (same name, in the site file), which calls `fn` — the receipt site
      const [sf, chain] = site.split("#")
      const [via, sfn] = chain.includes(">") ? chain.split(">") : [chain, chain]
      const sb = fnBody(sf, sfn)
      if (!sb || !/ledgerSessionAction\(/.test(sb)) miss.push(`${exp}: site ${site} has no helper call`)
      if (!new RegExp(`\\b${via}\\s*\\(`).test(body)) miss.push(`${exp}: does not call ${via}`)
      if (via !== sfn && !new RegExp(`\\b${sfn}\\s*\\(`).test(fnBody(sf, via) ?? "")) miss.push(`${exp}: ${via} does not call ${sfn}`)
    }
    // 96 = the 95 rows the analyzer now reads working + learnFromBuyerFeedback (receipted; still open on `readback`).
    check(`${CLOSED.length} receipted rows reach ledgerSessionAction`, CLOSED.length === 96 && miss.length === 0, miss.slice(0, 5).join(" | "))
    for (const [file, exp, why] of OPEN) {
      const body = fnBody(file, exp) ?? ""
      check(`open: ${exp} — ${why.split(":")[0]}, writes nothing and carries no receipt`, !!body && !/ledgerSessionAction\(/.test(body) && !/\.(insert|update|upsert|delete)\s*\(/.test(body))
    }
    check("the entitlements route (platform staff acting on a tenant) is receipted after its gate, against the brokerage it changes", platformRouteReceiptedAfterGate(code(ROUTE_PLATFORM_ON_TENANT)))
    check("POSITIVE CONTROL: a receipt filed before the platform-staff gate is refused", !platformRouteReceiptedAfterGate(`export async function POST(req) { const { brokerageId } = await params; const r = await ledgerSessionAction({ brokerageId: brokerageId, subject: { type: "brokerage", id: brokerageId } }, run); const auth = await requireSuperadminAuth(supabase); if (!auth.ok) return auth.response }`))
    check("POSITIVE CONTROL: a gated route with no receipt is refused", !platformRouteReceiptedAfterGate(`export async function POST(req) { const auth = await requireSuperadminAuth(supabase); if (!auth.ok) return auth.response; return applyFeatureOverride({ brokerageId }) }`))
    check("POSITIVE CONTROL: the write finder sees a write in an open-row specimen", /\.(insert|update|upsert|delete)\s*\(/.test(`await svc.from("offers").update({ x: 1 })`))
  }

  section("3 · runtime — one export per module: ONE receipt (actor, tenant, action, subject, risk), a failure settles failed, twice = two receipts")
  await runtime()

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("❌ LEDGER_RECEIPTS_TRANSACTION1_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_TRANSACTION1_PASS — every closed row on the transaction1 list leaves one session receipt through ledgerSessionAction, keyless")
}

// ── §3 harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const B = "b1550003-0000-4000-8000-000000000001", B2 = "b1550003-0000-4000-8000-000000000002"
const U = "a1550003-0000-4000-8000-000000000011", AG = "a1550003-0000-4000-8000-000000000021"
const id = (n: number) => `c1550003-0000-4000-8000-${String(n).padStart(12, "0")}`
type G3 = { ctx: Record<string, unknown>; modelCalls: number; modelFail: boolean; contactAccess: Record<string, unknown> | null }
const G = globalThis as unknown as { __R3: G3 }
G.__R3 = { ctx: {}, modelCalls: 0, modelFail: false, contactAccess: null }

function installStubs() {
  const DIR = mkdtempSync(join(tmpdir(), "r3-receipts-"))
  const fileStub = (spec: string, real: string, body: string) => {
    const f = join(DIR, `${spec.replace(/[^a-z0-9]+/gi, "_")}.mjs`)
    writeFileSync(f, `export * from ${JSON.stringify(pathToFileURL(join(ROOT, real)).href)}\n${body}\n`)
    stubModule(spec, pathToFileURL(f).href)
  }
  stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f")
  fileStub("@/lib/identity/get-agent-context", "lib/identity/get-agent-context.ts", "export const getAgentContext = async () => ({ ...globalThis.__R3.ctx })")
  fileStub("@/lib/platform/acting-context", "lib/platform/acting-context.ts",
    "export const resolveWriteContext = async () => { const c = globalThis.__R3.ctx; if (!c.isAuthenticated) return { ok: false, error: 'Unauthorized' }; const { createServiceClient } = await import('@/lib/supabase/service'); return { ok: true, db: createServiceClient(), userId: c.userId, brokerageId: c.brokerageId, userType: c.userType, actorUserId: c.userId } }")
  fileStub("@/lib/portal/require-contact-access", "lib/portal/require-contact-access.ts", "export const requireContactAccess = async () => globalThis.__R3.contactAccess ?? { ok: false, error: 'Unauthorized' }")
  // The model doors: COUNTED, canned, never live.
  const model = "const R = globalThis.__R3; const turn = () => { R.modelCalls++; if (R.modelFail) throw new Error('model refused (stub)') }"
  fileStub("@/lib/ai/models", "lib/ai/models.ts", `${model}
export const generateTextRouted = async () => { turn(); return { text: '{"ok":true}', usage: {} } }
export const generateObjectRouted = async () => { turn(); return { object: { recommended: true, startingOffer: 1, escalationIncrement: 1, maxEscalationPrice: 2, capAtAppraisal: false, proofRequired: [], reasoning: 'stub', riskAssessment: 'stub', sampleClauseText: 'stub', colorScheme: { primary: '#000', secondary: '#111', accent: '#222', background: '#fff' } } } }`)
}

/** The ledger rows this driver produced, newest last. */
const receipts = (svc: CanarySvc) => ((svc.tables.agent_action_ledger ?? []) as Array<Record<string, any>>)
interface Driver {
  module: string
  /** seed tables (the session user/agent rows are added) */
  seed: () => Record<string, Array<Record<string, any>>>
  /** run the export once; returns its result */
  run: (m: Record<string, any>) => Promise<any>
  /** make the next run fail (a refused write / a refused model call); returns client options when the failure is a refusal */
  fail: { model?: boolean; refuse?: Record<string, string>; missingColumns?: Record<string, string[]>; run?: (m: Record<string, any>) => Promise<any> }
  expect: { action: string; subjectType: string; subjectId?: string | null; risk: string }
  /** how many times the body ran (a table's row count or the model counter) */
  ran: (svc: CanarySvc) => number
  contactAccess?: boolean
  /** the in-memory fixture cannot carry the whole success path (a downstream reader / provider is not modelled): the receipt
   *  is asserted (who, tenant, action, subject, risk) and may settle executed OR failed — said per driver, never hidden. */
  anyStatus?: boolean
  /** the export's own failure contract settles this way (fillPropertyDataWithAI reports failure as null → executed). */
  failStatus?: "failed" | "executed"
}

function baseSeed(): Record<string, Array<Record<string, any>>> {
  return {
    users: [{ id: U, brokerage_id: B, user_type: "broker", email: "agent@r3.test", first_name: "Rae", last_name: "Three", team_id: null }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true, first_name: "Rae", last_name: "Three" }],
    agent_action_ledger: [],
  }
}

async function drive(d: Driver) {
  const name = d.module.replace(/^app\/(actions\/)?/, "")
  const mk = (opts: Parameters<typeof canaryClient>[1] = {}) => {
    const seed = baseSeed()
    for (const [t, rows] of Object.entries(d.seed())) seed[t] = [...(seed[t] ?? []), ...rows]
    const svc = canaryClient(seed, opts)
    setSvc(svc); setSessionUser(svc, U)
    G.__R3.ctx = { userId: U, agentId: AG, brokerageId: B, teamId: null, userType: "broker", role: "broker", isAuthenticated: true }
    G.__R3.contactAccess = d.contactAccess ? { ok: true, userId: U, brokerageId: B, isContactSelf: false, userType: "broker" } : null
    G.__R3.modelCalls = 0; G.__R3.modelFail = false
    return svc
  }
  let m: Record<string, any>
  try { m = await quiet(() => import(pathToFileURL(join(ROOT, d.module)).href)) } catch (e) { check(`${name}: the module loads`, false, (e as Error).message.slice(0, 200)); return }
  // once
  const svc = mk()
  const r1 = await quiet(() => d.run(m)).catch((e) => ({ threw: (e as Error).message }))
  const rows = receipts(svc)
  const one = rows[0]
  check(`${name}: ONE receipt — ${d.expect.action}`, rows.length === 1, `rows=${rows.length} result=${JSON.stringify(r1).slice(0, 220)}`)
  if (one) {
    const ok = one.action === d.expect.action && one.brokerage_id === B && one.actor_type === "user" && one.actor_user_id === U && one.subject_type === d.expect.subjectType
      && (d.expect.subjectId === undefined || one.subject_id === d.expect.subjectId) && one.risk_class === d.expect.risk && one.reason_code === "HUMAN_REQUESTED"
      && (one.status === "executed" || (d.anyStatus === true && one.status === "failed"))
    check(`${name}: …the session user, the session tenant, the subject, ${d.expect.risk}, settled ${d.anyStatus ? "(executed or failed — fixture-limited)" : "executed"}`, ok,
      JSON.stringify({ action: one.action, b: one.brokerage_id === B, actor: one.actor_user_id === U, st: one.subject_type, sid: one.subject_id, risk: one.risk_class, status: one.status, rc: one.reason_code, err: one.error }))
  }
  // twice → two receipts, ran twice
  const before = d.ran(svc)
  await quiet(() => d.run(m)).catch(() => null)
  check(`${name}: the same call again → a SECOND receipt and the body ran again (no key, no silent replay)`, receipts(svc).length === 2 && d.ran(svc) > before, `rows=${receipts(svc).length} ran ${before}→${d.ran(svc)}`)
  // a failure settles failed
  const fsvc = mk({ refuse: d.fail.refuse, missingColumns: d.fail.missingColumns })
  if (d.fail.model) G.__R3.modelFail = true
  const fr = await quiet(() => (d.fail.run ?? d.run)(m)).catch((e) => ({ threw: (e as Error).message }))
  const frows = receipts(fsvc)
  const want = d.failStatus ?? "failed"
  check(`${name}: a failed write → its receipt settles ${want}${want === "executed" ? " (the export reports failure as null — its own contract)" : ""}`, frows.length === 1 && frows[0].status === want, `rows=${frows.length} status=${frows[0]?.status} result=${JSON.stringify(fr).slice(0, 200)}`)
}

const modelRan = () => G.__R3.modelCalls
const rowsOf = (t: string) => (svc: CanarySvc) => ((svc.tables[t] ?? []) as unknown[]).length
const writesTo = (t: string) => (svc: CanarySvc) => svc.writes.filter((w) => w.table === t).length
const C = id(31), L = id(32), O = id(33), T = id(34), I = id(35), I2 = id(36), S = id(37), M = id(38), D = id(39)

const DRIVERS: Driver[] = [
  { module: A + "ai-offer-creation.ts", seed: () => ({}), run: (m) => m.aiCalculateEscalation({ listPrice: 500000, initialOffer: 480000, maxBudget: 520000, estimatedCompetition: "high", marketTrend: "stable" }),
    fail: { model: true }, expect: { action: "offer.escalation.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: A + "transactions.ts", seed: () => ({ transaction_milestones: [{ id: id(1), transaction_id: id(2), status: "pending" }] }),
    run: (m) => m.updateMilestone(id(1), { status: "completed" }), fail: { refuse: { transaction_milestones: "permission denied (stub)" } },
    expect: { action: "transaction.milestone.update", subjectType: "transaction_milestone", subjectId: id(1), risk: "LEGAL" }, ran: (svc) => svc.writes.filter((w) => w.table === "transaction_milestones").length },
  { module: A + "ai-identity.ts", seed: () => ({}), run: (m) => m.generateIdentityPreview({ assistantName: "Ava", personaLabel: "assistant", tone: "warm", formalityLevel: "semi_formal" }),
    fail: { model: true }, expect: { action: "assistant.identity_preview.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: "app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts", seed: () => ({}), run: (m) => m.generateMarketingInsight("three angles for a listing"),
    fail: { model: true }, expect: { action: "marketing.insight.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: A + "ai-direct-mail.ts", seed: () => ({}), run: (m) => m.aiSuggestDesign({ campaignType: "just_listed", targetAudience: "move-up buyers", brandColors: ["#000"], propertyImages: [] }),
    fail: { model: true }, expect: { action: "direct_mail.design.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: A + "buyer-offer-tools.ts", contactAccess: true, seed: () => ({ contacts: [{ id: C, contact_id: id(90), brokerage_id: B, agent_id: AG, first_name: "Bea", last_name: "Buyer" }], client_portal_activity: [], notifications: [] }),
    run: (m) => m.signalAffordabilityChecked({ contactId: C, propertyId: L, propertyAddress: "1 Oak St", price: 450000, monthlyEstimate: 2900, verdict: "comfortable" }),
    fail: { refuse: { notifications: "permission denied (stub)" } }, expect: { action: "portal.affordability.signal", subjectType: "contact", subjectId: C, risk: "LOW_RISK_WRITE" }, ran: rowsOf("client_portal_activity") },
  { module: A + "seller-offers.ts", seed: () => ({ listings: [{ id: L, brokerage_id: B, seller_contact_id: null }], offers: [{ id: O, listing_id: L, brokerage_id: B, seller_viewed_at: null }] }),
    run: (m) => m.recordSellerView(L), fail: { missingColumns: { offers: ["updated_at"] } },
    expect: { action: "offer.seller_view.record", subjectType: "listing", subjectId: L, risk: "LOW_RISK_WRITE" }, ran: writesTo("offers") },
  { module: A + "ai-showing-management.ts", seed: () => ({ tours: [{ id: T, brokerage_id: B, notes: null }] }), run: (m) => m.updateTour(T, { notes: "gate code 4411" }),
    fail: { refuse: { tours: "permission denied (stub)" } }, expect: { action: "showing.tour.update", subjectType: "tour", subjectId: T, risk: "LOW_RISK_WRITE" }, ran: writesTo("tours") },
  { module: A + "ai-document-intelligence.ts", seed: () => ({ brand_voice_profile: [] }), run: (m) => m.aiGenerateDocument({ documentType: "cover_letter", context: { buyer: "Bea" } }),
    fail: { model: true }, expect: { action: "document.draft.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: A + "ai-contract-review.ts", seed: () => ({ transactions: [{ id: T, brokerage_id: B, purchase_price: null, close_date: null }], transaction_milestones: [] }),
    run: (m) => m.applyContractExtraction({ transactionId: T, extracted: { purchasePrice: 455000, earnestMoneyAmount: null, inspectionDeadline: null, appraisalDeadline: null, financingDeadline: null, closingDate: null, buyerName: null, sellerName: null, propertyAddress: null } }),
    fail: { missingColumns: { transactions: ["purchase_price"] } }, expect: { action: "contract.extraction.apply", subjectType: "transaction", subjectId: T, risk: "LEGAL" }, ran: writesTo("transactions") },
  { module: A + "dotloop-integration.ts", seed: () => ({ document_folders: [] }), run: (m) => m.createDocumentFolder({ folderName: "Closing docs", folderType: "transaction" }),
    fail: { refuse: { document_folders: "permission denied (stub)" } }, expect: { action: "document.folder.create", subjectType: "transaction", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: rowsOf("document_folders") },
  { module: A + "offer-intents.ts", seed: () => ({ offer_intents: [{ id: I, brokerage_id: B, agent_id: AG, status: "requested" }, { id: I2, brokerage_id: B, agent_id: AG, status: "requested" }] }),
    run: (m) => m.dismissOfferIntent(I), fail: { run: (m) => m.acknowledgeOfferIntent(id(404)) },
    expect: { action: "offer.intent.transition", subjectType: "offer_intent", subjectId: I, risk: "LOW_RISK_WRITE" }, ran: writesTo("offer_intents") },
  { module: A + "ai-property-matching.ts", seed: () => ({ contacts: [{ id: C, brokerage_id: B }], listings: [{ id: L, brokerage_id: B }], property_feedback: [] }),
    run: (m) => m.learnFromBuyerFeedback({ contactId: C, propertyId: L, feedback: "loved" }), fail: { refuse: { property_feedback: "permission denied (stub)" } },
    expect: { action: "property_match.feedback.record", subjectType: "contact", subjectId: C, risk: "LOW_RISK_WRITE" }, ran: writesTo("property_feedback") },
  { module: A + "buyer-offer/prefill-offer.ts", seed: () => ({}), run: (m) => m.fillPropertyDataWithAI({ addressFragment: "12 Oak St, Tampa" }), fail: { model: true }, failStatus: "executed",
    expect: { action: "offer.property_fill.generate", subjectType: "ai_tool_usage", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: modelRan },
  { module: A + "buyer-offer/respond-to-counter.ts", seed: () => ({ offers: [{ id: O, contact_id: C, listing_id: L, transaction_id: null, brokerage_id: B, status: "countered" }], activities: [] }),
    run: (m) => m.respondToCounter({ offerId: O, response: "reject", rejectionReason: "price" }), fail: { refuse: { activities: "permission denied (stub)" } }, anyStatus: true,
    expect: { action: "offer.counter.respond", subjectType: "offer", subjectId: O, risk: "LEGAL" }, ran: writesTo("activities") },
  { module: A + "buyer-offer/track-offer-lifecycle.ts", seed: () => ({ offers: [{ id: O, brokerage_id: B, contact_id: C, status: "submitted", response_deadline: new Date(Date.now() - 86_400_000).toISOString() }], activities: [] }),
    run: (m) => m.markOfferExpired(O), fail: { refuse: { activities: "permission denied (stub)" } }, anyStatus: true,
    expect: { action: "offer.lifecycle.expire", subjectType: "offer", subjectId: O, risk: "LEGAL" }, ran: (svc) => svc.writes.length },
  { module: A + "buyer-offers.ts", seed: () => ({ offers: [{ id: O, brokerage_id: B, contact_id: C, metadata: {} }] }), run: (m) => m.confirmSigningOrderAction(O, undefined, ["Bea Buyer", "Bo Buyer"]),
    fail: { run: (m) => m.confirmSigningOrderAction(O, undefined, []) }, expect: { action: "offer.signing_order.confirm", subjectType: "offer", subjectId: O, risk: "LEGAL" }, ran: writesTo("offers") },
  { module: A + "compliance-bridge-actions.ts", seed: () => ({ offers: [{ id: O, brokerage_id: B, contact_id: C, agent_id: AG }], activities: [] }), run: (m) => m.emitCompliancePassedAction({ offerId: O, userId: U }),
    fail: { refuse: { activities: "permission denied (stub)" } }, expect: { action: "offer.compliance_gate.override", subjectType: "offer", subjectId: O, risk: "LEGAL" }, ran: rowsOf("activities") },
  { module: A + "offers/present-to-seller.ts", seed: () => ({ listings: [{ id: L, brokerage_id: B, seller_contact_id: C, address: "1 Oak St", agent_id: AG }], offers: [{ id: O, listing_id: L, brokerage_id: B, presented_to_seller_at: new Date().toISOString(), contact_id: C }], activities: [], documents: [] }),
    run: (m) => m.unpresentOfferFromSeller({ offerId: O, listingId: L, reason: "wrong offer" }), fail: { missingColumns: { offers: ["seller_presentation_note"] } }, anyStatus: true,
    expect: { action: "offer.seller_presentation.retract", subjectType: "offer", subjectId: O, risk: "LEGAL" }, ran: writesTo("offers") },
  { module: A + "transaction-document-signatures.ts", seed: () => ({ contract_signatures: [{ id: S, brokerage_id: B, esign_status: "draft" }] }), run: (m) => m.resendDocumentForSignature({ signatureId: S, transactionId: T }),
    fail: { missingColumns: { contract_signatures: ["esign_status"] } }, expect: { action: "esign.signature_request.resend", subjectType: "contract_signature", subjectId: S, risk: "LEGAL" }, ran: writesTo("contract_signatures") },
  { module: A + "multi-persona.ts", seed: () => ({ transaction_milestones: [{ id: M, transaction_id: T, status: "pending" }] }), run: (m) => m.bulkUpdateMilestones([{ milestoneId: M, status: "completed" }]),
    fail: { refuse: { transaction_milestones: "permission denied (stub)" } }, expect: { action: "transaction.milestones.bulk_update", subjectType: "transaction_milestone", subjectId: M, risk: "LEGAL" }, ran: writesTo("transaction_milestones") },
  { module: A + "compliance-monitoring.ts", seed: () => ({ transactions: [{ id: T, brokerage_id: B }], trid_timeline: [] }), run: (m) => m.createTRIDTimeline(T), fail: { refuse: { trid_timeline: "permission denied (stub)" } },
    expect: { action: "compliance.trid_timeline.create", subjectType: "transaction", subjectId: T, risk: "LEGAL" }, ran: rowsOf("trid_timeline") },
  { module: A + "ai-transaction-coordinator.ts", seed: () => ({ transactions: [{ id: T, brokerage_id: B, agent_id: AG, status: "under_contract" }], transaction_tasks: [] }),
    run: (m) => m.generateSmartTasks({ transactionId: T, agentId: U }), fail: { model: true }, anyStatus: true,
    expect: { action: "transaction.tasks.generate", subjectType: "transaction", subjectId: T, risk: "LOW_RISK_WRITE" }, ran: (svc) => svc.writes.length + G.__R3.modelCalls },
  { module: A + "ai-listing-intake.ts", seed: () => ({ documents: [], notifications: [] }), run: (m) => m.generateListingAgreement({ brokerageId: B, state: "FL", propertyAddress: "9 Bay St" }),
    fail: { run: (m) => m.generateListingAgreement({ brokerageId: B, state: "FL", documentId: D, propertyAddress: "9 Bay St" }), refuse: { documents: "permission denied (stub)" } }, anyStatus: true,
    expect: { action: "listing.agreement_packet.stage", subjectType: "document", subjectId: null, risk: "LEGAL" }, ran: (svc) => svc.writes.length + receipts(svc).length },
  { module: A + "buyer-offer/handle-multi-offer.ts", seed: () => ({ contacts: [{ id: C, brokerage_id: B }], offers: [{ id: O, contact_id: C, brokerage_id: B, listing_id: L, property_address: "1 Oak St", status: "submitted" }],
      activities: [{ id: id(60), brokerage_id: B, entity_type: "offer", entity_id: O, activity_type: "buyer.offer.submitted", created_at: new Date(Date.now() - 3_600_000).toISOString(), notes: null, agent_id: AG }] }),
    run: (m) => m.checkDuplicateOffer(C, L), fail: { missingColumns: { activities: ["metadata"] } },
    expect: { action: "offer.multi_offer_signal.record", subjectType: "contact", subjectId: C, risk: "LOW_RISK_WRITE" }, ran: (svc) => svc.writes.length + receipts(svc).length },
  { module: A + "buyer-offer/prefill-storage-form.ts", seed: () => ({}), run: (m) => m.prefillStorageFormAction({ formPath: `agents/${U}/offer.pdf`, offerId: O }), fail: {}, anyStatus: true, failStatus: "failed",
    expect: { action: "offer.form.prefill", subjectType: "brokerage_form_library", subjectId: null, risk: "LOW_RISK_WRITE" }, ran: (svc) => receipts(svc).length },
]

async function runtime() {
  installStubs()
  for (const d of DRIVERS) await drive(d)
}

main().catch((e) => { console.error(e); process.exit(1) })
