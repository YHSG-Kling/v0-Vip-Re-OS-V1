/**
 * scripts/ledger-receipts-transaction2-guard.ts — WAVE 155 (repair lane 155R9, arbitration group G12 "transaction2").
 * `npm run test:ledger-receipts-transaction2`
 *
 * THE CLAIM: every signed-in user's write on the transaction2 list leaves ONE agent_action_ledger receipt naming who (the
 * SESSION user), which tenant (the SESSION's), what (a three-segment action), on what (the subject) and under which risk
 * class — through the ONE helper, ledgerSessionAction (lib/kernel/action-ledger.ts), reached via each module's local
 * `ledgered` adapter (byte-identical in every module; it adds no ledger logic, only keeps the export's value unchanged).
 * NO idempotency key: a person's second save runs again and leaves a second receipt — the regression canary below.
 *
 * SECTIONS
 *   A · static (STRIPPED source — a tombstone or a string is not a call site): every export on the row list reaches
 *       `ledgered(`; every adapter copy is the canonical text, calls ledgerSessionAction and passes no cycle / key;
 *       every action literal is three lowercase segments and every risk class is in the ToolRiskClass vocabulary.
 *       POSITIVE CONTROLS: a planted unwrapped export, a planted wrap that exists only in a comment, a planted adapter
 *       carrying a cycle, and a two-segment name are each caught.
 *   B · driven (SIMULATED — node:module registerHooks points the supabase clients at scripts/in-memory-supabase.ts, the
 *       session resolvers at a fixed seat, and the model router at a COUNTED stub; no provider is ever called): per
 *       MODULE one export is called TWICE → exactly two receipts, each with the session actor, the session tenant, the
 *       source's action / subject type / risk class, and each settled (not left "proposed"): it ran twice.
 *   C · a failed write settles `failed`; no session tenant → the write runs exactly as before with no receipt.
 * RED AT THE BASE (e88c1baa): no module calls `ledgered(` → A fails on all 90 wrapped rows and B finds zero receipts.
 * BLIND SPOTS: the live CHECK / FK / RLS are not enforced in memory (the action-name pattern is asserted statically and by
 * test:action-ledger §14); the drive proves the receipt, not each module's business result (each body runs against
 * mostly empty tables and may return its own refusal — that refusal is what the receipt settles on).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { registerHooks } from "node:module"
import ts from "typescript"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const ROOT = process.cwd()
let passed = 0, failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`) }
}
const section = (t: string) => console.log(`\n═══ ${t} ═══`)

// ── the row list (scope of lane 155R9; $S/b2/g12/transaction2-rows.json) ─────────────────────────────────────────────
const WRAPPED: Record<string, string[]> = {
  "app/dashboard/settings/team/tc/tc-actions.ts": ["assignTransactionToCoordinator", "createTransactionCoordinator", "deleteTransactionCoordinator", "unassignTransactionFromCoordinator", "updateTransactionCoordinator"],
  "app/actions/document-kernel-review.ts": ["dismissStageCandidateAction", "resolveAutonomyRatchetAction", "resolveDeadlineConflictAction", "revokeAutonomyGrantAction"],
  "app/actions/link-to-video.ts": ["checkCompliance", "deleteVideo", "generateSocialCaption", "updateVideoScript"],
  "app/actions/partner-orders.ts": ["createLenderApplication", "createTitleOrder", "updateLenderApplicationStatus", "updateTitleOrderStatus"],
  "app/actions/ai-closing-workflow.ts": ["aiGenerateClosingChecklist", "aiTrackClosingMilestones", "completeChecklistItem"],
  "app/actions/ai-marketing-automation.ts": ["generateAIDirectMail", "generateAINewsletter", "generateNewsletterSubjectVariants"],
  "app/actions/ai-transaction-documents.ts": ["checkTransactionDisclosures", "generateTransactionDocumentReminders", "shareDocumentAnalysisWithClient"],
  "app/actions/compliance-phrases.ts": ["addCompliancePhrase", "deleteCompliancePhrase", "updateCompliancePhrase"],
  "app/actions/copilot.ts": ["createTransactionMilestone", "generateDailyGameplan", "handleSuggestionAccepted"],
  "app/actions/custom-video.ts": ["getVideoGuideAction", "suggestVideoWordingAction"],
  "app/actions/documents.ts": ["askDocumentQuestion", "deleteDocument", "getDocumentWithAnalysis"],
  "app/actions/open-house-automation.ts": ["generatePerformanceInsights", "generatePersonalizedInvite", "optimizeOpenHouseTiming"],
  "app/actions/source-analytics.ts": ["emailSourceReport", "generateSourceAIInsights", "generateSourceAISummaryForSource"],
  "app/dashboard/transactions/closing-concierge/actions.ts": ["dismissConciergeAction", "draftConciergeActionEmail", "resolveConciergeAction"],
  "app/actions/ai-communication-hub.ts": ["generateCommunicationSummary", "markConversationRead"],
  "app/actions/ai-insights.ts": ["draftSmartEmail", "generateContactInsights"],
  "app/actions/ai-vendor-management.ts": ["requestVendorReview", "transitionBookingStatus"],
  "app/actions/avatar-video.ts": ["createTeammateExplainerVideo", "getTeammateExplainerReadiness"],
  "app/actions/compliance/dashboard.ts": ["resolveComplianceFlagAction"],
  "app/actions/seller-updates.ts": ["generateSellerUpdateDraft", "saveSellerUpdateDraft"],
  "app/actions/transaction-transparency.ts": ["logTransactionDelay", "markDelaysCommunicated"],
  "app/dashboard/listings/health/actions.ts": ["draftSellerActionEmail", "resolveIntervention"],
  "app/actions/ai-generate.ts": ["generateAIJSON"],
  "app/actions/ai-listing-packet.ts": ["aiPacketQualityCheck"],
  "app/actions/ai-listing-presentation.ts": ["generateListingPresentation"],
  "app/actions/ai-training-coaching.ts": ["analyzeAgentPerformance"],
  "app/actions/ai-voice-transcription.ts": ["generateCallSummaryEmail"],
  "app/actions/assistant.ts": ["generateAssistantSuggestions"],
  "app/actions/buyer-closing-costs.ts": ["getBuyerClosingCosts"],
  "app/actions/call-review-actions.ts": ["flagCallForCompliance"],
  "app/actions/coming-soon-content.ts": ["generateComingSoonContent"],
  "app/actions/compliance/seed-required-docs.ts": ["seedRequiredDocsForBrokerage"],
  "app/actions/deal-health-actions.ts": ["resolveInterventionAction"],
  "app/actions/document-center.ts": ["setClientDocumentVisibility"],
  "app/actions/document-extractions.ts": ["verifyExtractionAction"],
  "app/actions/generate-page-insight.ts": ["generatePageInsight"],
  "app/actions/investor-deals.ts": ["dismissInvestorOffMarketCandidateAction"],
  "app/actions/kernel-bridges.ts": ["generateNetSheetPdf"],
  "app/actions/market-insights.ts": ["generateMarketInsights"],
  "app/actions/marketing/lead-magnet-copy.ts": ["generateLeadMagnetCopyAction"],
  "app/actions/repair-negotiation-copilot.ts": ["repairNegotiationCoPilot"],
  "app/actions/title-portal.ts": ["sendTitleMessageToAgent"],
  "app/actions/transaction-inspections.ts": ["uploadInspectionReportAction"],
  "app/actions/transaction-stage-machine.ts": ["markTransactionLost"],
  "app/actions/transaction-tasks.ts": ["completeTransactionTask"],
  "app/actions/transactions/closing-cost-actual.ts": ["recordClosingCostActualAction"],
  "app/api/admin/transaction-forms/route.ts": ["POST", "PATCH", "DELETE"],
  "app/api/chat/stream/route.ts": ["POST"],
  "app/api/compliance/flags/route.ts": ["POST", "PATCH"],
  "app/api/onboarding/brand/generate-sample/route.ts": ["POST"],
  "app/crm/actions/ask-relationship-ai.ts": ["askRelationshipAI"],
}
/** Rows on the list that are READ-ONLY at the source (an analyzer false positive) — left unwrapped, reported for re-classification. */
const READ_ONLY: Record<string, string> = {
  "app/actions/compliance/dashboard.ts#getComplianceDashboard": "no write in its body; the analyzer's writes come from constants imported from lib/compliance/offer-flag-resolution.ts and a TYPE-ONLY import in lib/kernel/actor-attribution.ts",
  "app/actions/compliance/document-access-audit.ts#getDocumentAccessAudit": "no write in the module; the analyzer's write is lib/video/script-compliance.ts reached through `import type { QueryableClient }` in lib/kernel/actor-attribution.ts",
  "app/actions/transactions/closing-proof.ts#getNoCdaClosingProofAction": "no write in the module; the analyzer's writes come from the constant LIFETIME_HOLD_ACTIVITY_TYPE imported from lib/kernel/lifetime-conversion.ts",
  "app/actions/custom-video.ts#listVideoTopicPoolAction": "calls pickTopics with markUsed: false — the topic bank is written only when markUsed is true (lib/content-intel/topic-bank.ts)",
}

const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const RISK = new Set(["READ", "LOW_RISK_WRITE", "COMMUNICATION", "FINANCIAL", "LEGAL", "IRREVERSIBLE"])
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
/** Positions preserved: comments and string bodies blanked, so `ledgered(` in a tombstone or a fixture is not a call. */
const code = (src: string) => blankStrings(blankComments(src))

interface Wrap { action: string | null; subjectType: string | null; risk: string | null; riskExpr: string; text: string }
/** The export's body span (TS parser on raw source) and the literals of each `ledgered(` call in it (AST — comments never seen). */
function exportFacts(src: string, fn: string): { found: boolean; reaches: boolean; wraps: Wrap[] } {
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decl = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fn && !!s.body && !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  if (!decl?.body) return { found: false, reaches: false, wraps: [] }
  const reaches = /\bledgered\s*\(/.test(code(src).slice(decl.body.getStart(), decl.body.getEnd()))
  const wraps: Wrap[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "ledgered" && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
      const prop = (o: ts.ObjectLiteralExpression, k: string) => o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (p.name as ts.Identifier).text === k)
      const lit = (e?: ts.Expression) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null)
      const what = n.arguments[1]
      const subj = prop(what, "subject")?.initializer
      const riskInit = prop(what, "riskClass")?.initializer
      const risks = riskInit && ts.isConditionalExpression(riskInit) ? [lit(riskInit.whenTrue), lit(riskInit.whenFalse)] : [lit(riskInit)]
      wraps.push({
        action: lit(prop(what, "action")?.initializer), risk: risks.every((r) => r && RISK.has(r)) ? risks.join("|") : null, riskExpr: riskInit?.getText() ?? "",
        subjectType: subj && ts.isObjectLiteralExpression(subj) ? lit(prop(subj, "type")?.initializer) ?? "(computed)" : null, text: n.getText().slice(0, 160),
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(decl.body)
  return { found: true, reaches, wraps }
}
function adapterOf(src: string): string | null {
  const i = src.indexOf("\n/**\n * WAVE 155 (lane 155R9, G12)")
  return i < 0 ? null : src.slice(i)
}
function adapterDefects(a: string | null): string[] {
  if (!a) return ["no adapter"]
  const c = code(a)
  const out: string[] = []
  if (!/\bledgerSessionAction\s*\(/.test(c)) out.push("adapter does not call ledgerSessionAction")
  if (/\b(cycle|idempotencyKey)\s*:/.test(c)) out.push("adapter passes a cycle / idempotency key")
  if (!/import\("@\/lib\/kernel\/action-ledger"\)/.test(a)) out.push("adapter does not dynamic-import action-ledger")
  return out
}

async function main() {
  // ═══ A · static ════════════════════════════════════════════════════════════════════════════════════════════════════
  section("A · every export on the row list reaches the one helper (stripped source)")
  const canonical = adapterOf(raw("app/actions/partner-orders.ts"))
  let rows = 0, reached = 0
  const actions = new Map<string, { file: string; fn: string; wrap: Wrap }>()
  for (const [file, fns] of Object.entries(WRAPPED)) {
    const src = raw(file)
    const a = adapterOf(src)
    check(`${file}: the adapter is the canonical text, calls ledgerSessionAction, passes no cycle / key`, a !== null && a === canonical && adapterDefects(a).length === 0, adapterDefects(a).join("; ") || (a === canonical ? undefined : "adapter text differs from app/actions/partner-orders.ts"))
    for (const fn of fns) {
      rows++
      const f = exportFacts(src, fn)
      const good = f.found && f.reaches && f.wraps.length > 0 && f.wraps.every((w) => w.action && ACTION_RE.test(w.action) && w.risk && w.subjectType)
      if (good) reached++
      check(`${file}#${fn} → ledgered(…) with a three-segment action, a subject and a vocabulary risk class`, good, f.found ? f.wraps.map((w) => `${w.action} / ${w.subjectType} / ${w.riskExpr}`).join(" ; ") || "no ledgered( call in the body" : "export not found")
      for (const w of f.wraps) if (w.action) actions.set(w.action, { file, fn, wrap: w })
    }
  }
  console.log(`  rows wrapped: ${reached} of ${rows} (+ ${Object.keys(READ_ONLY).length} read-only rows left unwrapped and reported)`)
  for (const [id, why] of Object.entries(READ_ONLY)) {
    const [file, fn] = id.split("#")
    const f = exportFacts(raw(file), fn)
    check(`READ-ONLY ${id} carries no receipt (a read is not closed by a wrap): ${why.slice(0, 90)}…`, f.found && !f.reaches)
  }
  section("A · positive controls (the finder still recognises the defect it was written for)")
  const planted = `"use server"\nexport async function bare(id: string) { return db.from("t").update({}).eq("id", id) }\n` +
    `export async function tomb(id: string) {\n  // TOMBSTONE: this used to call ledgered("session", …) — a comment is not a call site\n  const s = "ledgered("\n  return db.from("t").delete().eq("id", id)\n}\n`
  check("POSITIVE CONTROL: a planted export with no wrap is caught", !exportFacts(planted, "bare").reaches)
  check("POSITIVE CONTROL: a wrap that exists only in a comment or a string is caught (stripped source)", !exportFacts(planted, "tomb").reaches)
  check("POSITIVE CONTROL: an adapter carrying a cycle is caught", adapterDefects((canonical ?? "").replace("reasonCode: \"HUMAN_REQUESTED\",", "reasonCode: \"HUMAN_REQUESTED\", cycle: `x:${Date.now()}`,")).includes("adapter passes a cycle / idempotency key"))
  check("POSITIVE CONTROL: a two-segment action name fails the live pattern", !ACTION_RE.test("transaction.update") && ACTION_RE.test("transaction.task.complete"))

  // ═══ B · driven ════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · per module: one export called twice → two receipts, each settled (SIMULATED, in-memory client)")
  const B1 = "b1000000-0000-4000-8000-000000000001", U1 = "a1000000-0000-4000-8000-0000000000a1", AG1 = "a2000000-0000-4000-8000-0000000000a2"
  const ID = (n: number) => `c${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`
  const G = globalThis as any
  G.__R9 = { mem: null as MemClient | null, seat: true, model: 0 }
  const seat = () => G.__R9.seat
  G.__R9.ctx = () => seat()
    ? { userId: U1, agentId: AG1, brokerageId: B1, teamId: null, userType: "broker", role: "broker", platformRole: null, isAuthenticated: true, isImpersonating: false }
    : { userId: "", agentId: null, brokerageId: null, teamId: null, userType: "", role: "", platformRole: null, isAuthenticated: false, isImpersonating: false }
  G.__R9.sess = () => Object.assign(G.__R9.mem, { auth: { getUser: async () => ({ data: { user: seat() ? { id: U1, email: "seat@example.test" } : null }, error: null }) } })
  const wc = `({ ok: true, userId: '${U1}', agentId: '${AG1}', brokerageId: '${B1}', userType: 'broker', isImpersonating: false, impersonatorUserId: null, actorUserId: '${U1}', db: globalThis.__R9.sess() })`
  const real = (p: string) => pathToFileURL(join(ROOT, p)).href
  const STUB: Record<string, string> = {
    "server-only": "export{}",
    "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
    "@/lib/supabase/service": `export * from '${real("lib/supabase/service.ts")}'; export function createServiceClient(){ return globalThis.__R9.sess() }`,
    "@/lib/supabase/server": `export * from '${real("lib/supabase/server.ts")}'; export async function createClient(){ return globalThis.__R9.sess() }; export async function createServerClient(){ return globalThis.__R9.sess() }`,
    "@/lib/identity/get-agent-context": `export * from '${real("lib/identity/get-agent-context.ts")}'; export async function getAgentContext(){ return globalThis.__R9.ctx() }`,
    "@/lib/auth/require-caller": `export * from '${real("lib/auth/require-caller.ts")}'; const c = () => globalThis.__R9.seat ? { ok: true, userId: '${U1}', brokerageId: '${B1}', agentId: '${AG1}', userType: 'broker', supabase: globalThis.__R9.sess() } : { ok: false, reason: 'unauthenticated', error: 'Unauthorized' }; export async function requireCaller(){ return c() }; export async function requireCallerTenant(){ return c() }; export async function requireCallerWithAgent(){ return c() }`,
    "@/lib/platform/acting-context": `export * from '${real("lib/platform/acting-context.ts")}'; export async function resolveWriteContext(){ return ${wc} }; export async function resolveWriteContextForTenant(){ return ${wc} }; export async function resolveActingContext(){ return ${wc} }`,
    "@/lib/portal/require-contact-access": `export * from '${real("lib/portal/require-contact-access.ts")}'; export async function requireContactAccess(){ return { ok: true, userId: '${U1}', brokerageId: '${B1}', isContactSelf: false, userType: 'broker' } }`,
    "@/lib/kernel/api-auth": `export * from '${real("lib/kernel/api-auth.ts")}'; export async function requireAuth(){ return { ok: true, user: { id: '${U1}' }, userId: '${U1}', agentId: '${AG1}', brokerageId: '${B1}', userType: 'broker', platformRole: null } }`,
    "@/lib/kernel/portal-auth": `export * from '${real("lib/kernel/portal-auth.ts")}'; export async function requireTitleActor(){ return { userId: '${U1}', titleUserId: '${ID(90)}', brokerageId: '${B1}', email: 'title@example.test' } }`,
    // the model router: COUNTED, never a provider.
    "@/lib/ai/models": `export * from '${real("lib/ai/models.ts")}'; export async function generateTextRouted(){ globalThis.__R9.model++; return { text: JSON.stringify({ score: 90, violations: [], suggestions: [] }) } }; export async function generateObjectRouted(){ globalThis.__R9.model++; return { object: { reassurance: 'ok', tips: [], suggestions: [], why: 'ok' } } }; export async function streamTextRouted(){ globalThis.__R9.model++; return { textStream: (async function*(){})(), toTextStreamResponse(){ return new Response('') }, toUIMessageStreamResponse(){ return new Response('') } } }`,
    "@/lib/ai/generate": `export * from '${real("lib/ai/generate.ts")}'; export async function generateAIJSON(){ globalThis.__R9.model++; return { data: null, error: 'stub' } }; export function bookedGenerateObject(){ return async function(){ globalThis.__R9.model++; throw new Error('model stub') } }`,
  }
  registerHooks({
    resolve(spec: string, ctx: any, next: any) {
      const body = STUB[spec]
      if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
      return next(spec, ctx)
    },
  })
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.AI_GATEWAY_API_KEY

  const world = () => memSupabase({
    users: [{ id: U1, brokerage_id: B1, user_type: "broker", first_name: "Sam", last_name: "Seat", email: "seat@example.test" }],
    agents: [{ id: AG1, brokerage_id: B1, user_id: U1 }],
    brokerages: [{ id: B1, name: "Fixture Realty" }],
    transaction_coordinators: [{ id: ID(1), brokerage_id: B1, display_name: "TC", max_active_deals: 5, is_active: true }],
    transactions: [{ id: ID(2), brokerage_id: B1, agent_id: AG1, contact_id: ID(3), buyer_contact_id: ID(3), status: "under_contract", property_address: "1 Fixture Way" }],
    contacts: [{ id: ID(3), brokerage_id: B1, agent_id: AG1, first_name: "Pat", email: "pat@example.test" }],
    listings: [{ id: ID(4), brokerage_id: B1, agent_id: AG1, address: "1 Fixture Way" }],
    lender_applications: [{ id: ID(5), brokerage_id: B1, status: "pending" }],
    title_orders: [{ id: ID(6), brokerage_id: B1, status: "ordered" }],
    prohibited_phrases: [{ id: ID(7), brokerage_id: B1, phrase: "exclusive", severity: "warning" }],
    transaction_tasks: [{ id: ID(8), brokerage_id: B1, status: "pending" }],
    video_generation_queue: [{ id: ID(11), organization_id: B1, organization_type: "brokerage", user_id: U1 }],
    transaction_pending_actions: [{ id: ID(9), brokerage_id: B1, status: "open", transaction_id: ID(2) }],
    timeline_transparency: [{ transaction_id: ID(2), brokerage_id: B1 }],
    agent_action_ledger: [],
  }, { uuidIds: true })
  // ONE export per module (the args pass the export's own validation so the wrapped write is reached).
  const DRIVES: Array<{ file: string; fn: string; args: unknown[] }> = [
    { file: "app/dashboard/settings/team/tc/tc-actions.ts", fn: "updateTransactionCoordinator", args: [ID(1), { displayName: "TC", maxActiveDeals: 4, isActive: true }] },
    { file: "app/actions/document-kernel-review.ts", fn: "dismissStageCandidateAction", args: [{ signalId: ID(10) }] },
    { file: "app/actions/link-to-video.ts", fn: "updateVideoScript", args: [ID(11), "A new script"] },
    { file: "app/actions/partner-orders.ts", fn: "updateTitleOrderStatus", args: [ID(6), "clear"] },
    { file: "app/actions/ai-closing-workflow.ts", fn: "completeChecklistItem", args: [{ itemId: ID(12), completedBy: U1 }] },
    { file: "app/actions/ai-marketing-automation.ts", fn: "generateNewsletterSubjectVariants", args: [AG1, "spring market", "buyers"] },
    { file: "app/actions/ai-transaction-documents.ts", fn: "shareDocumentAnalysisWithClient", args: [{ transactionId: ID(2), contactId: ID(3), agentId: AG1, brokerageId: B1, documentLabel: "Inspection", analysisText: "ok" }] },
    { file: "app/actions/compliance-phrases.ts", fn: "deleteCompliancePhrase", args: [ID(7)] },
    { file: "app/actions/copilot.ts", fn: "handleSuggestionAccepted", args: [{ suggestion_id: ID(13), action_type: "call" }] },
    { file: "app/actions/custom-video.ts", fn: "suggestVideoWordingAction", args: [{ field: "hook", text: "x" }] },
    { file: "app/actions/documents.ts", fn: "deleteDocument", args: [ID(14)] },
    { file: "app/actions/open-house-automation.ts", fn: "generatePerformanceInsights", args: [ID(15)] },
    { file: "app/actions/source-analytics.ts", fn: "generateSourceAIInsights", args: [B1, []] },
    { file: "app/dashboard/transactions/closing-concierge/actions.ts", fn: "resolveConciergeAction", args: [ID(9), null] },
    { file: "app/actions/ai-communication-hub.ts", fn: "markConversationRead", args: [ID(16)] },
    { file: "app/actions/ai-insights.ts", fn: "draftSmartEmail", args: [ID(3), "follow up"] },
    { file: "app/actions/ai-vendor-management.ts", fn: "transitionBookingStatus", args: [{ bookingId: ID(17), toStatus: "completed" }] },
    { file: "app/actions/avatar-video.ts", fn: "createTeammateExplainerVideo", args: [{ topic: "x", audience: "" }] },
    { file: "app/actions/compliance/dashboard.ts", fn: "resolveComplianceFlagAction", args: [{ offerId: ID(18), flagKey: "k" }] },
    { file: "app/actions/seller-updates.ts", fn: "saveSellerUpdateDraft", args: [{ listingId: ID(4), body: "update" }] },
    { file: "app/actions/transaction-transparency.ts", fn: "markDelaysCommunicated", args: [ID(2)] },
    { file: "app/dashboard/listings/health/actions.ts", fn: "resolveIntervention", args: [ID(19), null] },
    { file: "app/actions/ai-generate.ts", fn: "generateAIJSON", args: ["prompt"] },
    { file: "app/actions/ai-listing-packet.ts", fn: "aiPacketQualityCheck", args: [ID(20)] },
    { file: "app/actions/ai-listing-presentation.ts", fn: "generateListingPresentation", args: [{ agentId: AG1, propertyData: {} }] },
    { file: "app/actions/ai-training-coaching.ts", fn: "analyzeAgentPerformance", args: [{ agentId: AG1 }] },
    { file: "app/actions/ai-voice-transcription.ts", fn: "generateCallSummaryEmail", args: [{ analysisId: ID(21), recipientType: "agent", agentId: AG1 }] },
    { file: "app/actions/assistant.ts", fn: "generateAssistantSuggestions", args: [{ page: "no_such_page" }] },
    { file: "app/actions/buyer-closing-costs.ts", fn: "getBuyerClosingCosts", args: [{ contactId: ID(3), transactionId: ID(2), refineWithAi: true }] },
    { file: "app/actions/call-review-actions.ts", fn: "flagCallForCompliance", args: [{ callId: ID(22) }] },
    { file: "app/actions/coming-soon-content.ts", fn: "generateComingSoonContent", args: [{ agentId: AG1, listingId: ID(23), daysUntilLaunch: 3, launchDateStr: "soon" }] },
    { file: "app/actions/compliance/seed-required-docs.ts", fn: "seedRequiredDocsForBrokerage", args: [{ brokerageId: B1, scope: "brokerage", scopeId: B1, actorUserId: U1, stateCode: "ZZ" }] },
    { file: "app/actions/deal-health-actions.ts", fn: "resolveInterventionAction", args: [{ interventionId: ID(24) }] },
    { file: "app/actions/document-center.ts", fn: "setClientDocumentVisibility", args: [ID(25), false] },
    { file: "app/actions/document-extractions.ts", fn: "verifyExtractionAction", args: [{ extractionId: ID(26) }] },
    { file: "app/actions/generate-page-insight.ts", fn: "generatePageInsight", args: [{ context: "c", question: "q" }] },
    { file: "app/actions/investor-deals.ts", fn: "dismissInvestorOffMarketCandidateAction", args: [{ contactId: ID(3), candidateId: ID(27) }] },
    { file: "app/actions/kernel-bridges.ts", fn: "generateNetSheetPdf", args: [{ contactId: ID(3), propertyAddress: "1 Fixture Way", scenarios: [] }] },
    { file: "app/actions/market-insights.ts", fn: "generateMarketInsights", args: [] },
    { file: "app/actions/marketing/lead-magnet-copy.ts", fn: "generateLeadMagnetCopyAction", args: [{ magnetType: "generic_form" }] },
    { file: "app/actions/repair-negotiation-copilot.ts", fn: "repairNegotiationCoPilot", args: [{ transactionId: ID(28), side: "buyer" }] },
    { file: "app/actions/title-portal.ts", fn: "sendTitleMessageToAgent", args: [{ transactionId: ID(2), titleUserId: ID(90), message: "hi" }] },
    { file: "app/actions/transaction-inspections.ts", fn: "uploadInspectionReportAction", args: [{ inspectionId: ID(29), transactionId: ID(2), reportUrl: "docref://x", fileName: "r.pdf" }] },
    { file: "app/actions/transaction-stage-machine.ts", fn: "markTransactionLost", args: [{ transactionId: ID(30), brokerageId: B1, lostReason: "r", category: "c", earnestMoneyOutcome: "returned" }] },
    { file: "app/actions/transaction-tasks.ts", fn: "completeTransactionTask", args: [ID(8)] },
    { file: "app/actions/transactions/closing-cost-actual.ts", fn: "recordClosingCostActualAction", args: [{ itemId: ID(31), actualAmount: 100 }] },
    { file: "app/api/admin/transaction-forms/route.ts", fn: "DELETE", args: [{ url: `https://x.test/api/admin/transaction-forms?id=${ID(32)}`, headers: new Headers() }] },
    { file: "app/api/chat/stream/route.ts", fn: "POST", args: [] },
    { file: "app/api/compliance/flags/route.ts", fn: "PATCH", args: [{ json: async () => ({ flagId: ID(33), status: "resolved" }) }] },
    { file: "app/api/onboarding/brand/generate-sample/route.ts", fn: "POST", args: [] },
    { file: "app/crm/actions/ask-relationship-ai.ts", fn: "askRelationshipAI", args: [{ question: "q", contactName: "Pat" }] },
  ]
  const covered = new Set(DRIVES.map((d) => d.file))
  check(`every wrapped module has a drive (${covered.size} of ${Object.keys(WRAPPED).length})`, Object.keys(WRAPPED).every((f) => covered.has(f)), Object.keys(WRAPPED).filter((f) => !covered.has(f)))
  // the chat route needs a conversation it can read in its tenant before it reaches the model.
  const chatSeed = (m: MemClient) => { m.tables.conversations = [{ id: ID(34), brokerage_id: B1, contact_id: null }]; m.tables.messages = [] }
  const chatReq = { json: async () => ({ sessionId: ID(34), message: "hello" }) }
  const titleSeed = (m: MemClient) => { m.tables.transaction_title_escrow = [{ transaction_id: ID(2), title_company_email: "title@example.test", transactions: { brokerage_id: B1, property_address: "1 Fixture Way", agent_id: AG1 } }]; m.tables.title_company_users = [{ id: ID(90), company_name: "Fixture Title" }] }
  for (const d of DRIVES) {
    const w = actions.size ? [...actions.values()].find((x) => x.file === d.file && x.fn === d.fn)?.wrap : undefined
    const mem = world()
    if (d.file === "app/api/chat/stream/route.ts") { chatSeed(mem); d.args = [chatReq] }
    if (d.file === "app/actions/title-portal.ts") titleSeed(mem)
    G.__R9.mem = mem; G.__R9.seat = true
    let threw: string | null = null, said: string | null = null
    try {
      const mod = await import(pathToFileURL(join(ROOT, d.file)).href)
      for (let i = 0; i < 2; i++) { try { const r = await mod[d.fn](...d.args); if (r instanceof Response) said = `${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}` } catch (e) { threw = (e as Error).message } }
    } catch (e) { threw = `import failed: ${(e as Error).message}` }
    const rows2 = (mem.tables.agent_action_ledger ?? []).filter((r: any) => !w?.action || r.action === w.action)
    const ok = rows2.length === 2 && rows2.every((r: any) => r.brokerage_id === B1 && r.actor_user_id === U1 && ACTION_RE.test(r.action) && r.reason_code === "HUMAN_REQUESTED" && RISK.has(r.risk_class) && (!w?.risk || w.risk.split("|").includes(r.risk_class)) && (!w?.subjectType || w.subjectType === "(computed)" || r.subject_type === w.subjectType) && r.status !== "proposed")
    // RESTATED (wave 155, lane 155S2 — CLAUDE.md §2, a waypoint is not a rule): this used to ACCEPT a 500 from
    // app/api/chat/stream/route.ts, because the route read complianceCheck.violations.join(…) on a result that has no
    // `violations` and died before its model call. Lane 155S2 fixed the read (the real shape: score / counts / feedback), so the
    // route is driven like every other wrapped export: two calls, two receipts. A 500 is a failure again.
    check(`${d.file}#${d.fn} ×2 → 2 receipts (session actor + tenant, ${w?.action ?? "?"}, settled)`, ok, { receipts: rows2.map((r: any) => ({ action: r.action, actor: r.actor_user_id, tenant: r.brokerage_id, subject: r.subject_type, risk: r.risk_class, status: r.status })), threw, said })
  }

  // ═══ C · failure and no-seat behavior ══════════════════════════════════════════════════════════════════════════════
  section("C · a failed write settles failed; no session → refused, nothing written, nothing recorded")
  {
    const mem = memSupabase({ transaction_coordinators: [], agent_action_ledger: [] }, { uuidIds: true, refuse: { transaction_coordinators: "new row violates row-level security policy" } })
    G.__R9.mem = mem; G.__R9.seat = true
    const mod = await import(pathToFileURL(join(ROOT, "app/dashboard/settings/team/tc/tc-actions.ts")).href)
    const r = await mod.updateTransactionCoordinator(ID(1), { displayName: "TC", maxActiveDeals: 4, isActive: true })
    const row = (mem.tables.agent_action_ledger ?? [])[0]
    check("a refused coordinator update returns the caller's own refusal unchanged", r?.success === false && /row-level security/.test(String(r?.error)), r)
    check("…and its one receipt settles `failed` with the refusal as its error", (mem.tables.agent_action_ledger ?? []).length === 1 && row?.status === "failed", row)
  }
  {
    const mem = memSupabase({ transaction_coordinators: [{ id: ID(1), brokerage_id: B1 }], agent_action_ledger: [] }, { uuidIds: true })
    G.__R9.mem = mem; G.__R9.seat = false
    const mod = await import(pathToFileURL(join(ROOT, "app/dashboard/settings/team/tc/tc-actions.ts")).href)
    const r = await mod.updateTransactionCoordinator(ID(1), { displayName: "TC2", maxActiveDeals: 4, isActive: true })
    check("no session tenant: no receipt is invented (agent_action_ledger.brokerage_id is NOT NULL)", (mem.tables.agent_action_ledger ?? []).length === 0)
    // RESTATED (wave 155, lane 155S2 — CLAUDE.md §2/§4): this pinned the HOLE ("the write still ran … RLS is the gate"). A
    // "use server" export is a public endpoint and a gate that cannot find a session refuses (fail closed): the write must
    // NOT run. The rule is asserted, not the waypoint.
    check("…and the write is REFUSED — nothing changes without a session (tc-actions requireTcAdmin)", r?.success === false && mem.tables.transaction_coordinators[0].display_name === undefined, r)
  }
  {
    // the ledger table refusing a recording-only claim must not take the action down (no key → unledgered → runs).
    const mem = memSupabase({ transaction_coordinators: [{ id: ID(1), brokerage_id: B1 }] }, { uuidIds: true, missingTables: ["agent_action_ledger"] })
    G.__R9.mem = mem; G.__R9.seat = true
    const mod = await import(pathToFileURL(join(ROOT, "app/dashboard/settings/team/tc/tc-actions.ts")).href)
    const r = await mod.updateTransactionCoordinator(ID(1), { displayName: "TC3", maxActiveDeals: 4, isActive: true })
    check("ledger table absent: the write still runs and returns today's value", r?.success === true && mem.tables.transaction_coordinators[0].display_name === "TC3", r)
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("❌ LEDGER_RECEIPTS_TRANSACTION2_FAIL"); process.exit(1) }
  console.log("✅ LEDGER_RECEIPTS_TRANSACTION2_PASS — every transaction2 session write leaves one receipt through ledgerSessionAction; a second save runs again")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
