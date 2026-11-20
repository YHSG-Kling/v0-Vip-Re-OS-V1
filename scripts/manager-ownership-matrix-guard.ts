#!/usr/bin/env tsx
// scripts/manager-ownership-matrix-guard.ts — `test:manager-ownership-matrix` (wave 152, lane 152I)
// ─────────────────────────────────────────────────────────────────────────────
// Owner (verbatim): "managers, arbiter, orchistators need to be found all over this os and need to abide by the agentic and
// autonmous ai architecture." The owner's arbiter model: INTERCEPT → typed instruction → GOVERN (allow / deny / rewrite / hold)
// → EXECUTE only what is approved → AUDIT every decision.
//
// This guard GENERATES docs/architecture/MANAGER-OWNERSHIP-MATRIX.md from code and the registry — nothing in it is hand-copied:
//   · every OWNER is read from lib/kernel/manager-registry.ts MAINTENANCE_DOMAINS (accountable + coOwners), never typed here;
//   · every HOP (trigger / decision / action / evidence / recovery, and each arbiter step) is a (file, code token) pair resolved in
//     COMMENT-STRIPPED source (scripts/strip-comments.ts — a tombstone is not a call site) to file:line at run time.
//   §A the arbiter model mapped onto the existing planes (each step resolves, or the guard fails)
//   §B the journey ownership matrix (directive 667–680 + the batch-1 / batch-2 capabilities) — every domain real, every hop live
//   §C every MAINTENANCE_DOMAINS row that names wave 152 is owned by a real manager AND sits on a journey whose trigger and
//      consumer hops resolve (POSITIVE CONTROL: a planted wave-152 row on no journey is flagged)
//   §D the doc is the rendering of §A–§C (structure compared exactly; line anchors reported when they drift)
//   §E THE TOOL BOUNDARY, driven for real: the ElevenLabs tool webhook (POST) on an in-memory PostgREST — every refusal audited
//      as a decision, the spoken-confirm hold persisted / released once / expired / never honoured from the model alone, the
//      released state change ledgered at-most-once (adverse: model bypass, replay, mismatched amount, expiry, other session,
//      unreadable hold store)
//   §F PLAY 6 — a tenant's own provider key expires → the delivery is parked → the admin repairs → the parked delivery is
//      processed exactly once by the daily reconciler (lib/kernel/ingress-reconciliation.ts), no hydrate while the key is refused
//   §G WAVE 153 (lane 153H, directive H1/H2) — WHICH POLICY OWNER DECIDES WHICH QUESTION across the six planes + provider budget,
//      commission authority, compliance closing gates, campaign dependencies and incident recovery: every decider is live code,
//      DEFINED in exactly one file (a second definer = a duplicate / conflicting policy reader), has a real consumer, and names its
//      enforcing proof; every governance table is written only by its one writer (an unsafe bypass is a second writer)
//   §H WAVE 153 (lane 153H, directive H6) — THE FULL REGISTRY CENSUS: EVERY MAINTENANCE_DOMAINS row (not a hand-picked set) and
//      every catalogue capability, each traced from code to trigger → manager → policy planes → survivor → writer → persisted
//      state → readback → next action → recovery → outcome, classified honestly (loop-complete / read-surface / partial /
//      writes-unread / untriggered / guard-only / registry-only); every manager owns a live loop; every wave-153 row is a live
//      loop; rendered to docs/architecture/MANAGER-DOMAIN-LOOP-CENSUS.md
// Run: npx tsx scripts/manager-ownership-matrix-guard.ts [--write-doc]   (the summary line is `RESULT: N passed, M failed`)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, posix } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

// ── module interception (only the service-client constructor, server-only and the buyer-financials writer are replaced) ──
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__MOG.svc(...a)",
  "@/app/actions/buyer-lifecycle-core": "export const recordBuyerFinancialVerification = async (a) => globalThis.__MOG.record(a); export const getBuyerFinancialStatus = async () => ({ status: 'unknown' })",
  // WAVE 155 (155S1): the sessionless voice route's confirm_buyer_financials now calls the lib writer directly (its own door —
  // the session action no longer takes an argument identity). The seam follows the call; the rule it counts is unchanged.
  "@/lib/buyer-lifecycle/extensions/financial-verification-schema": "export const emitFinancialVerificationEvent = async (a) => globalThis.__MOG.record(a)",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const strippedCache = new Map<string, string[]>()
function lines(file: string): string[] {
  if (!strippedCache.has(file)) strippedCache.set(file, stripComments(raw(file)).split("\n"))
  return strippedCache.get(file)!
}
/** The first line of COMMENT-STRIPPED source carrying the token (1-based), or 0 when the token is not live code. */
function resolveHop(file: string, token: string): number {
  const ls = lines(file)
  for (let i = 0; i < ls.length; i++) if (ls[i].includes(token)) return i + 1
  return 0
}

// ── the tables (hops are (file, token); owners come from the registry) ──────────────────────────────────────────────────
interface Hop { file: string; token: string }
const h = (file: string, token: string): Hop => ({ file, token })
type Step = "intercept" | "typed instruction" | "policy decision" | "execute" | "audit"
interface Plane { plane: string; steps: Record<Step, Hop[]> }

const ROUTE = "app/api/agent-assistant/tool-call/route.ts"
const ARB = "lib/ai-isa/followup-arbiter.ts"
const ARBITER_PLANES: Plane[] = [
  { plane: "Agent / LLM tool boundary (voice assistant webhook) — zero-code intrusion: the gate is the door, not the handlers", steps: {
    "intercept": [h(ROUTE, "export async function POST")],
    "typed instruction": [h(ROUTE, "instruction = {"), h("lib/voice/tool-registry.ts", "export const voiceTools")],
    "policy decision": [h(ROUTE, "authorityAllows(toolName, sessionUserType)"), h(ROUTE, "async function denyToolCall"), h(ROUTE, "async function governSpokenConfirm")],
    "execute": [h(ROUTE, "ledgerToolCall({"), h(ROUTE, "runTool(toolName, dispatchParams, session, supabase)")],
    "audit": [h(ROUTE, "governance: { ...governance, instruction }"), h("lib/kernel/action-ledger.ts", "export function ledgerToolCall")],
  } },
  { plane: "AI chat tool registries (customer / staff assistants)", steps: {
    "intercept": [h("lib/ai-isa/customer-context-tools.ts", "ledgerToolExecutions(")],
    "typed instruction": [h("lib/ai-isa/persona-tool-policy.ts", "export function riskClassForTool")],
    "policy decision": [h("lib/ai-isa/persona-tool-policy.ts", "export function isToolAllowedAtAuthority"), h("lib/ai-isa/persona-tool-policy.ts", "export const TOOL_APPROVAL_GATE")],
    "execute": [h("lib/kernel/action-ledger.ts", "export function ledgerToolExecutions")],
    "audit": [h("lib/kernel/action-ledger.ts", "export async function withActionLedger")],
  } },
  { plane: "Contact engagement — the follow-up arbiter (whether / when / how / which channel)", steps: {
    "intercept": [h(ARB, "export const ARBITER_PLANNER_ENTRY_POINTS")],
    "typed instruction": [h(ARB, "export interface PlannedTouchInput"), h(ARB, "export interface ArbiterMenu")],
    "policy decision": [h(ARB, "function validateArbiterReply"), h(ARB, "halt_no_lawful_channel"), h(ARB, "export async function countArbiterWaits")],
    "execute": [h("lib/providers/dispatch.ts", "export async function dispatchEmail")],
    "audit": [h(ARB, "export async function recordArbitration")],
  } },
  { plane: "Outbound dispatch — the policy engine separate from the LLM (constitution Law 4 / principle 7)", steps: {
    "intercept": [h("lib/providers/dispatch.ts", "export async function dispatchSms")],
    "typed instruction": [h("lib/kernel/action-ledger.ts", "export interface ActionContext")],
    "policy decision": [h("lib/providers/dispatch.ts", "async function autonomyGate("), h("lib/providers/dispatch.ts", "consentScopeFor(")],
    "execute": [h("lib/providers/dispatch.ts", "export async function dispatchDirectMail")],
    "audit": [h("lib/providers/dispatch.ts", "withActionLedger(")],
  } },
  { plane: "Supervisor → worker — manager delegation on the mission runtime", steps: {
    "intercept": [h("lib/kernel/manager-delegation.ts", "export async function requestDelegation")],
    "typed instruction": [h("lib/kernel/manager-delegation.ts", "export const DELEGATION_TRANSITIONS")],
    "policy decision": [h("lib/kernel/manager-delegation.ts", "export function canDelegationTransition"), h("lib/kernel/manager-delegation.ts", "export async function escalateDelegation")],
    "execute": [h("lib/kernel/manager-delegation.ts", "export async function startDelegationWork")],
    "audit": [h("lib/kernel/manager-delegation.ts", "manager_delegation_events")],
  } },
  { plane: "Hold for a human — persisted approvals with an SLA (never released by the model)", steps: {
    "intercept": [h("lib/kernel/approval-authority.ts", "export async function approverFor")],
    "typed instruction": [h("lib/kernel/approval-authority.ts", "export const APPROVAL_ASSET_KINDS")],
    "policy decision": [h("lib/kernel/approval-authority.ts", "export async function requirePublishApprover")],
    "execute": [h("lib/kernel/approval-pending.ts", "NEWSLETTER_PENDING_APPROVAL_STATUSES")],
    "audit": [h("lib/kernel/approval-sla.ts", "export function evaluateApprovalSla")],
  } },
]

type HopKey = "trigger" | "decision" | "action" | "evidence" | "recovery"
interface Journey { journey: string; domains: string[]; hops: Record<HopKey, Hop>; note?: string }
const JOURNEYS: Journey[] = [
  { journey: "Provider connection / health (Play 6)", domains: ["tenant_provider_connections", "tenant_facing_copy", "immediate_operations"], hops: {
    trigger: h("app/api/webhooks/batchdata-smart-search/route.ts", "ingestTenantWebhookDelivery("),
    decision: h("lib/providers/tenant-provider-connections.ts", "export function deriveTenantProviderConnectionState"),
    action: h("lib/kernel/immediate-operations.ts", "export async function reportOperationOutcome"),
    evidence: h("lib/kernel/immediate-operations.ts", "export async function handleOperationFailureEscalated"),
    recovery: h("lib/kernel/ingress-reconciliation.ts", "async function replayParkedTenantPush"),
  } },
  { journey: "Raw source acquisition / dedup / freshness", domains: ["acquisition_door", "rawdata_producer_contract", "spend_backpressure", "apify_run_cursor"], hops: {
    trigger: h("lib/lead-pipeline/source-discovery-planner.ts", "export function planSourceDiscovery"),
    decision: h("lib/lead-pipeline/source-discovery-planner.ts", "export function paidPullApproval"),
    action: h("lib/kernel/scraping.ts", "export async function ingestRawSourceBatch"),
    evidence: h("lib/lead-pipeline/pre-pull-dedup.ts", "export function planPrePullDedup"),
    recovery: h("lib/lead-pipeline/pipeline-processor.ts", "setStatus(supabase, rawRecordId, 'held_stale'"),
  } },
  { journey: "Existing Contact shows new intent (Play 2)", domains: ["followup_arbiter", "readiness_dimensions", "saved_home_alerts"], hops: {
    trigger: h("lib/intent/movement-signals.ts", "function reassessExistingContact"),
    decision: h(ARB, "export async function respondToLifeChangeSignal"),
    action: h(ARB, "export async function arbitrateAndRecordExperience"),
    evidence: h(ARB, "export async function recordArbitration"),
    recovery: h(ARB, "export async function routeToAgent"),
  } },
  { journey: "Campaign, mail and QR launch (Play 3)", domains: ["qr_registry", "direct_mail_rendering"], hops: {
    trigger: h("lib/marketing/qr-governance.ts", "export async function mintGovernedQr"),
    decision: h("lib/marketing/qr-contract.ts", "export function validateQrDestination"),
    action: h("lib/direct-mail/mail-piece-rules.ts", "function decideMailQrRegion"),
    evidence: h("lib/marketing/qr-governance.ts", "marketing.qr.mint"),
    recovery: h("lib/marketing/qr-governance.ts", "export async function changeQrLifecycle"),
  } },
  { journey: "QR interest / event response", domains: ["qr_registry", "followup_arbiter"], hops: {
    trigger: h("app/api/qr/scan/route.ts", "KernelEvent.QR_SCAN_RECEIVED"),
    decision: h("lib/marketing/qr-governance.ts", "export async function classifyScanForCode"),
    action: h("lib/kernel/event-reactor.ts", "KernelEvent.QR_SCAN_RECEIVED"),
    evidence: h("app/api/qr/scan/route.ts", "qr_scan_events"),
    recovery: h("lib/marketing/qr-contract.ts", "export function qrUnavailableNotice"),
  } },
  { journey: "ROI performance feedback", domains: ["roi_outcome_ledger", "outcome_attribution"], hops: {
    trigger: h("lib/intelligence/roi-ledger.ts", "export async function loadLedgerAttribution"),
    decision: h("lib/intelligence/roi-ledger.ts", "review_reduce"),
    action: h("lib/intelligence/roi-ledger.ts", "export async function loadRoiOutcomeLedger"),
    evidence: h("lib/intelligence/roi-ledger.ts", "export function realizedReturnOnMarketingSpend"),
    recovery: h("lib/intelligence/roi-ledger.ts", "repair_attribution"),
  }, note: "the ROI reader is PULL-based: an expense or a closed deal is read at request time, so no push consumer edge is needed (an expense_created consumer would be ceremony)" },
  { journey: "Receipt / document ingestion (Play 5)", domains: ["receipt_to_books"], hops: {
    trigger: h("lib/documents/receipt-intake.ts", "export async function intakeReceipt"),
    decision: h("lib/documents/receipt-rules.ts", "export function decideReceiptPosting"),
    action: h("app/actions/financials.ts", "function logScopedExpense"),
    evidence: h("lib/documents/receipt-intake.ts", "finance.expense.post_from_document"),
    recovery: h("lib/documents/receipt-rules.ts", "export function reversalVerdict"),
  } },
  { journey: "Contract addenda and e-sign (Play 4)", domains: ["transaction_addenda", "addendum_signature_request"], hops: {
    trigger: h("app/actions/buyer-offer/request-addendum-signatures.ts", "export async function proposeContractAddendum"),
    decision: h("lib/esign/addendum-signature-rules.ts", "export function planAddendumSignatureRouting"),
    action: h("app/actions/buyer-offer/request-addendum-signatures.ts", "export async function requestAddendumSignatures"),
    evidence: h("lib/offers/governing-terms.ts", "export async function recordContractTermsVersion"),
    recovery: h("lib/esign/addendum-signature-request.ts", "function sweepAddendumSignatureRequests"),
  } },
  { journey: "Settlement / Closing Disclosure mismatches", domains: ["closing_compliance", "transaction_addenda", "settlement_reconciliation"], hops: {
    trigger: h("lib/transactions/closing-compliance.ts", "export async function runClosingCompliance"),
    decision: h("lib/transactions/cda-closing-policy.ts", "export function reconcileSettlement"),
    action: h("lib/offers/closing-cost-accuracy.ts", "export async function reconcileClosingSettlement"),
    evidence: h("lib/offers/closing-cost-accuracy.ts", "compliance.settlement_reconciliation.snapshot"),
    recovery: h("lib/offers/closing-cost-accuracy.ts", "export async function closingSettlementGate"),
  }, note: "wave 152 lane 152G (integrated): the term comparison runs first, the reconciliation at its tail; the close gate recomputes and holds a no-CDA close until it is green" },
  { journey: "CDA setting / closing payout", domains: ["cda_closing_flow", "cda_effective_terms"], hops: {
    trigger: h("app/actions/brokerage-cda-setup.ts", "export async function setBrokerageCdaSettingAction"),
    decision: h("lib/transactions/cda-closing-policy.ts", "export function resolveCdaMode"),
    action: h("lib/transactions/cda-closing-policy.ts", "export function resolvePayoutTiming"),
    evidence: h("lib/transactions/cda-closing-policy.ts", "export function cdaFigureGate"),
    recovery: h("lib/transactions/cda-closing-policy.ts", "CDA_DEADLINE_ESCALATE_HOURS"),
  }, note: "batch 2 lane 152H owns the policy-change transition; the guard re-derives the hops on the integrated tree" },
  { journey: "Customer questions / support", domains: ["support_ticket_loop", "support_console"], hops: {
    trigger: h("lib/support/ticket-triage.ts", "export async function openInboundSupportTicket"),
    decision: h("lib/support/ticket-triage.ts", "export async function triageSupportTicket"),
    action: h("lib/support/ticket-triage.ts", "export async function handleSupportTicketTriaged"),
    evidence: h("lib/support/ticket-triage.ts", "export function tenantFacingGate"),
    recovery: h("lib/support/ticket-triage.ts", "export async function notifyTicketAnsweringSide"),
  } },
  { journey: "Scheduled health checks (durable ticks)", domains: ["cron_dispatch", "ingress_continuity"], hops: {
    trigger: h("lib/kernel/cron-dispatch.ts", "CRON_REGISTRY"),
    decision: h("lib/kernel/ingress-continuity.ts", "export function decideIngressAction"),
    action: h("lib/kernel/ingress-reconciliation.ts", "export async function runIngressReconciliation"),
    evidence: h("lib/kernel/ingress-reconciliation.ts", "recordSelfHeal(svc, {"),
    recovery: h("lib/kernel/ingress-reconciliation.ts", "notifyPlatformStaff("),
  } },
  { journey: "Agent / LLM tool calls (voice assistant)", domains: ["manager_ownership_matrix", "agent_assistant_tool_call_observability"], hops: {
    trigger: h(ROUTE, "export async function POST"),
    decision: h(ROUTE, "async function governSpokenConfirm"),
    action: h(ROUTE, "ledgerToolCall({"),
    evidence: h(ROUTE, "governance: { ...governance, instruction }"),
    recovery: h(ROUTE, "async function denyToolCall"),
  } },
  { journey: "Review ask at a verified closing (row 73)", domains: ["review_ask_at_closing", "followup_arbiter"], hops: {
    trigger: h("app/api/cron/review-request-on-close/route.ts", "askForReviewAtClose("),
    decision: h("lib/reputation/review-ask.ts", "planner: \"review_ask\""),
    action: h("lib/reputation/review-ask.ts", "deps.dispatchEmail("),
    evidence: h("lib/reputation/review-ask.ts", "KernelEvent.REVIEW_REQUEST_SENT"),
    recovery: h("lib/reputation/review-ask.ts", "\"arbiter_handoff\""),
  } },
]

interface Play { play: string; proofs: string[]; hops: Hop[]; truth: string }
const PLAYS: Play[] = [
  { play: "1 · Early-move neighborhood concierge", proofs: ["test:early-opportunity-plays", "test:qr-registry", "test:roi-outcome-ledger"], truth: "SIMULATED per hop (each proof drives its own leg); no single chained simulation across all hops", hops: [h("lib/acquisition-plays/runner.ts", "export async function runEarlyOpportunityPlays"), h("lib/acquisition-plays/moving-corridor.ts", "export async function runMovingCorridorPlay"), h("lib/kernel/brand-voice.ts", "loadSenderVoiceBrief"), h("lib/marketing/qr-governance.ts", "export async function mintGovernedQr"), h(ARB, "export async function arbitrateAndRecordExperience"), h("lib/intelligence/roi-ledger.ts", "export async function loadRoiOutcomeLedger")] },
  { play: "2 · Re-engaging a current Contact", proofs: ["test:readiness-dimensions", "test:saved-home-alerts", "test:intent-driven-followup"], truth: "SIMULATED (re-assessment → arbiter → engagement recorded; no second lead record)", hops: [h("lib/intent/movement-signals.ts", "function reassessExistingContact"), h("lib/property-alerts/saved-home-watch.ts", "export async function watchSavedHomes"), h(ARB, "export async function respondToLifeChangeSignal"), h(ARB, "export async function recordArbitration")] },
  { play: "3 · Smart mail economics", proofs: ["test:direct-mail-rendering", "test:marketing-qr", "test:roi-outcome-ledger"], truth: "SIMULATED (Lob injected; scans in-app; no live mailing)", hops: [h("lib/direct-mail/mail-piece-rules.ts", "function decideMailQrRegion"), h("lib/marketing/qr-governance.ts", "export async function mintGovernedQr"), h("app/api/qr/scan/route.ts", "qr_scan_events"), h("lib/intelligence/roi-ledger.ts", "export async function loadRealizedCampaignRevenue")] },
  { play: "4 · Contract change without chaos", proofs: ["test:transaction-addenda", "test:addendum-signatures", "test:closing-compliance"], truth: "SIMULATED (e-sign provider injected; the corrected CD is the responsible party's — requested, verified, never issued here)", hops: [h("lib/documents/field-extraction-ledger.ts", "function readDocumentExtractions"), h("lib/transactions/closing-compliance-core.ts", "function compareDealRecordTerms"), h("lib/transactions/closing-compliance.ts", "compliance_correction"), h("lib/offers/governing-terms.ts", "export async function recordContractTermsVersion"), h("lib/transactions/closing-compliance.ts", "export async function completeCorrectionRequests")] },
  { play: "5 · Brokerage receipt to books", proofs: ["test:receipt-intelligence"], truth: "SIMULATED (vision injected; posting through THE expense writer under withActionLedger)", hops: [h("lib/documents/receipt-intake.ts", "export async function intakeReceipt"), h("lib/documents/receipt-rules.ts", "export function findReceiptDuplicates"), h("lib/documents/receipt-rules.ts", "export function decideReceiptPosting"), h("app/actions/financials.ts", "function logScopedExpense"), h("lib/documents/receipt-intake.ts", "finance.expense.post_from_document")] },
  { play: "6 · Provider outage with transparent service", proofs: ["test:tenant-provider-connections", "test:manager-ownership-matrix"], truth: "SIMULATED here end to end (§F): parked → refused key waits (no hydrate) → repaired → processed once", hops: [h("lib/providers/tenant-provider-connections.ts", "export async function ingestTenantWebhookDelivery"), h("lib/kernel/immediate-operations.ts", "export async function handleOperationFailureEscalated"), h("lib/kernel/ingress-reconciliation.ts", "async function replayParkedTenantPush"), h("lib/kernel/ingress-reconciliation.ts", "export async function runIngressReconciliation")] },
]

/** Semantic domain events (directive 701–707) → the edge in code. A pull-based reader is named as such — no ceremonial consumer. */
const EVENT_EDGES: Array<{ event: string; source: Hop; consumer: Hop; kind: "push" | "read-time" | "manager-signal" }> = [
  { event: "qr_scanned", source: h("app/api/qr/scan/route.ts", "KernelEvent.QR_SCAN_RECEIVED"), consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.QR_SCAN_RECEIVED"), kind: "push" },
  { event: "qr_minted / qr_destination_changed", source: h("lib/marketing/qr-governance.ts", "marketing.qr.mint"), consumer: h("lib/marketing/qr-governance.ts", "export async function loadQrActivity"), kind: "read-time" },
  { event: "receipt_extracted / expense_posted", source: h("lib/documents/receipt-intake.ts", "finance.expense.post_from_document"), consumer: h("lib/intelligence/roi-ledger.ts", "export async function loadRoiOutcomeLedger"), kind: "read-time" },
  { event: "contract_terms_changed / addendum_executed", source: h("lib/offers/governing-terms.ts", "export async function recordContractTermsVersion"), consumer: h("lib/transactions/closing-compliance.ts", "export async function runClosingCompliance"), kind: "push" },
  { event: "addendum_signature_requested", source: h("lib/esign/addendum-signature-request.ts", "contract.addendum_signatures.request"), consumer: h("lib/esign/addendum-signature-request.ts", "function sweepAddendumSignatureRequests"), kind: "read-time" },
  { event: "provider_connection_degraded", source: h("lib/kernel/immediate-operations.ts", "export async function reportOperationOutcome"), consumer: h("lib/kernel/immediate-operations.ts", "export async function handleOperationFailureEscalated"), kind: "manager-signal" },
  { event: "parked delivery → repaired connection", source: h("lib/providers/tenant-provider-connections.ts", "eventKind: \"smart-search-match\""), consumer: h("lib/kernel/ingress-reconciliation.ts", "async function replayParkedTenantPush"), kind: "push" },
  { event: "campaign_outcome_recorded", source: h("lib/campaigns/roi-calculator.ts", "KernelEvent.CAMPAIGN_ROI_UPDATED"), consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.CAMPAIGN_ROI_UPDATED"), kind: "push" },
]

// ══ §G tables — WHICH POLICY OWNER DECIDES WHICH QUESTION (directive H1/H2). One decider per question; `local` = a module-private
//    decider whose consumers live in its own file (the gate IS the door). The proof named is the one that drives the decider. ══
interface PolicyOwner { question: string; plane: string; decider: Hop; name: string; local?: boolean; proof: string }
const po = (question: string, plane: string, file: string, token: string, name: string, proof: string, local = false): PolicyOwner => ({ question, plane, decider: h(file, token), name, proof, local })
const POLICY_OWNERS: PolicyOwner[] = [
  po("May this AI tool run at this actor's authority rung?", "1 · tool boundary", "lib/ai-isa/persona-tool-policy.ts", "export function isToolAllowedAtAuthority", "isToolAllowedAtAuthority", "test:persona-tool-realism"),
  po("Which risk class (and so which approval gate) does a tool carry?", "2 · persona / tool risk", "lib/ai-isa/persona-tool-policy.ts", "export function riskClassForTool", "riskClassForTool", "test:persona-tool-realism"),
  po("Which tools does this persona get at all?", "2 · persona / tool risk", "lib/ai-isa/persona-tool-policy.ts", "export function selectToolsForPersona", "selectToolsForPersona", "test:persona-tool-realism"),
  po("May a SPOKEN state change execute (only a persisted read-back hold, never the model's own confirm)?", "1 · tool boundary", ROUTE, "async function governSpokenConfirm", "governSpokenConfirm", "test:manager-ownership-matrix", true),
  po("Whether / when / how / on which channel to touch ONE Contact (planned touches)?", "3 · Contact engagement", ARB, "export async function arbitratePlannedTouch", "arbitratePlannedTouch", "test:arbiter-timing"),
  po("Who owns a LIVE conversation turn (person vs AI; no planning call on the fast path)?", "3 · Contact engagement", ARB, "export function interactiveTurnVerdict", "interactiveTurnVerdict", "test:inbound-communication"),
  po("Is a person already in this conversation (one owner per exchange)?", "3 · Contact engagement", ARB, "export async function loadConversationOwnership", "loadConversationOwnership", "test:arbiter-timing"),
  po("May an autonomous outbound leave under the tenant's autonomy grant?", "4 · outbound dispatch", "lib/providers/dispatch.ts", "async function autonomyGate(", "autonomyGate", "test:autonomy-gate", true),
  po("What has this person consented to, per channel and purpose?", "4 · outbound dispatch", "lib/kernel/compliance/require-contact-consent.ts", "export async function consentScopeFor", "consentScopeFor", "test:egress-send-guard"),
  po("Is it inside the legal calling / texting window (TCPA quiet hours)?", "4 · outbound dispatch", "lib/communication/call-compliance.ts", "export function checkQuietHours", "checkQuietHours", "test:outbound-call-gates"),
  po("Which manager owns a requested capability (only that owner may be asked)?", "5 · manager delegation", "lib/agentic-os/capability-ownership.ts", "export const CAPABILITY_MANAGER", "CAPABILITY_MANAGER", "test:manager-delegation"),
  po("May a delegation move from one status to another?", "5 · manager delegation", "lib/kernel/manager-delegation.ts", "export function canDelegationTransition", "canDelegationTransition", "test:manager-delegation", true),
  po("Would this ask close a wait-for cycle between managers (deadlock)?", "5 · manager delegation", "lib/kernel/manager-delegation.ts", "function delegationWaitCycle", "delegationWaitCycle", "test:os-arbitration-canaries", true),
  po("What authority rung does a manager hold in this tenant?", "5 · manager delegation", "lib/managers/autonomy-gate.ts", "export async function resolveAgentAuthorityLevel", "resolveAgentAuthorityLevel", "test:autonomy-gate"),
  po("Which manager is accountable for a domain?", "5 · manager delegation", "lib/kernel/manager-registry.ts", "export function resolveMaintenanceManager", "resolveMaintenanceManager", "test:manager-ownership"),
  po("Who approves this tenant's asset (owner / team lead / brokerage only by policy)?", "6 · human approval", "lib/kernel/approval-authority.ts", "export async function approverFor", "approverFor", "test:ads-tv-connections"),
  po("Is a pending approval overdue (SLA → escalation)?", "6 · human approval", "lib/kernel/approval-sla.ts", "export function evaluateApprovalSla", "evaluateApprovalSla", "test:social-approval"),
  po("Is this subscription entitled to (and able to afford) a paid lane?", "resource · entitlement", "lib/billing/billing-access.ts", "export async function mayUseAndAfford", "mayUseAndAfford", "test:billing-access"),
  po("Does this spend fit the tenant's monthly vendor ceiling (all providers, one scope)?", "resource · provider budget", "lib/vendor-governance/budget-gate.ts", "export async function checkVendorBudget", "checkVendorBudget", "test:os-arbitration-canaries"),
  po("Throttle / defer a pooled paid want against its approved ceiling?", "resource · provider budget", "lib/vendor-governance/budget-eval.ts", "export function decideSpendBackpressure", "decideSpendBackpressure", "test:spend-backpressure"),
  po("May this paid pull run (approved line, value verdict)?", "resource · acquisition spend", "lib/lead-pipeline/source-discovery-planner.ts", "export function paidPullApproval", "paidPullApproval", "test:acquisition-door"),
  po("Is this record already held (never pay twice for one person / property)?", "resource · acquisition spend", "lib/lead-pipeline/pre-pull-dedup.ts", "export function planPrePullDedup", "planPrePullDedup", "test:os-arbitration-canaries"),
  po("Which provider serves a capability (health-aware route table)?", "resource · provider route", "lib/ai-isa/property-lookup-rail.ts", "export function routeCapability", "routeCapability", "test:provider-cost-routing"),
  po("May this seat change commission terms (attached seat / admin, never after close)?", "money · commission authority", "lib/commission/commission-term-change.ts", "function termChangeAuthority(", "termChangeAuthority", "test:commission-term-change", true),
  po("May the settlement / no-CDA close proceed (reconciled figures)?", "closing · compliance gates", "lib/offers/closing-cost-accuracy.ts", "export async function closingSettlementGate", "closingSettlementGate", "test:closing-compliance"),
  po("Are the CDA's figures the governing figures?", "closing · compliance gates", "lib/transactions/cda-closing-policy.ts", "export function cdaFigureGate", "cdaFigureGate", "test:cda-closing-flow"),
  po("Is the file closing-ready (required documents, terms, TRID, insurance)?", "closing · compliance gates", "lib/transactions/closing-compliance-core.ts", "export function buildClosingReadiness", "buildClosingReadiness", "test:closing-readiness"),
  po("When may the loan consummate (CD receipt + three business days)?", "closing · lender TRID", "lib/compliance/trid-disclosure-clock.ts", "export function earliestConsummationDate", "earliestConsummationDate", "test:trid-clock"),
  po("Does an executed contract change re-open compliance, settlement and the CDA?", "closing · contract changes", "lib/offers/governing-terms-consequences.ts", "export async function afterExecutedContractChange", "afterExecutedContractChange", "test:transaction-addenda"),
  po("When does the next campaign step of an enrolled Contact go (each step after the first asks the arbiter, planner `sequence_step`)?", "campaign dependency", "lib/campaign-sequences/step-executor.ts", "export async function executeSequenceStep", "executeSequenceStep", "test:arbiter-timing"),
  po("Replay, wait or abandon a parked inbound delivery (incident recovery)?", "incident recovery", "lib/kernel/ingress-continuity.ts", "export function decideIngressAction", "decideIngressAction", "test:doc-kernel"),
  po("Which self-heal tier may a flow repair itself under?", "incident recovery", "lib/kernel/self-heal-ledger.ts", "export const FLOW_CONTRACTS", "FLOW_CONTRACTS", "test:doc-kernel"),
  po("Which governance verb (ALLOW … CANCEL) does a plane's own verdict read as?", "evidence · H3 contract", "lib/kernel/action-ledger.ts", "function governanceVerb(", "governanceVerb", "test:os-arbitration-canaries", true),
]

/** §G2 — every governance table and its ONE writer (an extra writer is an unsafe bypass of that plane's state machine / evidence). */
const GOVERNANCE_WRITERS: Array<{ table: string; writers: string[]; why: string }> = [
  { table: "manager_delegations", writers: ["lib/kernel/manager-delegation.ts"], why: "the delegation state machine (CAS on status)" },
  { table: "manager_delegation_events", writers: ["lib/kernel/manager-delegation.ts"], why: "append-only delegation evidence" },
  { table: "missions", writers: ["lib/kernel/missions.ts"], why: "the mission state machine" },
  { table: "mission_events", writers: ["lib/kernel/missions.ts"], why: "append-only mission evidence" },
  { table: "agent_action_ledger", writers: ["lib/kernel/action-ledger.ts", "lib/outcomes/reconciliation-ledger.ts"], why: "the ledger; the reconciler is the ONE settler of `unknown` rows from provider truth" },
  { table: "tenant_policy_versions", writers: ["lib/kernel/tenant-policy.ts"], why: "the one policy version appender" },
]

// ══ §H — THE CENSUS ENGINE (pure over the repo; comment-BLANKED source so a tombstone is never a call site, CLAUDE.md §2) ══
const CENSUS_DOC = "docs/architecture/MANAGER-DOMAIN-LOOP-CENSUS.md"
function walkSrc(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = `${dir}/${e}`
    let isDir = false
    try { isDir = statSync(join(ROOT, p)).isDirectory() } catch { continue }
    if (isDir) walkSrc(p, out); else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}
interface FileFacts { writes: Set<string>; reads: Set<string>; planes: Set<string>; next: boolean; recovery: boolean; outcome: boolean; imports: string[]; useServer: boolean }
const PLANE_RES: Array<[string, RegExp]> = [
  ["A", /\b(?:isToolAllowedAtAuthority|selectToolsForPersona|riskClassForTool|resolveAgentAuthorityLevel|requireCallerTenant|getAgentContext|authorityAllows|requireLenderVendorActor|resolveViewerHierarchy)\s*\(/],
  ["E", /\b(?:arbitratePlannedTouch|arbitrateFollowUp|arbitrateAndRecordExperience|respondToLifeChangeSignal|interactiveTurnVerdict|engageContact)\s*\(/],
  ["D", /\b(?:dispatchEmail|dispatchSms|dispatchDirectMail|dispatchPush|dispatchVoiceCall|dispatchSocial)\s*\(/],
  ["G", /\b(?:requestDelegation|acceptDelegation|escalateDelegation|returnDelegationResult|publishManagerSignal|escalateMission|transitionMission)\s*\(/],
  ["P", /\b(?:approverFor|requirePublishApprover|evaluateApprovalSla)\s*\(|["']approval_items["']/],
  ["R", /\b(?:mayUseAndAfford|checkVendorBudget|decideSpendBackpressure|paidPullApproval|planPrePullDedup|meterVendorSpend|routeCapability|bookedGenerateObject|logAIUsage)\s*\(/],
  ["C", /\b(?:closingSettlementGate|cdaFigureGate|runClosingCompliance|loadClosingReadiness|buildClosingReadiness|assessTridReadiness|requestCommissionTermChange)\s*\(/],
]
const NEXT_RE = /\b(?:emitKernelEvent|publishManagerSignal|notifyPlatformStaff|createNotification|insertNotification)\s*\(|KernelEvent\.[A-Z_]+|\.from\(\s*["'](?:notifications|transaction_tasks|tasks|ai_autopilot_actions)["']\s*\)\s*\.(?:insert|upsert)/
const RECOVERY_RE = /\b(?:recordSelfHeal|reportOperationOutcome|notifyPlatformStaff|escalate[A-Z]\w*|retry\w*|sweep[A-Z]\w*|reap[A-Z]\w*)\s*\(|["'](?:ingress_dead_letters|self_heal_events)["']/
const OUTCOME_RE = /\b(?:withActionLedger|recordNonAction|ledgerToolCall|ledgerToolExecutions|recordArbitration|recordOutcomeClaim|ingestProviderTruth|attachAction|completeMission|recordTermChange|appendTenantPolicyVersion)\s*\(/
const WRITE_RE = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)\s*\.(?:insert|update|upsert|delete)\b/g
const READ_RE = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)\s*\.select\b/g
const IMPORT_RE = /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']/g
const DYN_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g

type CensusClass = "loop-complete" | "read-surface" | "partial" | "writes-unread" | "untriggered" | "guard-only" | "registry-only" | "proof-unregistered"
interface DomainLoop {
  key: string; manager: string; proof: string; cls: CensusClass; why: string
  survivors: string[]; trigger: { kind: string; file: string; hops: number } | null; planes: string[]
  writes: string[]; readback: number; next: boolean; recovery: boolean; outcome: boolean
}
/** PURE — the one classifier (driven directly by the positive controls). */
function classifyLoop(f: { proofRegistered: boolean; survivors: number; proofFirstParty: boolean; trigger: boolean; writes: number; provider: boolean; unreadWrites: number; readback: boolean; next: boolean; recovery: boolean; outcome: boolean }): { cls: CensusClass; why: string } {
  if (!f.proofRegistered) return { cls: "proof-unregistered", why: "its proof is not a package.json script" }
  if (f.survivors === 0) return f.proofFirstParty ? { cls: "guard-only", why: "a code-discipline domain: the proof judges source, no runtime survivor is named" } : { cls: "registry-only", why: "no survivor file is named in the row and its proof drives no first-party module" }
  if (!f.trigger) return { cls: "untriggered", why: "no route / action / cron / webhook / page / reactor reaches the survivor (unconsumed capability)" }
  if (f.writes === 0 && !f.provider) return { cls: "read-surface", why: "decides / renders from existing state; nothing to persist or close" }
  if (!f.provider && f.writes > 0 && f.unreadWrites === f.writes) return { cls: "writes-unread", why: "every table it writes has no reader outside the writer (unconsumed state)" }
  if (!f.readback && !f.provider) return { cls: "partial", why: "no readback of what it writes" }
  if (!f.next && !f.recovery && !f.outcome) return { cls: "partial", why: "no next action, recovery or evidence after the write" }
  return { cls: "loop-complete", why: "trigger → policy → writer → state → readback → next / recovery / evidence all present" }
}

const DOC = "docs/architecture/MANAGER-OWNERSHIP-MATRIX.md"
const WAVE152 = /\bwave 152\b/i
const WAVE153 = /\bwave 153\b/i

async function main() {
  const reg = await import("../lib/kernel/manager-registry")
  const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
  const fmt = (x: Hop) => { const n = resolveHop(x.file, x.token); return n ? `\`${x.file}:${n}\`` : `MISSING \`${x.file}\` · ${x.token}` }

  // ══ §A ══
  section("A · the owner's arbiter model, mapped onto the existing planes (every step resolves in stripped source)")
  check("POSITIVE CONTROL: the hop resolver finds live code and refuses a token that only lives in a comment",
    resolveHop(ROUTE, "export async function POST") > 0 && resolveHop(ROUTE, "Constant-time comparison to thwart timing attacks") === 0)
  check("POSITIVE CONTROL: a token that exists nowhere does not resolve", resolveHop(ROUTE, "governNothingAtAll_152I") === 0)
  for (const p of ARBITER_PLANES) {
    const missing = (Object.entries(p.steps) as Array<[Step, Hop[]]>).flatMap(([s, hops]) => hops.filter((x) => !resolveHop(x.file, x.token)).map((x) => `${s}: ${x.file} · ${x.token}`))
    check(`${p.plane.split(" — ")[0]}: intercept → typed instruction → decision → execute → audit all resolve`, missing.length === 0, missing.join(" | "))
  }

  // ══ §B ══
  section("B · the journey ownership matrix — owners from MAINTENANCE_DOMAINS, hops from live code")
  for (const j of JOURNEYS) {
    const bad = j.domains.filter((d) => !reg.MAINTENANCE_DOMAINS[d] || !(reg.MAINTENANCE_DOMAINS[d].manager in reg.MANAGERS))
    const unproved = j.domains.filter((d) => reg.MAINTENANCE_DOMAINS[d] && !pkg.scripts[reg.MAINTENANCE_DOMAINS[d].proof])
    const missing = (Object.entries(j.hops) as Array<[HopKey, Hop]>).filter(([, x]) => !resolveHop(x.file, x.token)).map(([k, x]) => `${k}: ${x.file} · ${x.token}`)
    check(`${j.journey}: every owner is a registered domain with a runnable proof, and trigger → decision → action → evidence → recovery resolve`, bad.length === 0 && unproved.length === 0 && missing.length === 0, [...bad.map((d) => `no domain ${d}`), ...unproved.map((d) => `proof of ${d} not in package.json`), ...missing].join(" | "))
  }
  for (const p of PLAYS) {
    const missing = p.hops.filter((x) => !resolveHop(x.file, x.token)).map((x) => `${x.file} · ${x.token}`)
    const owned = new Set(Object.values(reg.MAINTENANCE_DOMAINS).map((d) => d.proof))
    const noProof = p.proofs.filter((k) => !pkg.scripts[k] || !owned.has(k))
    check(`Play ${p.play}: every hop is live code and every proof is registered AND owned by a manager`, missing.length === 0 && noProof.length === 0, [...missing, ...noProof.map((k) => `proof ${k} unregistered/unowned`)].join(" | "))
  }
  for (const e of EVENT_EDGES) {
    check(`event edge ${e.event} (${e.kind}): source and consumer both live`, !!resolveHop(e.source.file, e.source.token) && !!resolveHop(e.consumer.file, e.consumer.token), `${fmt(e.source)} → ${fmt(e.consumer)}`)
  }

  // ══ §C ══
  section("C · every MAINTENANCE_DOMAINS row that names wave 152 has a real owner, a live trigger and a live consumer")
  const onJourney = (d: string) => JOURNEYS.filter((j) => j.domains.includes(d))
  const wave152Problems = (domains: Record<string, { manager: string; proof: string; what: string }>) =>
    Object.entries(domains).filter(([, r]) => WAVE152.test(r.what)).flatMap(([key, r]) => {
      const js = onJourney(key)
      if (!(r.manager in reg.MANAGERS)) return [`${key}: owner ${r.manager} is not a manager`]
      if (!pkg.scripts[r.proof]) return [`${key}: proof ${r.proof} is not registered`]
      if (js.length === 0) return [`${key}: on no journey (no trigger / consumer named)`]
      const live = js.some((j) => resolveHop(j.hops.trigger.file, j.hops.trigger.token) && resolveHop(j.hops.action.file, j.hops.action.token) && resolveHop(j.hops.evidence.file, j.hops.evidence.token))
      return live ? [] : [`${key}: its journeys' trigger / consumer hops do not resolve`]
    })
  const planted = { ...reg.MAINTENANCE_DOMAINS, planted_152_control: { manager: "data_steward", proof: "test:manager-ownership", what: "A WAVE 152 capability nobody wired" } } as Record<string, { manager: string; proof: string; what: string }>
  check("POSITIVE CONTROL: a planted wave-152 row on no journey is flagged", wave152Problems(planted).some((p) => p.startsWith("planted_152_control")))
  const rows152 = Object.keys(reg.MAINTENANCE_DOMAINS).filter((k) => WAVE152.test(reg.MAINTENANCE_DOMAINS[k].what))
  console.log(`    wave-152 rows: ${rows152.length} — ${rows152.join(", ")}`)
  check(`the census is not blind: it sees the batch-1 rows (receipt_to_books, roi_outcome_ledger, tenant_facing_copy, addendum_signature_request)`, ["receipt_to_books", "roi_outcome_ledger", "tenant_facing_copy", "addendum_signature_request"].every((k) => rows152.includes(k)))
  const problems = wave152Problems(reg.MAINTENANCE_DOMAINS as never)
  check("every wave-152 row has an owner, a registered proof and a journey whose trigger and consumer are live code", problems.length === 0, problems.join(" | "))

  // ══ §G ══
  section("G · which policy owner decides which question (H1/H2) — one live decider, ONE definer, a real consumer, its proof; one writer per governance table")
  const repoFiles = [...walkSrc("lib"), ...walkSrc("app"), ...walkSrc("hooks"), ...walkSrc("remotion")].sort()
  const fileSet = new Set(repoFiles)
  const blankedCache = new Map<string, string>()
  const blanked = (f: string): string => { let s = blankedCache.get(f); if (s === undefined) { s = blankComments(raw(f)); blankedCache.set(f, s) } return s }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const definesName = (src: string, name: string) => new RegExp(`(?:^|[^\\w$.])(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s+${escapeRe(name)}\\s*[(<]|(?:const|let|var)\\s+${escapeRe(name)}\\s*[=:])`, "m").test(src)
  const mentions = (src: string, name: string) => (src.match(new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, "g")) ?? []).length
  check("POSITIVE CONTROL: the definer scan finds a planted second definition and ignores one that only lives in a comment",
    definesName(blankComments("export async function approverFor(x) {}"), "approverFor") && definesName(blankComments("const approverFor = () => 1"), "approverFor") && !definesName(blankComments("// export async function approverFor() {}"), "approverFor") && !definesName(blankComments("approverFor(x)"), "approverFor"))
  const policyRows: Array<PolicyOwner & { line: number; definers: string[]; consumers: number }> = []
  for (const p of POLICY_OWNERS) {
    const line = resolveHop(p.decider.file, p.decider.token)
    const isDefinition = /^(?:export |async |function |const )/.test(p.decider.token)
    const definers = isDefinition ? repoFiles.filter((f) => definesName(blanked(f), p.name)) : [p.decider.file]
    const consumers = p.local ? mentions(blanked(p.decider.file), p.name) - 1 : repoFiles.filter((f) => f !== p.decider.file && mentions(blanked(f), p.name) > 0).length
    policyRows.push({ ...p, line, definers, consumers })
    const bad = [
      !line ? "decider is not live code" : "",
      isDefinition && (definers.length !== 1 || definers[0] !== p.decider.file) ? `defined in ${definers.length} file(s): ${definers.join(", ") || "none"} — a duplicate / conflicting policy reader` : "",
      consumers < 1 ? "no consumer (a decider nobody asks)" : "",
      !pkg.scripts[p.proof] ? `proof ${p.proof} is not registered` : "",
    ].filter(Boolean)
    check(`[${p.plane}] ${p.question} → ${p.name} (${p.decider.file})`, bad.length === 0, bad.join(" | "))
  }
  // §G2 — unsafe bypasses: a governance table written outside its one writer
  const writersOf = (table: string, files: string[], src: (f: string) => string) => files.filter((f) => new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.(?:insert|update|upsert|delete)\\b`).test(src(f)))
  check("POSITIVE CONTROL: the bypass scan sees a planted write and ignores a commented one", writersOf("missions", ["planted"], () => blankComments(`await svc.from("missions").update({ state: "ACTIVE" })`)).length === 1 && writersOf("missions", ["planted"], () => blankComments(`// await svc.from("missions").update({})`)).length === 0)
  for (const g of GOVERNANCE_WRITERS) {
    const found = writersOf(g.table, repoFiles, blanked)
    const extra = found.filter((f) => !g.writers.includes(f))
    check(`${g.table} is written only by ${g.writers.join(" + ")} (${g.why})`, extra.length === 0 && found.length > 0, extra.length ? `bypass writer(s): ${extra.join(", ")}` : found.length === 0 ? "the one writer no longer writes it (scan blind?)" : "")
  }

  // ══ §H ══
  section("H · the full registry census (H6) — EVERY MAINTENANCE_DOMAINS row and every capability, traced from code")
  const resolveSpec = (from: string, spec: string): string | null => {
    let base: string
    if (spec.startsWith("@/")) base = spec.slice(2)
    else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), spec))
    else return null
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (fileSet.has(c)) return c
    return null
  }
  const importsIn = (from: string, src: string): string[] => {
    const out: string[] = []
    for (const m of src.matchAll(IMPORT_RE)) { if (m[2]) continue; const r = resolveSpec(from, m[3]); if (r) out.push(r) }
    for (const m of src.matchAll(DYN_IMPORT_RE)) { const r = resolveSpec(from, m[1]); if (r) out.push(r) }
    return out
  }
  const factsCache = new Map<string, FileFacts>()
  const factsOf = (f: string): FileFacts => {
    const hit = factsCache.get(f)
    if (hit) return hit
    const src = blanked(f)
    const writes = new Set<string>(), reads = new Set<string>()
    for (const m of src.matchAll(WRITE_RE)) writes.add(m[1])
    for (const m of src.matchAll(READ_RE)) reads.add(m[1])
    const out: FileFacts = { writes, reads, planes: new Set(PLANE_RES.filter(([, re]) => re.test(src)).map(([k]) => k)), next: NEXT_RE.test(src), recovery: RECOVERY_RE.test(src), outcome: OUTCOME_RE.test(src), imports: importsIn(f, src), useServer: /^\s*["']use server["']/.test(src) }
    factsCache.set(f, out)
    return out
  }
  check("POSITIVE CONTROL: the import resolver maps `@/` and relative specifiers, follows a dynamic import and skips an `import type` edge",
    resolveSpec("lib/kernel/manager-delegation.ts", "@/lib/kernel/missions") === "lib/kernel/missions.ts" && resolveSpec("scripts/x.ts", "../lib/kernel/missions") === "lib/kernel/missions.ts" &&
    importsIn("lib/x.ts", blankComments(`import type { T } from "@/lib/kernel/action-ledger"\nimport { a } from "@/lib/kernel/missions"\nconst m = await import("@/lib/kernel/manager-delegation")`)).join() === "lib/kernel/missions.ts,lib/kernel/manager-delegation.ts")
  const rev = new Map<string, string[]>()
  const tableReaders = new Map<string, Set<string>>()
  for (const f of repoFiles) {
    const ff = factsOf(f)
    for (const t of new Set(ff.imports)) { if (!rev.has(t)) rev.set(t, []); rev.get(t)!.push(f) }
    for (const t of ff.reads) { if (!tableReaders.has(t)) tableReaders.set(t, new Set()); tableReaders.get(t)!.add(f) }
  }
  const entryKind = (f: string): string | null => {
    if (/^app\/api\/cron\/.+\/route\.tsx?$/.test(f) || f === "lib/kernel/cron-dispatch.ts") return "cron"
    if (/^app\/api\/webhooks\/.+\/route\.tsx?$/.test(f)) return "webhook"
    if (/^app\/.+\/route\.tsx?$/.test(f)) return "route"
    if (/^app\/(?:.+\/)?(?:page|layout)\.tsx?$/.test(f)) return "page"
    if (f === "lib/kernel/event-reactor.ts") return "reactor"
    // Remotion compositions are bundled from remotion/Root.tsx and rendered by composition id (no import edge from the render route).
    if (f === "remotion/Root.tsx" || f === "remotion/index.ts") return "render"
    if (factsOf(f).useServer) return "action"
    return null
  }
  const triggerOf = (starts: string[]): DomainLoop["trigger"] => {
    const seen = new Set(starts)
    let frontier = [...starts]
    for (let hops = 0; hops <= 8 && frontier.length; hops++) {
      const kinds = frontier.map((f) => ({ f, k: entryKind(f) })).filter((x) => x.k)
      if (kinds.length) { const order = ["cron", "webhook", "reactor", "action", "route", "page", "render"]; kinds.sort((a, b) => order.indexOf(a.k!) - order.indexOf(b.k!) || a.f.localeCompare(b.f)); return { kind: kinds[0].k!, file: kinds[0].f, hops } }
      const next: string[] = []
      for (const f of frontier) for (const imp of rev.get(f) ?? []) if (!seen.has(imp)) { seen.add(imp); next.push(imp) }
      frontier = next
    }
    return null
  }
  const PATH_RE = /\b((?:lib|app)\/[A-Za-z0-9_\-./[\]()@]+?\.tsx?)(?![A-Za-z0-9_])/g
  const INFRA = /^lib\/(?:supabase\/|kernel\/(?:manager-registry|signal-registry|events)\.ts$)/
  const proofImportCache = new Map<string, string[]>()
  /** The proof's script file(s) and the first-party modules they import. An AGGREGATE proof (`npm run test:a && npm run test:b`)
   *  is registered too: its sub-proofs are followed one level. */
  const proofSurvivors = (proofKey: string, depth = 0): { registered: boolean; files: string[]; imports: string[] } => {
    const script = pkg.scripts[proofKey]
    if (!script) return { registered: false, files: [], imports: [] }
    const files = [...script.matchAll(/scripts\/[\w./-]+\.ts/g)].map((m) => m[0])
    for (const f of files) if (!proofImportCache.has(f)) proofImportCache.set(f, importsIn(f, blankComments(raw(f))))
    const imports = files.flatMap((f) => proofImportCache.get(f)!)
    if (depth === 0) for (const m of script.matchAll(/npm run (?:-s )?(test:[\w:-]+)/g)) { const sub = proofSurvivors(m[1], 1); files.push(...sub.files); imports.push(...sub.imports) }
    return { registered: true, files, imports }
  }
  /** A module that writes a table AND reads it back for others (a co-located reader) counts as readback only when some other
   *  first-party file consumes that module. */
  const consumedElsewhere = (f: string) => (rev.get(f) ?? []).some((imp) => imp !== f)
  // A survivor TOUCHES a provider when it is a provider client (lib/external, lib/esign), makes a network call, or imports a client —
  // not merely because it sits under lib/providers/ (wave 153 integrator: a pure data module there — the provider capability matrix,
  // the scorecard — decides nothing on the wire and is a read surface, not a provider loop owing a next action).
  const PROVIDER_CALL_RE = /\bfetch\s*\(|\baxios\s*[.(]|\bnew\s+[A-Z]\w*Client\s*\(/
  const callsProvider = (p: string): boolean => /^lib\/(?:external|esign)\//.test(p) || PROVIDER_CALL_RE.test(blanked(p)) || factsOf(p).imports.some((i) => /^lib\/(?:external|esign)\//.test(i))
  check("POSITIVE CONTROL: provider-touching is decided by the call, not the folder (a lib/providers client and a module importing a lib/external client touch a provider; the pure capability matrix does not)",
    callsProvider("lib/providers/zenrows/client.ts") && callsProvider("lib/providers/scrape-checkpoint.ts") && !callsProvider("lib/providers/provider-capability-matrix.ts"),
    JSON.stringify({ zenrows: callsProvider("lib/providers/zenrows/client.ts"), checkpoint: callsProvider("lib/providers/scrape-checkpoint.ts"), matrix: callsProvider("lib/providers/provider-capability-matrix.ts") }))
  const loopOf = (key: string, row: { manager: string; proof: string; what: string }): DomainLoop => {
    const named = [...new Set([...row.what.matchAll(PATH_RE)].map((m) => m[1]).filter((p) => fileSet.has(p)))]
    const proof = proofSurvivors(row.proof)
    const survivors = [...new Set([...named, ...proof.imports])].filter((p) => !INFRA.test(p)).sort()
    const facts = survivors.map((s) => ({ s, f: factsOf(s) }))
    const writes = [...new Set(facts.flatMap((x) => [...x.f.writes]))].sort()
    const writerFiles = (t: string) => new Set(facts.filter((x) => x.f.writes.has(t)).map((x) => x.s))
    const readersOf = (t: string) => [...(tableReaders.get(t) ?? [])].filter((r) => !writerFiles(t).has(r) || (factsOf(r).reads.has(t) && consumedElsewhere(r)))
    const readers = new Set(writes.flatMap(readersOf))
    const unread = writes.filter((t) => readersOf(t).length === 0).length
    const planes = [...new Set(facts.flatMap((x) => [...x.f.planes]))].sort()
    const provider = planes.includes("D") || survivors.some((p) => /^lib\/(?:providers|external|esign)\//.test(p) && callsProvider(p))
    const trigger = survivors.length ? triggerOf(survivors) : null
    const next = facts.some((x) => x.f.next), recovery = facts.some((x) => x.f.recovery), outcome = facts.some((x) => x.f.outcome)
    const verdict = classifyLoop({ proofRegistered: proof.registered, survivors: survivors.length, proofFirstParty: proof.files.length > 0, trigger: !!trigger, writes: writes.length, provider, unreadWrites: unread, readback: readers.size > 0, next, recovery, outcome })
    return { key, manager: row.manager, proof: row.proof, ...verdict, survivors, trigger, planes, writes, readback: readers.size, next, recovery, outcome }
  }
  // POSITIVE CONTROLS on the ONE classifier and on a known loop
  const base = { proofRegistered: true, survivors: 2, proofFirstParty: true, trigger: true, writes: 1, provider: false, unreadWrites: 0, readback: true, next: true, recovery: false, outcome: true }
  check("POSITIVE CONTROL: the classifier tells every class apart (registry-only, guard-only, untriggered, read-surface, writes-unread, partial, loop-complete, proof-unregistered)",
    classifyLoop({ ...base, survivors: 0, proofFirstParty: false }).cls === "registry-only" && classifyLoop({ ...base, survivors: 0 }).cls === "guard-only" && classifyLoop({ ...base, trigger: false }).cls === "untriggered" &&
    classifyLoop({ ...base, writes: 0 }).cls === "read-surface" && classifyLoop({ ...base, unreadWrites: 1, readback: false }).cls === "writes-unread" && classifyLoop({ ...base, writes: 2, unreadWrites: 1, next: false, outcome: false }).cls === "partial" &&
    classifyLoop(base).cls === "loop-complete" && classifyLoop({ ...base, proofRegistered: false }).cls === "proof-unregistered")
  const plantedMissing = loopOf("planted_missing_153", { manager: "data_steward", proof: "test:no-such-proof-153h", what: "names lib/nowhere/missing-153h.ts only" })
  check("POSITIVE CONTROL: a planted row naming a missing file and an unregistered proof is NOT counted live", plantedMissing.cls === "proof-unregistered" && plantedMissing.survivors.length === 0)
  const reviewAsk = loopOf("review_ask_at_closing", reg.MAINTENANCE_DOMAINS.review_ask_at_closing)
  check("POSITIVE CONTROL: a known live loop (the review ask) traces to its cron trigger, the engagement plane and evidence", reviewAsk.trigger?.kind === "cron" && reviewAsk.planes.includes("E") && reviewAsk.outcome, JSON.stringify({ cls: reviewAsk.cls, trigger: reviewAsk.trigger, planes: reviewAsk.planes }))
  const loops = Object.entries(reg.MAINTENANCE_DOMAINS).map(([k, r]) => loopOf(k, r as never))
  const byClass = (cls: CensusClass, ls = loops) => ls.filter((l) => l.cls === cls)
  const CLASSES: CensusClass[] = ["loop-complete", "read-surface", "partial", "writes-unread", "untriggered", "guard-only", "registry-only", "proof-unregistered"]
  console.log(`    census over ${repoFiles.length} source files: ${loops.length} domains — ${CLASSES.map((c) => `${c} ${byClass(c).length}`).join(" · ")}`)
  check("the census is not blind: every MAINTENANCE_DOMAINS row is classified and live loops are found", loops.length === Object.keys(reg.MAINTENANCE_DOMAINS).length && byClass("loop-complete").length > 0)
  const managerKeys = Object.keys(reg.MANAGERS)
  const noLiveLoop = managerKeys.filter((m) => !loops.some((l) => l.manager === m && l.cls === "loop-complete"))
  check(`every registered manager (${managerKeys.length}) is accountable for at least one LIVE loop (not only registry rows)`, noLiveLoop.length === 0, noLiveLoop.join(", "))
  const rows153 = loops.filter((l) => WAVE153.test(reg.MAINTENANCE_DOMAINS[l.key].what))
  // WHAT THE RULE BINDS (wave 153 integrator — the rule's own words: "not complete with only a registry entry or an unconsumed write"):
  //  · a row BORN in wave 153 must be a live loop, a read surface, or a guard-only code-discipline domain (a census / matrix whose
  //    proof judges source — its honest class, e.g. marketing_capability_census);
  //  · a row that PREDATES the wave (its text names an earlier wave) and only carries an appended "Wave 153" note keeps the class
  //    it already had — the note is not a new domain. Those are PRINTED as the amended-and-still-partial triage list, never hidden,
  //    and still fail when they are registry-only / untriggered / writes-unread / proof-unregistered (a dead domain is dead in any wave).
  const EARLIER_WAVE = /\bwave (?:1[0-4]\d|15[0-2])\b/i
  const predates = (key: string) => EARLIER_WAVE.test(reg.MAINTENANCE_DOMAINS[key].what)
  const LIVE_CLASSES = new Set<CensusClass>(["loop-complete", "read-surface", "guard-only"])
  const DEAD_CLASSES = new Set<CensusClass>(["registry-only", "untriggered", "writes-unread", "proof-unregistered"])
  const dead153 = rows153.filter((l) => (predates(l.key) ? DEAD_CLASSES.has(l.cls) : !LIVE_CLASSES.has(l.cls)))
  const amendedPartial = rows153.filter((l) => predates(l.key) && l.cls === "partial")
  console.log(`    amended older rows still partial (triage, not new domains): ${amendedPartial.length}${amendedPartial.length ? " — " + amendedPartial.map((l) => l.key).join(", ") : ""}`)
  check("POSITIVE CONTROL: the born-in-wave-153 test tells a new row from an amended one (expense_office_rollup is new; relocation_planner predates)", !predates("expense_office_rollup") && predates("relocation_planner"))
  check("POSITIVE CONTROL: a NEW wave-153 row that is partial still fails the rule, and an amended older row that is registry-only still fails it",
    !LIVE_CLASSES.has("partial") && DEAD_CLASSES.has("registry-only") && !DEAD_CLASSES.has("partial"))
  console.log(`    wave-153 rows: ${rows153.length} — ${rows153.map((l) => `${l.key} (${l.cls})`).join(", ")}`)
  check("the wave-153 census sees the batch-1 rows (expense_office_rollup, commission_term_change, deal_work_ownership, closing_readiness)", ["expense_office_rollup", "commission_term_change", "deal_work_ownership", "closing_readiness"].every((k) => rows153.some((l) => l.key === k)))
  check("every wave-153 row is a LIVE loop (a domain is not complete with only a registry entry or an unconsumed write)", dead153.length === 0, dead153.map((l) => `${l.key}: ${l.cls} — ${l.why}`).join(" | "))
  const sentinelCron = Object.keys(reg.CRON_MANAGER).find((p) => p.includes("platform-sentinel"))
  check("the platform-scope manager (Platform Sentinel) runs on a registered cron whose route exists", !!sentinelCron && existsSync(join(ROOT, `app${sentinelCron}/route.ts`)), String(sentinelCron))
  // capabilities — the catalogue keys, their registered owner, and who actually asks for them
  const capReg = await import("../lib/agentic-os/app-capability-registry")
  const capOwn = await import("../lib/agentic-os/capability-ownership")
  const CAP_DEFINERS = new Set(["lib/agentic-os/app-capability-registry.ts", "lib/agentic-os/capability-ownership.ts"])
  const capRows = Object.keys(capReg.APP_CAPABILITY_REGISTRY).map((cap) => {
    const owner = (capOwn.CAPABILITY_MANAGER as Record<string, string>)[cap]
    const consumers = repoFiles.filter((f) => !CAP_DEFINERS.has(f) && blanked(f).includes(`"${cap}"`))
    return { cap, owner, mutates: (capReg.APP_CAPABILITY_REGISTRY as Record<string, { mutates: boolean }>)[cap].mutates, consumers }
  })
  const ownerless = capRows.filter((c) => !c.owner || !(c.owner in reg.MANAGERS))
  check(`every catalogue capability (${capRows.length}) is owned by a registered manager (LAW 3: capabilities, not vendors)`, ownerless.length === 0, ownerless.map((c) => c.cap).join(", "))
  const unconsumedCaps = capRows.filter((c) => c.consumers.length === 0)
  console.log(`    capabilities with no consumer outside the catalogue (registry-only findings): ${unconsumedCaps.length}${unconsumedCaps.length ? ` — ${unconsumedCaps.map((c) => c.cap).join(", ")}` : ""}`)
  const renderCensus = (): string => {
    const out: string[] = []
    out.push("# Manager domain loop census — every MAINTENANCE_DOMAINS row, traced from code")
    out.push("")
    out.push("GENERATED by `scripts/manager-ownership-matrix-guard.ts --write-doc` (wave 153, lane 153H; directive H6) — do not hand-edit. Every row of")
    out.push("`lib/kernel/manager-registry.ts` MAINTENANCE_DOMAINS (not a hand-picked set) is traced over comment-blanked source: the survivor files")
    out.push("(paths named in the row + the first-party modules its proof drives) → the nearest TRIGGER that reaches them (cron / webhook / reactor /")
    out.push("server action / route / page, with import hops) → the POLICY planes they ask → the tables they WRITE (persisted state) → whether any")
    out.push("other file READS that state → NEXT action (event / signal / notification / task) → RECOVERY (self-heal / dead letter / escalate / retry /")
    out.push("sweep) → OUTCOME evidence (ledger / arbitration record / provider truth). The class is the honest reading; the guard recomputes it every run.")
    out.push("")
    out.push("Planes: A authority / tenant session · E Contact engagement (the follow-up arbiter) · D outbound dispatch · G manager coordination")
    out.push("(delegation, missions, the signal bus) · P human approval · R resources (entitlement, vendor budget, spend, provider route) · C closing / money gates.")
    out.push("")
    out.push(`Classes: ${CLASSES.map((c) => `\`${c}\` ${byClass(c).length}`).join(" · ")} — of ${loops.length} rows, over ${repoFiles.length} source files.`)
    out.push("")
    for (const m of managerKeys) {
      const ls = loops.filter((l) => l.manager === m).sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls) || a.key.localeCompare(b.key))
      out.push(`## ${reg.MANAGERS[m as keyof typeof reg.MANAGERS].label} (\`${m}\`) — ${ls.length} domains`)
      out.push("")
      out.push("| Domain | Class | Trigger | Planes | Survivor | Writes (state) | Readback | Next | Recovery | Outcome | Proof |")
      out.push("|---|---|---|---|---|---|---|---|---|---|---|")
      for (const l of ls) {
        const trig = l.trigger ? `${l.trigger.kind} \`${l.trigger.file.replace(/^app\//, "").replace(/\/(?:route|page)\.tsx?$/, "")}\`${l.trigger.hops ? ` (+${l.trigger.hops})` : ""}` : "—"
        const surv = l.survivors.length ? `\`${l.survivors[0].split("/").pop()}\`${l.survivors.length > 1 ? ` +${l.survivors.length - 1}` : ""}` : "—"
        const wr = l.writes.length ? `${l.writes.slice(0, 3).join(", ")}${l.writes.length > 3 ? ` +${l.writes.length - 3}` : ""}` : "—"
        out.push(`| \`${l.key}\` | ${l.cls === "partial" ? `partial (${l.why.startsWith("no readback") ? "no readback" : "no closure"})` : l.cls} | ${trig} | ${l.planes.join("") || "—"} | ${surv} | ${wr} | ${l.readback ? `${l.readback} reader(s)` : "—"} | ${l.next ? "✓" : "—"} | ${l.recovery ? "✓" : "—"} | ${l.outcome ? "✓" : "—"} | \`${l.proof}\` |`)
      }
      out.push("")
    }
    out.push("## Catalogue capabilities (APP_CAPABILITY_REGISTRY → CAPABILITY_MANAGER)")
    out.push("")
    out.push("| Capability | Owner | Mutates | Consumers outside the catalogue | Finding |")
    out.push("|---|---|---|---|---|")
    for (const c of capRows) out.push(`| \`${c.cap}\` | ${reg.MANAGERS[c.owner as keyof typeof reg.MANAGERS]?.label ?? `MISSING ${c.owner}`} | ${c.mutates ? "yes" : "no"} | ${c.consumers.length} | ${c.consumers.length ? "—" : "registry-only (nothing asks for it by name)"} |`)
    out.push("")
    out.push("## Blind spots")
    out.push("")
    out.push("- LEXICAL: a table named through a constant (`.from(TABLE)`), an RPC or a trigger is not seen as a write; a writer reached only through a generic helper is attributed to the helper. A guard that only READS source files (a census) names no runtime survivor and is `guard-only` by design.")
    out.push("- A trigger is the nearest entry point over static AND dynamic imports (≤ 8 hops) — it proves a door can reach the survivor, not that every run does; the named proof carries the behaviour.")
    out.push("- `partial` / `writes-unread` / `untriggered` / `registry-only` are FINDINGS to triage, not verdicts of brokenness: a pull-based reader, a reader in SQL / a view, or an external consumer is invisible here.")
    out.push("")
    return out.join("\n")
  }
  const censusRendered = renderCensus()
  if (process.argv.includes("--write-doc")) { writeFileSync(join(ROOT, CENSUS_DOC), censusRendered); console.log(`    wrote ${CENSUS_DOC}`) }
  const censusOnDisk = existsSync(join(ROOT, CENSUS_DOC)) ? raw(CENSUS_DOC) : ""
  const docKeys = new Set([...censusOnDisk.matchAll(/^\| `([a-z0-9_]+)` \| (?:loop-complete|read-surface|partial[^|]*|writes-unread|untriggered|guard-only|registry-only|proof-unregistered) \|/gm)].map((m) => m[1]))
  const regKeys = Object.keys(reg.MAINTENANCE_DOMAINS)
  check(`${CENSUS_DOC} covers exactly the registry's domain rows (regenerate with --write-doc when the registry changes)`, docKeys.size === regKeys.length && regKeys.every((k) => docKeys.has(k)), `doc ${docKeys.size} vs registry ${regKeys.length}; missing ${regKeys.filter((k) => !docKeys.has(k)).slice(0, 5).join(", ")}`)

  // ══ §D ══
  section("D · docs/architecture/MANAGER-OWNERSHIP-MATRIX.md is the rendering of §A–§C")
  const owners = (d: string) => { const r = reg.MAINTENANCE_DOMAINS[d]; return r ? { acc: reg.MANAGERS[r.manager]?.label ?? r.manager, co: (r.coOwners ?? []).map((k) => reg.MANAGERS[k]?.label ?? k), proof: r.proof } : { acc: `MISSING ${d}`, co: [], proof: "—" } }
  const render = (): string => {
    const out: string[] = []
    out.push("# Manager ownership matrix — the arbiter and managers as the governance control plane")
    out.push("")
    out.push("GENERATED by `scripts/manager-ownership-matrix-guard.ts --write-doc` (wave 152, lane 152I) — do not hand-edit. Owners are read from")
    out.push("`lib/kernel/manager-registry.ts` MAINTENANCE_DOMAINS; every `file:line` is a code token resolved in comment-stripped source at")
    out.push("generation time. `npm run test:manager-ownership-matrix` fails when a domain, an owner, a file or a token here no longer matches the code.")
    out.push("")
    out.push("## 1. The owner's arbiter model on the existing planes")
    out.push("")
    out.push("Intercept → typed instruction (with security metadata) → policy decision (allow / deny / rewrite / hold) → execute only what is approved → audit every decision. No new arbiter: each plane below is an existing survivor.")
    out.push("")
    out.push("| Plane | Intercept | Typed instruction | Policy decision | Execute | Audit |")
    out.push("|---|---|---|---|---|---|")
    for (const p of ARBITER_PLANES) out.push(`| ${p.plane} | ${(["intercept", "typed instruction", "policy decision", "execute", "audit"] as Step[]).map((s) => p.steps[s].map((x) => `${fmt(x)} \`${x.token.replace(/\|/g, "\\|").slice(0, 60)}\``).join("<br>")).join(" | ")} |`)
    out.push("")
    out.push("## 2. Journey ownership (directive 667–680, batch-1 and batch-2 capabilities)")
    out.push("")
    out.push("| Journey | Accountable (registry) | Co-owners | Domains · proof | Trigger | Decision | Action | Evidence | Recovery |")
    out.push("|---|---|---|---|---|---|---|---|---|")
    for (const j of JOURNEYS) {
      const accs = [...new Set(j.domains.map((d) => owners(d).acc))]
      const cos = [...new Set(j.domains.flatMap((d) => owners(d).co))].filter((c) => !accs.includes(c))
      out.push(`| ${j.journey}${j.note ? ` — ${j.note}` : ""} | ${accs.join(", ")} | ${cos.join(", ") || "—"} | ${j.domains.map((d) => `\`${d}\` · \`${owners(d).proof}\``).join("<br>")} | ${(["trigger", "decision", "action", "evidence", "recovery"] as HopKey[]).map((k) => `${fmt(j.hops[k])} \`${j.hops[k].token.replace(/\|/g, "\\|").slice(0, 60)}\``).join(" | ")} |`)
    }
    out.push("")
    out.push("## 3. Wave-152 registry rows → their journey")
    out.push("")
    out.push("| Domain | Accountable | Proof | Journey |")
    out.push("|---|---|---|---|")
    for (const k of rows152) out.push(`| \`${k}\` | ${owners(k).acc} | \`${owners(k).proof}\` | ${onJourney(k).map((j) => j.journey).join("; ") || "NONE"} |`)
    out.push("")
    out.push("## 4. The six plays of directive 711–725 — hops and the proofs that drive them")
    out.push("")
    out.push("| Play | Hops (live code) | Proofs | Truth |")
    out.push("|---|---|---|---|")
    for (const p of PLAYS) out.push(`| ${p.play} | ${p.hops.map((x) => `${fmt(x)} \`${x.token.replace(/\|/g, "\\|").slice(0, 50)}\``).join("<br>")} | ${p.proofs.map((k) => `\`${k}\``).join(", ")} | ${p.truth} |`)
    out.push("")
    out.push("## 5. Domain-event edges (directive 701–707 — semantic names, existing infrastructure)")
    out.push("")
    out.push("| Event | Kind | Source | Consumer |")
    out.push("|---|---|---|---|")
    for (const e of EVENT_EDGES) out.push(`| ${e.event} | ${e.kind} | ${fmt(e.source)} | ${fmt(e.consumer)} |`)
    out.push("")
    out.push("## 6. Which policy owner decides which question (wave 153, lane 153H — directive H1/H2)")
    out.push("")
    out.push("OS-wide arbitration is these EXISTING deciders, each at its own action boundary — no central arbiter, no synchronous bottleneck. Each question has ONE decider DEFINED in ONE file (a second definer would be a duplicate / conflicting policy reader), a real consumer, and the proof that drives it. Deterministic deny / hold always wins over an AI proposal: the engagement plane's model is asked only inside the menu the deterministic gates left, inside a latency budget, with the planner's verdict as its fallback.")
    out.push("")
    out.push("| Plane | Question | Decider | Consumers | Proof |")
    out.push("|---|---|---|---|---|")
    for (const p of policyRows) out.push(`| ${p.plane} | ${p.question} | ${fmt(p.decider)} \`${p.name}\`${p.local ? " (module-private: the gate is the door)" : ""} | ⟨${p.consumers}⟩${p.local ? " in-file" : " file(s)"} | \`${p.proof}\` |`)
    out.push("")
    out.push("Decision flow between the planes: a trigger (event / human goal / signal / cron) → the tenant session + authority deciders (plane 1–2) → the resource deciders (entitlement, vendor ceiling, spend, provider route) and the domain's own gates (closing / commission / TRID) → the accountable manager (registry) — asking another manager only through plane 5 (capability owner, wait-for cycle, bounded re-asks, per-tenant capacity, escalation to a human on any policy refusal) → a person-facing touch only through plane 3 → the send only through plane 4 → a consequential hold only released by plane 6 → every decision on `agent_action_ledger.detail.governance` (verb ALLOW / DENY / REWRITE / HOLD / DELEGATE / RESCHEDULE / ESCALATE / CANCEL read from the plane's own verdict; the row's phase decided / attempted / provider_accepted / completed) → incident recovery (ingress continuity, self-heal tiers).")
    out.push("")
    out.push("## 7. One writer per governance table (an extra writer is an unsafe bypass)")
    out.push("")
    out.push("| Table | The one writer | Why |")
    out.push("|---|---|---|")
    for (const g of GOVERNANCE_WRITERS) out.push(`| \`${g.table}\` | ${g.writers.map((w) => `\`${w}\``).join(" + ")} | ${g.why} |`)
    out.push("")
    out.push("## 8. Every registered manager — the full census summary (detail per domain: `docs/architecture/MANAGER-DOMAIN-LOOP-CENSUS.md`)")
    out.push("")
    out.push(`| Manager | Domains | ${CLASSES.join(" | ")} | Crons | Tables | Queues | Capabilities |`)
    out.push(`|---|---|${CLASSES.map(() => "---").join("|")}|---|---|---|---|`)
    for (const m of managerKeys) {
      const ls = loops.filter((l) => l.manager === m)
      out.push(`| ${reg.MANAGERS[m as keyof typeof reg.MANAGERS].label} | ⟨${ls.length}⟩ | ${CLASSES.map((c) => `⟨${byClass(c, ls).length}⟩`).join(" | ")} | ⟨${Object.values(reg.CRON_MANAGER).filter((x) => x === m).length}⟩ | ⟨${Object.values(reg.TABLE_MANAGER).filter((x) => x === m).length}⟩ | ⟨${Object.values(reg.QUEUE_MANAGER).filter((x) => x === m).length}⟩ | ⟨${capRows.filter((c) => c.owner === m).length}⟩ |`)
    }
    out.push(`| Platform Sentinel (platform scope) | — | ${CLASSES.map(() => "—").join(" | ")} | \`${sentinelCron ?? "MISSING"}\` | — | — | — |`)
    out.push("")
    out.push("## Blind spots")
    out.push("")
    out.push("- A hop is the FIRST stripped-source line carrying its token; the guard proves the token is live code in that file, not that every path through the journey reaches it at run time — the named proofs carry the behaviour.")
    out.push("- Line anchors drift when a referenced file is edited; the structure (journeys, owners, domains, files, tokens) is compared exactly and drifted anchors are reported, so a stale line never turns the chain red on its own. Regenerate with `--write-doc`.")
    out.push("- Plays 1–5 are proven leg by leg by the proofs named in section 4 (SIMULATED, injected providers); only Play 6 is driven as one chained loop here.")
    out.push("")
    return out.join("\n")
  }
  const rendered = render()
  if (process.argv.includes("--write-doc")) { writeFileSync(join(ROOT, DOC), rendered); console.log(`    wrote ${DOC}`) }
  const onDisk = existsSync(join(ROOT, DOC)) ? raw(DOC) : ""
  // ⟨n⟩ marks a census COUNT (wave 153): counts move with every unrelated edit, so they are compared as structure only.
  const structure = (s: string) => s.replace(/:\d+`/g, ":N`").replace(/⟨[^⟩]*⟩/g, "⟨·⟩")
  check("POSITIVE CONTROL: a doc whose accountable owner was hand-edited no longer matches the rendering", structure(rendered.replace("| Data Steward |", "| Finance Manager |")) !== structure(rendered))
  check(`${DOC} exists and matches the rendering (structure exact; run --write-doc after a ruled change)`, onDisk.length > 0 && structure(onDisk) === structure(rendered), onDisk ? "drifted — run: npx tsx scripts/manager-ownership-matrix-guard.ts --write-doc" : "missing")
  if (onDisk && onDisk !== rendered && structure(onDisk) === structure(rendered)) console.log("    note: line anchors drifted (structure unchanged) — regenerate with --write-doc")
  check("the rendering names no MISSING hop", !/MISSING `/.test(rendered))

  // ══ §E ══
  section("E · the tool boundary, driven for real: decisions audited, the spoken-confirm hold persisted / released once / expired")
  {
    const routeSrc = stripComments(raw(ROUTE))
    // census: the HELD set equals the handlers that read params.confirm
    const caseReadsConfirm = (src: string) => {
      const out: string[] = []
      const re = /case "([a-z_]+)":\s*\{/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        let depth = 1, i = m.index + m[0].length
        while (i < src.length && depth > 0) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++ }
        if (/params\.confirm\b/.test(src.slice(m.index, i))) out.push(m[1])
      }
      return out.sort()
    }
    const heldSet = (src: string) => { const m = src.match(/HELD_FOR_SPOKEN_CONFIRM[^=]*=\s*new Set\(\[([^\]]*)\]\)/); return m ? (m[1].match(/"([a-z_]+)"/g) ?? []).map((s) => s.replace(/"/g, "")).sort() : [] }
    check("POSITIVE CONTROL: a planted handler that reads params.confirm is found by the census", caseReadsConfirm('switch (t) { case "wire_funds": { if (params.confirm) {} return 1 } }').join() === "wire_funds")
    check("every handler that reads `params.confirm` is in HELD_FOR_SPOKEN_CONFIRM (the boundary governs every spoken-confirm state change)", caseReadsConfirm(routeSrc).join() === heldSet(routeSrc).join() && heldSet(routeSrc).length > 0, `handlers ${caseReadsConfirm(routeSrc).join()} vs held ${heldSet(routeSrc).join()}`)

    const B1 = "b1b1b1b1-0000-4000-8000-000000000001", B2 = "b2b2b2b2-0000-4000-8000-000000000002"
    const UA = "a1a1a1a1-0000-4000-8000-0000000000a1", UB = "a1a1a1a1-0000-4000-8000-0000000000b1"
    const SA = "5a5a5a5a-0000-4000-8000-0000000000a1", SB = "5a5a5a5a-0000-4000-8000-0000000000b1"
    const C1 = "c1c1c1c1-0000-4000-8000-000000000001", C2 = "c2c2c2c2-0000-4000-8000-000000000002"
    const recorded: Row[] = []
    const g = globalThis as any
    const mkWorld = (refuse?: Record<string, string>) => memSupabase({
      agent_assistant_sessions: [
        { id: SA, brokerage_id: B1, agent_id: "ag-a", user_id: UA, conversation_id: "conv-a", tool_call_count: 0, ended_at: null, started_at: new Date().toISOString() },
        { id: SB, brokerage_id: B1, agent_id: "ag-b", user_id: UB, conversation_id: "conv-b", tool_call_count: 0, ended_at: null, started_at: new Date().toISOString() },
      ],
      users: [{ id: UA, user_type: "agent", brokerage_id: B1 }, { id: UB, user_type: "agent", brokerage_id: B1 }],
      contacts: [{ id: C1, brokerage_id: B1 }, { id: C2, brokerage_id: B2 }],
      agent_assistant_tool_calls: [], agent_action_ledger: [], self_heal_events: [], tenant_policy_versions: [],
    }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] }, ...(refuse ? { refuse } : {}) })
    let world = mkWorld()
    g.__MOG = { svc: () => world, record: async (a: Row) => { recorded.push(a); return { success: true } } }
    process.env.AGENT_ASSISTANT_TOOL_SECRET = "152i-tool-secret"
    const { POST } = await import("../app/api/agent-assistant/tool-call/route")
    const { NextRequest } = await import("next/server")
    const call = async (conv: string, tool: string, parameters: Record<string, unknown>) => {
      const res = await POST(new NextRequest("http://localhost/api/agent-assistant/tool-call", { method: "POST", headers: { "content-type": "application/json", "x-elevenlabs-tool-secret": "152i-tool-secret" }, body: JSON.stringify({ conversation_id: conv, tool_name: tool, parameters }) }))
      return ((await res.json()) as { result: Row }).result
    }
    const audits = () => world.tables.agent_assistant_tool_calls as Row[]
    const last = () => audits()[audits().length - 1]
    const gov = (r: Row | undefined) => (r?.tool_output?.governance ?? {}) as Row

    const unreg = await call("conv-a", "drop_all_tables", {})
    check("DENY audited: an unregistered tool is refused AND the refusal is a recorded decision (stage registry) — before 152I it left no row", !!unreg.error && gov(last()).decision === "deny" && gov(last()).stage === "registry" && last().success === false && last().brokerage_id === B1)
    const auth = await call("conv-a", "lender_confirm_financials", { contact_id: C1, confirm: true })
    check("DENY audited: an agent calling the vendor-only financing tool is refused at the authority stage, with the typed instruction on the row", !!auth.error && gov(last()).decision === "deny" && gov(last()).stage === "authority" && gov(last()).instruction?.authority === "vendor" && recorded.length === 0)
    const gate = await call("conv-a", "confirm_buyer_financials", { contact_id: C2, approved_amount: 480000 })
    check("DENY audited: another brokerage's contact is refused at the declared identity gate (entity_owner)", !!gate.error && gov(last()).stage === "declared_gate" && recorded.length === 0)

    const bypass = await call("conv-b", "confirm_buyer_financials", { contact_id: C1, approved_amount: 480000, confirm: true })
    check("ADVERSE · model bypass: a FIRST call carrying the model's own `confirm: true` changes NOTHING — it is rewritten to a read-back (a fresh hold)", bypass.needs_confirmation === true && recorded.length === 0 && gov(last()).decision === "hold" && /no live read-back/.test(String(gov(last()).reason)))

    const first = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 480000 })
    const holdRow = last()
    check("HOLD persisted: the read-back writes a hold with the digest of exactly what was read back and an expiry; nothing changed", first.needs_confirmation === true && gov(holdRow).decision === "hold" && /^[0-9a-f]{32}$/.test(String(gov(holdRow).hold?.digest)) && Date.parse(String(gov(holdRow).hold?.expires_at)) > Date.now() && recorded.length === 0 && gov(holdRow).instruction?.manager === "shopping_agent")
    const mismatch = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 500000, confirm: true })
    check("ADVERSE · mismatched term: a confirm for a DIFFERENT amount than was read back releases nothing (rewritten to a new read-back)", mismatch.needs_confirmation === true && recorded.length === 0)
    await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 610000 })
    const aHold610 = last()
    const otherSession = await call("conv-b", "confirm_buyer_financials", { contact_id: C1, approved_amount: 610000, confirm: true })
    check("ADVERSE · another session cannot release this session's hold (it gets its own read-back)", otherSession.needs_confirmation === true && recorded.length === 0 && gov(aHold610).decision === "hold" && !audits().find((r) => r.id === aHold610.id)?.tool_output?.hold_released_at && last().session_id === SB)
    const ok = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: "480000", confirm: "yes" })
    const releaseRow = last()
    check("RELEASE: the speaker's confirm of exactly what was read back executes ONCE (amount normalized: 480000 ≡ \"480000\")", ok.success === true && recorded.length === 1 && gov(releaseRow).decision === "allow" && gov(releaseRow).stage === "hold_released" && gov(releaseRow).released_hold === holdRow.id)
    check("…the hold row is stamped released (compare-and-set on tool_output->>hold_released_at)", !!audits().find((r) => r.id === holdRow.id)?.tool_output?.hold_released_at)
    const led = (world.tables.agent_action_ledger as Row[]).filter((r) => r.action === "ai.tool.confirm_buyer_financials")
    check("LAW 5: the released FINANCIAL change is on agent_action_ledger, keyed by the hold (voice_hold:<id>), risk FINANCIAL, actor the speaker", led.length === 1 && String(led[0].idempotency_key).includes(`voice_hold:${holdRow.id}`) && led[0].risk_class === "FINANCIAL" && led[0].actor_user_id === UA && led[0].status === "executed", JSON.stringify(led.map((r) => [r.idempotency_key, r.risk_class, r.actor_user_id, r.status])))
    const g153 = (led[0]?.detail?.governance ?? {}) as Row
    check("H3 (wave 153): the released change's ledger row carries the decision contract — verb ALLOW read from the boundary's `allow`, the speaker as the approver, the released hold as evidence, the tool's manager as the candidate",
      g153.decision === "ALLOW" && g153.plane === "tool_boundary" && (g153.approver?.user_ids ?? []).includes(UA) && (g153.evidence_refs ?? []).includes(`agent_assistant_tool_calls:${holdRow.id}`) && (g153.candidates ?? []).includes("shopping_agent") && g153.urgency?.deadline_source === "none", JSON.stringify(g153))
    const replay = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 480000, confirm: true })
    check("ADVERSE · replay: the same confirm again never re-executes — the hold is spent, so it becomes a fresh read-back", replay.needs_confirmation === true && recorded.length === 1)
    world.tables.agent_assistant_tool_calls.push({ id: "old-hold-1", brokerage_id: B1, session_id: SA, tool_name: "confirm_buyer_financials", tool_input: {}, success: true, ts: new Date(Date.now() - 11 * 60_000).toISOString(), tool_output: { needs_confirmation: true, governance: { decision: "hold", stage: "hold", hold: { digest: "x".repeat(32), expires_at: new Date(Date.now() - 60_000).toISOString() } } } })
    const { createHash } = await import("node:crypto")
    const digestOf = (p: Row) => createHash("sha256").update(JSON.stringify(Object.keys(p).filter((k) => k !== "confirm").sort().map((k) => [k, String(p[k]).trim().toLowerCase()]))).digest("hex").slice(0, 32)
    world.tables.agent_assistant_tool_calls[world.tables.agent_assistant_tool_calls.length - 1].tool_output.governance.hold.digest = digestOf({ contact_id: C1, approved_amount: 250000 })
    const expired = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 250000, confirm: true })
    check("ADVERSE · expiry: a read-back older than the hold window is never released (11 minutes > 10)", expired.needs_confirmation === true && recorded.length === 1)

    const { ledgerToolCall } = await import("../lib/kernel/action-ledger")
    let runs = 0
    const ctx = { brokerageId: B1, action: "ai.tool.confirm_buyer_financials", channel: "ai_tool", actor: { type: "user" as const, userId: UA }, subject: { type: "contact", id: C1 }, riskClass: "FINANCIAL", cycle: "voice_hold:race-1", trustClass: "model_output", sink: { verification: { kind: "authorized_human" as const, userId: UA, authority: "spoken_confirm_hold:race-1" } } }
    await ledgerToolCall(ctx, async () => { runs++; return { success: true } }, { client: world as never })
    const second = await ledgerToolCall(ctx, async () => { runs++; return { success: true } }, { client: world as never }) as Row
    check("ADVERSE · race: two releases of one hold reach the ledger with one cycle — the second claim replays and never runs", runs === 1 && second.success === true)

    world = mkWorld({ agent_assistant_tool_calls: "permission denied for table agent_assistant_tool_calls" })
    const blind = await call("conv-a", "confirm_buyer_financials", { contact_id: C1, approved_amount: 480000, confirm: true })
    check("ADVERSE · unreadable hold store: fail closed — DENY, nothing changes", !!blind.error && /couldn't verify your earlier confirmation/.test(String(blind.error)) && recorded.length === 1)
  }

  // ══ §F ══
  section("F · Play 6 — expired tenant key → parked delivery → repair → processed exactly once (lib/kernel/ingress-reconciliation.ts)")
  {
    const { runIngressReconciliation } = await import("../lib/kernel/ingress-reconciliation")
    const B = "b6b6b6b6-0000-4000-8000-000000000006"
    const CONN = "c6c6c6c6-0000-4000-8000-000000000006"
    const OTHER = "c7c7c7c7-0000-4000-8000-000000000007"
    const agreement = { scopes: ["motivated_seller_list"], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant", accepted_by_user_id: "u6", accepted_at: "2026-11-09T00:00:00.000Z" }
    const health = (status: string) => ({ kind: "hydrate", status, at: new Date().toISOString(), detail: null })
    const event = (id: string) => ({ eventId: id, propertyId: `prop-${id}`, addedToSubscriptionIds: ["sub-1"], removedFromSubscriptionIds: [] })
    const letter = (id: string, ref: string, kind = "smart-search-match") => ({ id, provider: "batchdata", event_kind: kind, external_ref: ref, payload: event(ref.split(":").pop()!), attempts: 0, status: "pending", created_at: new Date().toISOString() })
    const w = memSupabase({
      platform_credentials: [{ id: CONN, brokerage_id: B, platform: "batchdata", owner_type: "brokerage", api_key: "tenant-token-plain-0000000000", is_active: true, test_status: "fail", config: { agreement, territory: { state: "FL", zip_codes: ["32501"], city: "Pensacola" }, frequency: "push", last_health: health("auth_failed") } }],
      ingress_dead_letters: [letter("dl-1", `tenant:${CONN}:evt-1`), letter("dl-plat", "evt-platform-9"), letter("dl-other", `tenant:${OTHER}:evt-2`)],
      self_heal_events: [], raw_scraped_leads: [],
    }, { uuidIds: true, stampCreatedAt: true })
    const calls = { hydrate: [] as string[][], keys: [] as string[], ingest: [] as Row[], book: [] as Row[] }
    const landed = new Set<string>()
    let hydrateAnswer: "ok" | "quota" = "ok"
    const seams = { tenantPush: {
      hydrate: async (ids: string[], key: string) => { calls.hydrate.push(ids); calls.keys.push(key); return hydrateAnswer === "ok" ? { ok: true, properties: ids.map((id) => ({ propertyId: id, _id: id })), cost: 0.05 * ids.length } : { ok: false, properties: [], cost: null, error: "quota exceeded", httpStatus: 429 } },
      normalize: (r: Record<string, unknown>) => ({ source_record_id: String(r.propertyId), envelope: {} }) as never,
      ingest: async (p: Row) => { calls.ingest.push(p); let inserted = 0, replayed = 0; for (const rec of p.records as Row[]) { const k = String(rec.envelope?.externalEventId); if (landed.has(k)) replayed++; else { landed.add(k); inserted++ } } return { inserted, replayed, skipped_territory: 0 } as never },
      book: async (b: Row) => { calls.book.push(b); return true },
    } }
    const L = (id: string) => (w.tables.ingress_dead_letters as Row[]).find((r) => r.id === id)!
    const r1 = await runIngressReconciliation(w as never, new Date(), seams as never)
    check("refused key (auth_failed → revoked): the parked delivery WAITS — no hydrate against the provider (no re-charge), letter still pending", calls.hydrate.length === 0 && L("dl-1").status === "pending" && L("dl-1").attempts === 1, JSON.stringify(r1))
    check("ADVERSE · the platform door's own letter (no tenant: prefix) still falls to the unknown-kind rule — never replayed blindly", L("dl-plat").status === "pending" && calls.ingest.length === 0)
    check("ADVERSE · a letter naming a connection that does not exist (or another tenant's id) is never replayed", L("dl-other").status === "pending")
    const conn = (w.tables.platform_credentials as Row[])[0]
    conn.test_status = "pass"; conn.config = { ...conn.config, last_health: health("ok") }
    const r2 = await runIngressReconciliation(w as never, new Date(), seams as never)
    check("repaired → the parked delivery is hydrated ONCE under the TENANT's own key and lands in THE producer for that tenant", calls.hydrate.length === 1 && calls.keys[0] === "tenant-token-plain-0000000000" && calls.ingest.length === 1 && calls.ingest[0].brokerageId === B && L("dl-1").status === "reconciled", JSON.stringify(r2))
    check("…the hydrate spend is booked once as the tenant's (tenant_paid, never platform), with an idempotency key", calls.book.length === 1 && /tenant_webhook:/.test(String(calls.book[0].idempotencyKey ?? "")) && calls.book[0].coverage === "tenant_paid", JSON.stringify(calls.book[0] ?? {}))
    check("…the repair is a visible fact: self_heal_events healed, pinned to the tenant", (w.tables.self_heal_events as Row[]).some((r) => r.outcome === "healed" && r.brokerage_id === B && r.action === "replay_tenant_push"))
    await runIngressReconciliation(w as never, new Date(), seams as never)
    check("ADVERSE · replay: the reconciled letter is never processed again (one hydrate, one ingest, one booking)", calls.hydrate.length === 1 && calls.ingest.length === 1 && calls.book.length === 1)
    ;(w.tables.ingress_dead_letters as Row[]).push(letter("dl-dup", `tenant:${CONN}:evt-1`))
    hydrateAnswer = "ok"
    await runIngressReconciliation(w as never, new Date(), seams as never)
    check("ADVERSE · a duplicate parked copy of the same event is ONE observation (the producer's key counts it replayed; no second row)", landed.size === 1 && L("dl-dup").status === "reconciled")
    ;(w.tables.ingress_dead_letters as Row[]).push(letter("dl-3", `tenant:${CONN}:evt-3`))
    hydrateAnswer = "quota"
    await runIngressReconciliation(w as never, new Date(), seams as never)
    check("ADVERSE · the provider refuses again on replay: the letter stays pending and the connection's health is written (counted update)", L("dl-3").status === "pending" && conn.test_status === "fail" && conn.config.last_health?.status === "quota")
  }

  console.log("\n BLIND SPOTS: §A–§C prove each hop is live code in the named file (stripped source), not that every run reaches it — the named proofs carry behaviour; §E drives the real POST with the service client, server-only and the buyer-financials writer replaced (the lender path's library is not driven; its hold is the same boundary code); RLS is not modelled (the session row's brokerage pins every read); §F injects the provider seams (no BatchData call, no Lob, no network) — SIMULATED; the reconciler's own `reconciled` update is not row-counted (pre-existing; a re-run is idempotent through the producer's key and pre-pull dedup).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
