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
// Run: npx tsx scripts/manager-ownership-matrix-guard.ts [--write-doc]   (the summary line is `RESULT: N passed, M failed`)

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

// ── module interception (only the service-client constructor, server-only and the buyer-financials writer are replaced) ──
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = (...a) => globalThis.__MOG.svc(...a)",
  "@/app/actions/buyer-lifecycle-core": "export const recordBuyerFinancialVerification = async (a) => globalThis.__MOG.record(a); export const getBuyerFinancialStatus = async () => ({ status: 'unknown' })",
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

const DOC = "docs/architecture/MANAGER-OWNERSHIP-MATRIX.md"
const WAVE152 = /\bwave 152\b/i

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
  const structure = (s: string) => s.replace(/:\d+`/g, ":N`")
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
    const ctx = { brokerageId: B1, action: "ai.tool.confirm_buyer_financials", channel: "ai_tool", actor: { type: "user" as const, userId: UA }, subject: { type: "contact", id: C1 }, riskClass: "FINANCIAL", cycle: "voice_hold:race-1" }
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
