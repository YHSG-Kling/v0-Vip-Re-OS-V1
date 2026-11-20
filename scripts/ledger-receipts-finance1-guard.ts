/**
 * WAVE 155 (lane 155R2 — G12 "finance1"): every signed-in money write on this lane's row list leaves ONE receipt on
 * agent_action_ledger naming who (the SESSION user), which tenant (the SESSION's), what (a three-segment action), on what
 * (the subject row), under which risk class — through the ONE helper, lib/kernel/action-ledger.ts ledgerSessionAction.
 *
 * §A STATIC (stripped source, CLAUDE.md §2): each row export reaches the helper (directly, or by delegating to a wrapped
 *    export of this list), names a three-segment action with reasonCode HUMAN_REQUESTED and a user actor, and passes NO
 *    `cycle` / `idempotencyKey` (a key would turn a person's second save into a silent no-op). Rows re-classified as
 *    READ-ONLY must contain no write. Every finder carries a POSITIVE CONTROL (a planted specimen it must flag).
 * §B DRIVEN (in-memory client, SIMULATED): one export per module runs against memSupabase — exactly one receipt with
 *    actor, tenant, action, subject and risk class; a second identical call writes a SECOND receipt and runs again (the
 *    no-key rule — this is the regression canary); a refused domain write settles `failed`. Network is a counting seam
 *    that throws: no provider or model is ever called.
 * RED AT e88c1baa: no export on the list reached the helper (§A fails for every wrapped row; §B finds 0 receipts).
 * BLIND SPOTS: RLS is not modelled (the session client and the service client are the same in-memory client); the live
 *    CHECK / FK refusals the brief lists are asserted as SHAPES (regex, uuid, reason code), not against the database.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const ROOT = process.cwd()
let passes = 0, failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; console.log(`  ✓ ${name}`) } else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail.slice(0, 400)}` : ""}`) }
}
const section = (t: string): void => console.log(`\n── ${t}`)

// ── the row list (scripts/os-coverage-ledger.ts action ids) and what each row's closure is ────────────────────────────
type Closure = { kind: "wrapped" } | { kind: "delegates"; to: string } | { kind: "read_only" } | { kind: "open"; why: string }
const W: Closure = { kind: "wrapped" }
const ROWS: Record<string, Closure> = {
  "app/actions/cda-portal.ts#closeCdaAction": W, "app/actions/cda-portal.ts#confirmPreliminaryCdReviewAction": W,
  "app/actions/cda-portal.ts#manualOverrideCdaAction": W, "app/actions/cda-portal.ts#recordNonCdaPayoutPreferenceAction": W,
  "app/actions/cda-portal.ts#requestCdaChangesAction": W, "app/actions/cda-portal.ts#returnExternallySignedCdaAction": W,
  "app/actions/cda-portal.ts#runSignatureCheckForCdaAction": W, "app/actions/cda-portal.ts#uploadCdaCheckCopyAction": W,
  "app/actions/financials.ts#attachExpenseReceipt": W, "app/actions/financials.ts#deleteExpense": W,
  "app/actions/financials.ts#generateAIForecast": W, "app/actions/financials.ts#generatePLReport": W,
  "app/actions/financials.ts#rejectReceiptExpense": W,
  "app/actions/ai-financial-management.ts#aiCategorizeExpense": W, "app/actions/ai-financial-management.ts#aiCreateBudget": W,
  "app/actions/ai-financial-management.ts#aiGenerateProfitLossReport": W, "app/actions/ai-financial-management.ts#trackDeposit": W,
  "app/actions/brokerage-fees.ts#createFeeType": W, "app/actions/brokerage-fees.ts#markChargePaid": W,
  "app/actions/brokerage-fees.ts#toggleFeeType": W, "app/actions/brokerage-fees.ts#waiveCharge": W,
  "app/actions/brokerage-cda-setup.ts#deactivateCdaTemplateAction": { kind: "delegates", to: "updateCdaTemplateAction" },
  "app/actions/brokerage-cda-setup.ts#updateCdaTemplateAction": W, "app/actions/brokerage-cda-setup.ts#uploadCdaTemplateAction": W,
  "app/actions/buyer-financial.ts#connectBuyerToLender": W, "app/actions/buyer-financial.ts#getBrokerageLenders": { kind: "read_only" },
  "app/actions/buyer-financial.ts#upsertFinancialProfile": W,
  "app/actions/cda-template-field-actions.ts#generateFilledCdaPdfAction": W, "app/actions/cda-template-field-actions.ts#saveCdaFieldInputsAction": W,
  "app/actions/cda-template-field-actions.ts#saveCdaTemplateFieldDefsAction": W,
  "app/actions/financial-kernel.ts#attestCommissionReceivedAction": W, "app/actions/financial-kernel.ts#reconcileCommissionPaymentAction": W,
  "app/actions/financial-kernel.ts#recordCommissionDepositReceivedAction": W,
  "app/actions/tax-planning.ts#recordQuarterlyPaymentAction": W, "app/actions/tax-planning.ts#saveTaxAssumptionsAction": W,
  "app/actions/tax-planning.ts#saveTaxProfileAction": W,
  "app/actions/ai-referral-management.ts#generateReferralRequest": W, "app/actions/ai-referral-management.ts#identifyReferralOpportunities": W,
  "app/actions/portal-buyer-financial.ts#connectBuyerToLenderFromPortalAction": { kind: "delegates", to: "connectBuyerToLender" },
  "app/actions/portal-buyer-financial.ts#getBrokerageLendersFromPortalAction": { kind: "read_only" },
  "app/actions/referrals/referral-actions.ts#deletePartner": W, "app/actions/referrals/referral-actions.ts#sendReferralThankYou": W,
  "app/actions/referrals/referral-appreciation.ts#linkReferrerContactAction": W, "app/actions/referrals/referral-appreciation.ts#recordReferralGiftSentAction": W,
  "app/actions/transactions/tax-proration.ts#getTaxProrationAction": { kind: "read_only" },
  "app/actions/transactions/tax-proration.ts#saveTaxProrationAction": W,
  "app/actions/academy.ts#addTemplateFeedback": W, "app/actions/academy.ts#cloneTemplate": W,
  "app/actions/admin/agent-profile.ts#updateAgentProfileAction": W, "app/actions/admin/commission-agreement.ts#uploadCommissionAgreementFormAction": W,
  "app/actions/admin/referral-earnings.ts#acknowledgeReferralPayoutAction": W,
  "app/actions/commission-policy/agreements.ts#proposeAgreementTermsAction": { kind: "read_only" },
  "app/actions/commission-policy/commission-policy.ts#withdrawAgentConcessionAction": W,
  "app/actions/push-listing-to-seller-portal.ts#pushListingToSellerPortal": { kind: "open", why: "no session gate in the module (RLS-only) and a body-supplied tenant — the receipt has no session actor to name" },
  "app/actions/referrals/agent-referral-actions.ts#createAgentReferralAction": W,
  "app/actions/settings/create-commission-structure.ts#createCommissionStructure": W,
  "app/actions/settings/delete-commission-structure.ts#deleteCommissionStructure": W,
  "app/actions/settings/showing-financial-gate-setting.ts#setShowingFinancialGateRequired": W,
}

// ── §A helpers: the export's span in comment-blanked source (positions kept), braces matched on string-blanked text ──
function spanOf(code: string, fn: string): string | null {
  const m = new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`).exec(code)
  if (!m) return null
  const flat = blankStrings(code)
  // the body's `{` is the first `{` at paren depth 0 after the parameter list closes (a return-type literal may hold `{`)
  let i = m.index + m[0].length, depth = 1
  for (; i < flat.length && depth > 0; i++) { if (flat[i] === "(") depth++; else if (flat[i] === ")") depth-- }
  // Every export here is async, so a return-type literal's braces sit inside `Promise<…>` (angle depth > 0).
  let angle = 0, brace = -1
  for (; i < flat.length; i++) {
    const c = flat[i]
    if (c === "<") angle++; else if (c === ">" && flat[i - 1] !== "=") angle--
    else if (c === "{" && angle <= 0) { brace = i; break }
  }
  if (brace < 0) return null
  let d = 0
  for (let j = brace; j < flat.length; j++) { if (flat[j] === "{") d++; else if (flat[j] === "}") { d--; if (d === 0) return code.slice(m.index, j + 1) } }
  return null
}
const ACTION_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const WRITE_TOKEN = /\.\s*(?:insert|update|upsert|delete)\s*\(/
/** The finder: what is wrong with a wrapped span (empty = right). Reads comment-blanked code only. */
function wrapDefects(span: string): string[] {
  const out: string[] = []
  if (!/\bledgerSessionAction\s*\(/.test(blankStrings(span))) return ["does not reach ledgerSessionAction"]
  const ctx = span.slice(span.lastIndexOf("ledgerSessionAction("))
  const action = /action:\s*"([^"]*)"/.exec(ctx)?.[1]
  if (!action || !ACTION_RE.test(action)) out.push(`action '${action ?? "?"}' is not domain.entity.action`)
  if (!/reasonCode:\s*"HUMAN_REQUESTED"/.test(ctx)) out.push("reasonCode is not HUMAN_REQUESTED")
  if (!/actor:\s*\{\s*type:\s*"user",\s*userId:/.test(ctx)) out.push("actor is not the session user")
  if (!/riskClass:\s*"(READ|LOW_RISK_WRITE|COMMUNICATION|FINANCIAL|LEGAL|IRREVERSIBLE)"/.test(ctx)) out.push("risk class outside ToolRiskClass")
  if (/\b(cycle|idempotencyKey)\s*:/.test(blankStrings(ctx.split("\n")[0]))) out.push("passes a cycle / idempotencyKey (at-most-once) — none on this list is once-only")
  return out
}

async function main(): Promise<void> {
  section("A · static — every row export reaches the ONE helper, with no key (stripped source)")
  const codeOf = new Map<string, string>()
  const code = (f: string): string => { if (!codeOf.has(f)) codeOf.set(f, blankComments(readFileSync(join(ROOT, f), "utf8"))); return codeOf.get(f)! }
  const counts = { wrapped: 0, delegates: 0, read_only: 0, open: 0 }
  const actions = new Set<string>()
  for (const [id, cl] of Object.entries(ROWS)) {
    const [file, fn] = id.split("#")
    const span = spanOf(code(file), fn)
    counts[cl.kind]++
    if (!span) { check(`${id} — export found`, false, "span not found"); continue }
    if (cl.kind === "wrapped") {
      const d = wrapDefects(span)
      check(`${id} → ledgerSessionAction`, d.length === 0, d.join("; "))
      const a = /ledgerSessionAction\(\{[^\n]*?action:\s*"([^"]+)"/.exec(span)?.[1]; if (a) actions.add(a)
    } else if (cl.kind === "delegates") {
      const target = spanOf(code(file), cl.to) ?? spanOf(code("app/actions/buyer-financial.ts"), cl.to)
      check(`${id} → delegates to ${cl.to}, which is wrapped`, new RegExp(`\\b${cl.to}\\s*\\(`).test(blankStrings(span)) && !!target && wrapDefects(target).length === 0)
    } else if (cl.kind === "read_only") {
      check(`${id} — RE-CLASSIFIED read-only: no write token in its span`, !WRITE_TOKEN.test(blankStrings(span)))
    } else {
      check(`${id} — stays OPEN (${cl.why}); no receipt is claimed for it`, !/\bledgerSessionAction\s*\(/.test(span))
    }
  }
  console.log(`  rows ${Object.keys(ROWS).length}: wrapped ${counts.wrapped} · delegates ${counts.delegates} · read-only ${counts.read_only} · open ${counts.open}; distinct actions ${actions.size}`)
  check("the row list is exactly the lane's 58 rows", Object.keys(ROWS).length === 58)
  check("every wrapped export names a DISTINCT action (one vocabulary, no copy-paste name)", actions.size === counts.wrapped, `${actions.size} vs ${counts.wrapped}`)
  // POSITIVE CONTROLS — a broken finder and a clean tree both report zero (CLAUDE.md §2).
  const plantNoHelper = blankComments(`export async function x(i: { id: string }) {\n  // TOMBSTONE: ledgerSessionAction( used to be here — a comment is not a call site\n  const n = "ledgerSessionAction("\n  return svc.from("t").update({}).eq("id", i.id)\n}`)
  check("POSITIVE CONTROL · a write whose only 'call' is a comment / string literal is flagged", wrapDefects(spanOf(plantNoHelper, "x")!).length > 0)
  const plantKey = blankComments(`export async function y() {\n  const act = async () => {\n  return { success: true }\n  }; return (await ledgerSessionAction({ brokerageId: b, action: "finance.thing.save", actor: { type: "user", userId: u }, subject: { type: "t", id: i }, riskClass: "FINANCIAL", reasonCode: "HUMAN_REQUESTED", cycle: \`save:\${i}\` }, act))\n}`)
  check("POSITIVE CONTROL · a wrapper that passes a cycle (at-most-once key) is flagged", wrapDefects(spanOf(plantKey, "y")!).some((d) => /cycle/.test(d)))
  const plantTwoSeg = plantKey.replace("finance.thing.save", "finance.save").replace(/, cycle: `[^`]*`/, "")
  check("POSITIVE CONTROL · a two-segment action name is flagged", wrapDefects(spanOf(plantTwoSeg, "y")!).some((d) => /domain\.entity\.action/.test(d)))
  check("POSITIVE CONTROL · the read-only finder sees a write", WRITE_TOKEN.test(`await svc.from("x").update({ a: 1 })`))

  section("B · driven — one export per module against the in-memory client (SIMULATED)")
  const B = randomUUID(), U = randomUUID(), A = randomUUID(), C = randomUUID(), C2 = randomUUID(), T = randomUUID()
  const CDA = randomUUID(), TPL = randomUUID(), FT = randomUUID(), R = randomUUID(), CS = randomUUID(), TM = randomUUID()
  const P = randomUUID(), K = randomUUID(), E = randomUUID(), U2 = randomUUID()
  const seed = (): Record<string, Row[]> => ({
    agent_action_ledger: [],
    users: [{ id: U, brokerage_id: B, user_type: "broker", platform_role: null, email: "r2@finance1.test", first_name: "Rae", last_name: "Two", team_id: null }],
    agents: [{ id: A, user_id: U, brokerage_id: B, is_active: true }],
    brokerages: [{ id: B, name: "Finance One Realty" }],
    contacts: [
      { id: C, contact_id: randomUUID(), brokerage_id: B, agent_id: A, first_name: "Pat", last_name: "Buyer", email: "pat@finance1.test", contact_user_id: null },
      { id: C2, contact_id: randomUUID(), brokerage_id: B, agent_id: A, first_name: "Sam", last_name: "Portal", email: "r2@finance1.test", contact_user_id: U },
    ],
    transactions: [{ id: T, brokerage_id: B, agent_id: A, status: "pending" }],
    closing_disclosure_agreement: [{ id: CDA, brokerage_id: B, transaction_id: T, agent_id: A, revision_number: 1, status: "approved", cda_template_id: TPL }],
    brokerage_cda_templates: [{ id: TPL, brokerage_id: B, name: "Standard CDA", is_active: true }],
    brokerage_fee_types: [{ id: FT, brokerage_id: B, name: "Desk fee", is_active: true }],
    referrals: [{ id: R, brokerage_id: B, agent_id: A }],
    commission_structures: [{ id: CS, brokerage_id: B, name: "70/30" }],
    template_marketplace: [{ id: TM, template_name: "Sphere playbook", template_type: "playbook", metadata: {}, usage_count: 0 }],
    referral_payouts: [{ id: P, brokerage_id: B, status: "pending" }],
    commission_adjustments: [{ id: K, brokerage_id: B, transaction_id: T, approval_status: "pending", is_active: true }],
    business_expenses: [{ id: E, agent_id: A, brokerage_id: B, description: "Signs", amount: 40 }],
  })
  const G = globalThis as unknown as { __R2: { svc: unknown; ctx: Record<string, unknown>; user: Record<string, unknown> | null } }
  const agentCtx = { userId: U, agentId: A, brokerageId: B, teamId: null, userType: "broker", role: "broker", isAuthenticated: true, isImpersonating: false, impersonatorUserId: null, impersonationMode: null }
  G.__R2 = { svc: null, ctx: agentCtx, user: { id: U, email: "r2@finance1.test" } }
  const STUBS: Record<string, string> = {
    "server-only": "export{}",
    "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__R2.svc",
    "@/lib/supabase/server": "export const createClient = async () => globalThis.__R2.svc; export const createServerClient = createClient",
    "@/lib/identity/get-agent-context": "export const getAgentContext = async () => ({ ...globalThis.__R2.ctx }); export const requireSessionAgentId = async () => ({ ok: true, agentId: globalThis.__R2.ctx.agentId })",
    "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}",
    "next/headers": "export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }); export const headers = async () => new Headers()",
  }
  registerHooks({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module's ResolveHookSync shape (the repo's idiom)
    resolve(spec: string, ctx: any, next: any) {
      const s = STUBS[spec]
      return s !== undefined ? { url: `data:text/javascript,${encodeURIComponent(s)}`, shortCircuit: true } : next(spec, ctx)
    },
  })
  // Network is a counting seam that THROWS — a provider or model reached from any path is a failure, never a call.
  let netCalls = 0
  globalThis.fetch = (async () => { netCalls++; throw new Error("ledger-receipts-finance1: network is not allowed in this guard") }) as typeof fetch

  type Case = { mod: string; fn: string; args: unknown[]; action: string; stype: string; sid: string; risk: string; refuse?: Record<string, string>; ok?: (r: any) => boolean; ranTwice?: (mem: any) => boolean }
  const cases: Case[] = [
    { mod: "app/actions/cda-portal.ts", fn: "closeCdaAction", args: [{ cdaId: CDA }], action: "finance.cda.close", stype: "closing_disclosure_agreement", sid: CDA, risk: "FINANCIAL", ok: (r) => r?.success === true },
    { mod: "app/actions/financials.ts", fn: "deleteExpense", args: [E], action: "finance.expense.delete", stype: "business_expense", sid: E, risk: "FINANCIAL" },
    { mod: "app/actions/ai-financial-management.ts", fn: "trackDeposit", args: [{ agentId: A, transactionId: T, amount: 5000, depositType: "earnest_money", receivedDate: "2026-01-02" }], action: "finance.deposit.record", stype: "transaction", sid: T, risk: "FINANCIAL" },
    { mod: "app/actions/brokerage-fees.ts", fn: "toggleFeeType", args: [{ feeTypeId: FT, isActive: false }], action: "finance.fee_type.toggle", stype: "brokerage_fee_type", sid: FT, risk: "FINANCIAL", ok: (r) => r?.success === true,
      ranTwice: (m) => m.writes.filter((w: any) => w.table === "brokerage_fee_types").length === 2 },
    { mod: "app/actions/brokerage-cda-setup.ts", fn: "updateCdaTemplateAction", args: [{ id: TPL, name: "Standard CDA v2" }], action: "finance.cda_template.update", stype: "brokerage_cda_template", sid: TPL, risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/buyer-financial.ts", fn: "upsertFinancialProfile", args: [{ contactId: C, financeType: "conventional", isCashBuyer: false }], action: "buyer.financial_profile.upsert", stype: "contact", sid: C, risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/cda-template-field-actions.ts", fn: "saveCdaTemplateFieldDefsAction", args: [{ templateId: TPL, fields: [] }], action: "finance.cda_template.field_defs_save", stype: "brokerage_cda_template", sid: TPL, risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/financial-kernel.ts", fn: "recordCommissionDepositReceivedAction", args: [{ transactionId: T }], action: "finance.commission_deposit.record_received", stype: "transaction", sid: T, risk: "FINANCIAL" },
    { mod: "app/actions/tax-planning.ts", fn: "saveTaxProfileAction", args: [{ filingStatus: "single" }], action: "finance.tax_profile.save", stype: "agent", sid: A, risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/ai-referral-management.ts", fn: "generateReferralRequest", args: [{ contactId: randomUUID(), agentId: U, channel: "email" }], action: "referral.request.ai_draft", stype: "contact", sid: "", risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/portal-buyer-financial.ts", fn: "connectBuyerToLenderFromPortalAction", args: [{ contactId: C2, partnerId: randomUUID(), partnerName: "First Lender" }], action: "buyer.lender_referral.connect", stype: "contact", sid: C2, risk: "LOW_RISK_WRITE" },
    { mod: "app/actions/referrals/referral-actions.ts", fn: "sendReferralThankYou", args: [R], action: "referral.thank_you.mark_sent", stype: "referral", sid: R, risk: "LOW_RISK_WRITE", ok: (r) => r?.success === true,
      ranTwice: (m) => m.writes.filter((w: any) => w.table === "referrals").length === 2 },
    { mod: "app/actions/referrals/referral-appreciation.ts", fn: "recordReferralGiftSentAction", args: [R], action: "referral.gift.record_sent", stype: "referral", sid: R, risk: "LOW_RISK_WRITE", ok: (r) => r?.ok === true },
    { mod: "app/actions/transactions/tax-proration.ts", fn: "saveTaxProrationAction", args: [{ transactionId: T, annualTax: 3600, periodStart: "2026-01-01", timing: "arrears", closeDate: "2026-06-30", closingDayOwner: "buyer", dayBasis: "365", source: "tax_bill" }], action: "transaction.tax_proration.save", stype: "transaction", sid: T, risk: "FINANCIAL" },
    { mod: "app/actions/academy.ts", fn: "addTemplateFeedback", args: [{ templateId: TM, feedbackType: "comment", comment: "useful", rating: 5 }], action: "academy.template_feedback.add", stype: "template_marketplace", sid: TM, risk: "LOW_RISK_WRITE", ok: (r) => r?.success === true,
      ranTwice: (m) => m.tables.template_feedback?.length === 2 },
    { mod: "app/actions/admin/agent-profile.ts", fn: "updateAgentProfileAction", args: [{ targetUserId: U2 }], action: "finance.agent_profile.update", stype: "user", sid: U2, risk: "FINANCIAL" },
    { mod: "app/actions/admin/commission-agreement.ts", fn: "uploadCommissionAgreementFormAction", args: [{ fileName: "a.pdf", base64: "", formName: "", fields: [] }], action: "finance.commission_agreement_form.upload", stype: "brokerage", sid: B, risk: "LEGAL", ok: (r) => r?.ok === false },
    { mod: "app/actions/admin/referral-earnings.ts", fn: "acknowledgeReferralPayoutAction", args: [{ payoutId: P }], action: "finance.referral_payout.acknowledge_received", stype: "referral_payout", sid: P, risk: "FINANCIAL" },
    { mod: "app/actions/commission-policy/commission-policy.ts", fn: "withdrawAgentConcessionAction", args: [{ concessionId: K }], action: "finance.commission_concession.withdraw", stype: "commission_adjustment", sid: K, risk: "FINANCIAL" },
    { mod: "app/actions/referrals/agent-referral-actions.ts", fn: "createAgentReferralAction", args: [{ receivingAgentId: randomUUID(), contactId: C, feePct: 25 }], action: "referral.agent_referral.create", stype: "contact", sid: C, risk: "FINANCIAL" },
    { mod: "app/actions/settings/create-commission-structure.ts", fn: "createCommissionStructure", args: [{ name: "80/20", brokerage_id: randomUUID() }], action: "finance.commission_structure.create", stype: "brokerage", sid: B, risk: "FINANCIAL",
      ok: (r) => !!r?.data && r.data.brokerage_id === B },
    { mod: "app/actions/settings/delete-commission-structure.ts", fn: "deleteCommissionStructure", args: [CS], action: "finance.commission_structure.delete", stype: "commission_structure", sid: CS, risk: "FINANCIAL", ok: (r) => r?.success === true },
    { mod: "app/actions/settings/showing-financial-gate-setting.ts", fn: "setShowingFinancialGateRequired", args: [true], action: "brokerage.showing_financial_gate.set", stype: "brokerage", sid: B, risk: "LOW_RISK_WRITE" },
  ]
  const drivenModules = new Set<string>()
  for (const c of cases) {
    const mem = memSupabase(seed(), { uuidIds: true, refuse: c.refuse }) as any
    mem.auth = { getUser: async () => ({ data: { user: G.__R2.user }, error: null }) }
    G.__R2.svc = mem
    let mod: Record<string, (...a: unknown[]) => Promise<unknown>>
    try { mod = await import(join(ROOT, c.mod)) } catch (e) { check(`${c.mod} loads`, false, (e as Error).message); continue }
    const rows = (): Row[] => (mem.tables.agent_action_ledger as Row[]).filter((r) => r.action === c.action)
    let r1: unknown, r2: unknown, threw: string | null = null
    try { r1 = await mod[c.fn](...c.args) } catch (e) { threw = (e as Error).message }
    const one = rows()
    const first = one[0]
    const sidOk = c.sid ? first?.subject_id === c.sid : typeof first?.subject_id === "string"
    check(`${c.fn} · ONE receipt: actor = session user, tenant = session, '${c.action}', subject ${c.stype}, ${c.risk}${threw ? ` (run threw: ${threw.slice(0, 60)})` : ""}`,
      one.length === 1 && first.actor_type === "user" && first.actor_user_id === U && first.brokerage_id === B && first.subject_type === c.stype && sidOk &&
      first.risk_class === c.risk && first.reason_code === "HUMAN_REQUESTED" && first.status !== "proposed" && first.idempotency_key == null && ACTION_RE.test(String(first.action)),
      JSON.stringify(first ?? { rows: one.length, result: r1 }))
    console.log(`      first receipt settled '${first?.status}'${first?.error ? ` (${String(first.error).slice(0, 90)})` : ""}`)
    if (c.ok) check(`${c.fn} · the caller's result is unchanged by the receipt`, c.ok(r1), JSON.stringify(r1))
    try { r2 = await mod[c.fn](...c.args) } catch { /* settled + rethrown — the receipt below is the proof */ }
    const two = rows()
    check(`${c.fn} · NO-KEY CANARY: the same call again writes a SECOND receipt and runs again (both settled)`,
      two.length === 2 && two.every((r) => r.status !== "proposed"), JSON.stringify(two.map((r) => r.status)))
    if (c.ranTwice) check(`${c.fn} · …and the domain write happened twice`, c.ranTwice(mem), JSON.stringify(r2))
    drivenModules.add(c.mod)
  }
  // A refused domain write settles FAILED (the helper's one result-reading rule).
  {
    const mem = memSupabase(seed(), { uuidIds: true, refuse: { brokerage_fee_types: "permission denied for table brokerage_fee_types" } }) as any
    mem.auth = { getUser: async () => ({ data: { user: G.__R2.user }, error: null }) }
    G.__R2.svc = mem
    const fees = await import(join(ROOT, "app/actions/brokerage-fees.ts")) as { toggleFeeType: (p: unknown) => Promise<{ success: boolean; error?: string }> }
    const r = await fees.toggleFeeType({ feeTypeId: FT, isActive: true })
    const row = (mem.tables.agent_action_ledger as Row[]).find((x) => x.action === "finance.fee_type.toggle")
    check("FAILED · a refused fee-type write returns the refusal unchanged and settles the receipt failed", r.success === false && row?.status === "failed", JSON.stringify({ r, row }))
  }
  // A signed-out caller: no session tenant → no receipt is invented (the gate refuses before the wrapper opens).
  {
    const mem = memSupabase(seed(), { uuidIds: true }) as any
    mem.auth = { getUser: async () => ({ data: { user: null }, error: null }) }
    G.__R2.svc = mem
    const ref = await import(join(ROOT, "app/actions/referrals/referral-appreciation.ts")) as { recordReferralGiftSentAction: (id: string) => Promise<{ ok: boolean }> }
    const r = await ref.recordReferralGiftSentAction(R)
    check("NEGATIVE · signed out: refused, nothing written, and no receipt with an invented tenant", r.ok === false && (mem.tables.agent_action_ledger as Row[]).length === 0 && !mem.writes.some((w: any) => w.table === "referrals"))
  }
  const modules = new Set(Object.keys(ROWS).filter((id) => ROWS[id].kind === "wrapped" || ROWS[id].kind === "delegates").map((id) => id.split("#")[0]))
  const undriven = [...modules].filter((m) => !drivenModules.has(m))
  console.log(`  modules with a wrapped / delegating row: ${modules.size}; driven: ${[...modules].filter((m) => drivenModules.has(m)).length}; undriven: ${undriven.join(", ") || "none"}`)
  check("every module with a wrapped row is DRIVEN at least once", undriven.length === 0, undriven.join(", "))
  check(`network seam: ${netCalls} provider / model calls (must be 0)`, netCalls === 0)

  console.log(`\nGUARD_RESULT ledger-receipts-finance1: ${passes} passed, ${failures} failed (SIMULATED — in-memory clients, counting seams)`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
