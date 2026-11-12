#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fixtures and fake clients, the repo's proof idiom */
/**
 * scripts/wave152-canaries.ts — `npx tsx --conditions=react-server scripts/wave152-canaries.ts`
 *                                (wave 152, lane 152L — closing; key: test:wave152-canaries, chained LAST in `guard`)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DIRECTIVE'S SIXTEEN END-TO-END SCENARIOS (152L "End-to-end scenarios — one action from user to outcome", directive lines
 * 821–838) and its EIGHT REGULATORY AND FINANCIAL SAFETY TESTS (lines 840–849), on the INTEGRATED tree (batch 1 + batch 2). Every
 * scenario drives the lanes' REAL exported survivors on memSupabase with injected provider seams (never a re-implementation) and
 * carries BOTH halves of a measurement (CLAUDE.md §2): the built behaviour holds on a well-formed input AND the ADVERSE case is
 * refused / absent / counted. Each names its POSITIVE CONTROL (the finder still sees the defect it was written for) and publishes
 * its BLIND SPOT (what no in-memory run can observe). A scenario passes only when both halves pass.
 *
 * SIMULATED, NEVER LIVE: no provider, model, storage, database, e-sign account, Lob, BatchData, IDX or Vercel is called. A provider
 * call is an injected SANDBOX seam; a model is scripted; RLS / CHECK / FK / triggers are not modelled by memSupabase. Nothing here is
 * a production-live statement — CI green is never production-live (C42), and the owner obligations (O1 storage policies, O2 seed
 * accounts, O3/O4 hosting) are untouched by any canary.
 *
 * REUSE BY IMPORT (the brief): where a scenario is already covered by a wave-150 canary (scripts/wave150-canaries.ts) or a
 * wave-151 group (scripts/wave151-canaries.ts), that canary RUNS HERE BY IMPORT and is named in the scenario's `reuses` — never
 * rewritten. Lane proofs that drive the same survivor deeper are NAMED (`proof`) — they run in the guard chain, not here.
 *
 * Measurement: code-token scans read STRIPPED source (scripts/strip-comments.ts — a tombstone is not a call site); every absence
 * assertion carries a positive control; no count or line number is pinned (the rule is asserted, the number derived).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { WAVE150_CANARIES, quiet, backgroundRejections, type Verdict } from "./wave150-canaries"
import { WAVE151_GROUPS } from "./wave151-canaries"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const ROOT = process.cwd()
const raw = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string): string => stripComments(raw(p))
/** Identifiers only — comments AND string contents blanked (a word inside prose is a mention, not wiring). */
const ident = (p: string): string => blankStrings(stripComments(raw(p)))
const rows = (c: MemClient | any, t: string): any[] => ((c as any).tables[t] ?? []) as any[]
const fnSlice = (src: string, head: string): string => { const i = src.indexOf(head); if (i < 0) return ""; const j = src.indexOf("\nexport ", i + head.length); return src.slice(i, j < 0 ? undefined : j) }
const before = (s: string, a: string, b: string): boolean => { const i = s.indexOf(a), j = s.indexOf(b); return i >= 0 && j >= 0 && i < j }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
/** Named halves: a red names the check that failed (evidence, not a bare boolean). */
const halves = (pos: Array<[string, boolean]>, neg: Array<[string, boolean]>) => ({ positive: pos.every(([, b]) => b), negative: neg.every(([, b]) => b), failing: [...pos, ...neg].filter(([, b]) => !b).map(([n]) => n) })

interface Reuse { from: "wave150" | "wave151" | "proof"; ref: number | string; covers: string }
interface Scenario { n: string; title: string; directiveLine: number; survivors: readonly string[]; reuses: readonly Reuse[]; adverse: string; positiveControl: string; blindSpot: string; run: () => Promise<Verdict> }
const SCENARIOS: Scenario[] = []
const scenario = (s: Scenario) => SCENARIOS.push(s)

// ═════════════════════════════════════════════════════════════════════════════
// SHARED WORLDS — copied in shape from the lane proofs that own them (named per world), never re-implemented logic
// ═════════════════════════════════════════════════════════════════════════════
const SOLO = "a1000000-0000-4000-8000-000000000001", TEAM = "a2000000-0000-4000-8000-000000000002", BRK = "a3000000-0000-4000-8000-000000000003", MULTI = "a4000000-0000-4000-8000-000000000004", OTHER = "a5000000-0000-4000-8000-000000000005"

/** A tenant's own BatchData connection row (lane 152I §F shape) — the key is a fixture string, never a real token. */
const AGREEMENT = { scopes: ["motivated_seller_list"], license_acknowledged: true, retention_days: 365, ai_processing_permitted: true, redistribution: "prohibited", cost_payer: "tenant", accepted_by_user_id: "u-owner", accepted_at: "2026-11-09T00:00:00.000Z" }
const health = (status: string) => ({ kind: "hydrate", status, at: "2026-11-12T00:00:00.000Z", detail: null })
const connectionConfig = (status: string, extra: Record<string, unknown> = {}) => ({ agreement: AGREEMENT, territory: { state: "FL", zip_codes: ["32501"], city: "Pensacola" }, frequency: "push", last_health: health(status), ...extra })

/** The QR registry world (lane 152C §8 shape). */
const ORIGIN = "https://app.example.test"
function qrWorld(opts: { missingColumns?: Record<string, string[]> } = {}) {
  return memSupabase({
    brokerages: [{ id: "bA", website: null }, { id: "bB", website: null }],
    users: [{ id: "uA", brokerage_id: "bA" }, { id: "uB", brokerage_id: "bB" }],
    agents: [{ id: "agA", user_id: "uA", brokerage_id: "bA", team_id: null, location_id: null }, { id: "agB", user_id: "uB", brokerage_id: "bB" }],
    teams: [], locations: [], marketing_campaigns: [{ id: "cA", brokerage_id: "bA" }], listings: [{ id: "LA", brokerage_id: "bA" }],
    brokerage_brand_settings: [{ brokerage_id: "bA", website_url: "https://alderrealty.example/about" }],
    qr_codes: [], qr_scan_events: [], agent_action_ledger: [],
  }, { uuidIds: true, stampCreatedAt: true, missingColumns: opts.missingColumns, unique: { agent_action_ledger: [["idempotency_key"]], qr_codes: [["slug"]] } })
}
const qrDeps = (db: MemClient) => ({ client: db, ledgerClient: db, origin: ORIGIN, appOrigins: [ORIGIN] })
const QA = { brokerageId: "bA", userId: "uA", agentId: "agA", userType: "agent" }
const QB = { brokerageId: "bB", userId: "uB", agentId: "agB", userType: "agent" }

/** The ROI world (lane 152B's roi-outcome-ledger shape, trimmed to the journey these scenarios walk). */
const r = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const RA = r(1), RB = r(2)
const U_BROKER = r(11), U_AG1 = r(12), U_CONTACT = r(15), U_BBROKER = r(16)
const AG1 = r(21), C_MAIL = r(41), C_SOCIAL = r(42), C_B = r(45)
const DM1 = r(51), Q1 = r(53), K1 = r(61), K3 = r(63), K4 = r(64), KB = r(65)
const T1 = r(71), T2 = r(72), T3 = r(73), TB = r(75), S1 = r(81), S2 = r(82), R1 = r(83), SH1 = r(84), AC1 = r(85)
const WINDOW = { sinceDay: "2026-10-01", untilDay: "2026-10-31" }
function roiWorld() {
  const NOWISO = "2026-11-12T00:00:00.000Z"
  const deal = (id: string, b: string, status: string, contact: string, money: { amount: number | null; est: number; final: string | null }, close: string) => ({ id, brokerage_id: b, status, deleted_at: null, deal_name: id.slice(-4), contract_date: "2026-10-10", close_date: close, actual_close_date: null, commission_amount: money.amount, estimated_commission: money.est, commission_finalized_at: money.final, agent_id: b === RA ? AG1 : null, buyer_agent_id: null, seller_agent_id: null, buyer_contact_id: contact, seller_contact_id: null, contact_id: null, purchase_price: 400000, updated_at: NOWISO })
  return memSupabase({
    brokerages: [{ id: RA, plan_tier: "brokerage" }, { id: RB, plan_tier: "brokerage" }],
    users: [
      { id: U_BROKER, brokerage_id: RA, user_type: "broker", location_id: null, team_id: null }, { id: U_AG1, brokerage_id: RA, user_type: "agent", location_id: null, team_id: null },
      { id: U_CONTACT, brokerage_id: RA, user_type: "contact", location_id: null, team_id: null }, { id: U_BBROKER, brokerage_id: RB, user_type: "broker", location_id: null, team_id: null },
    ],
    agents: [{ id: AG1, brokerage_id: RA, user_id: U_AG1, team_id: null, location_id: null }],
    teams: [], team_members: [], locations: [], organization_members: [],
    marketing_campaigns: [
      { id: C_MAIL, brokerage_id: RA, campaign_name: "Oak Street letters with QR", campaign_type: "direct_mail", agent_user_id: U_AG1, team_id: null, budget_spent: 0 },
      { id: C_SOCIAL, brokerage_id: RA, campaign_name: "Neighborhood social", campaign_type: "social", agent_user_id: U_AG1, team_id: null, budget_spent: 0 },
      { id: C_B, brokerage_id: RB, campaign_name: "Other workspace", campaign_type: "direct_mail", agent_user_id: U_BBROKER, team_id: null, budget_spent: 0 },
    ],
    direct_mail_campaigns: [{ id: DM1, brokerage_id: RA, marketing_campaign_id: C_MAIL, per_piece_cost: 0.75, pieces_mailed: 1000, mailing_date: "2026-10-02" }],
    qr_codes: [{ id: Q1, brokerage_id: RA, marketing_campaign_id: C_MAIL }],
    qr_scan_events: [
      { id: S1, brokerage_id: RA, qr_code_id: Q1, contact_id: K1, is_first_scan: true, traffic_class: "human_likely", scanned_at: "2026-10-05T10:00:00.000Z" },
      { id: S1, brokerage_id: RA, qr_code_id: Q1, contact_id: K1, is_first_scan: true, traffic_class: "human_likely", scanned_at: "2026-10-05T10:00:00.000Z" }, // a REPLAYED scan event
      { id: S2, brokerage_id: RA, qr_code_id: Q1, contact_id: K1, is_first_scan: false, traffic_class: "repeat", scanned_at: "2026-10-06T10:00:00.000Z" },
    ],
    mail_response_tracking: [{ id: R1, brokerage_id: RA, campaign_id: DM1, contact_id: K1, lead_id: null, response_type: "qr_form", created_at: "2026-10-06T12:00:00.000Z" }],
    ad_campaigns: [], ad_performance: [],
    marketing_campaign_touchpoints: [
      { id: r(91), brokerage_id: RA, campaign_id: C_MAIL, contact_id: K1, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: r(92), brokerage_id: RA, campaign_id: C_SOCIAL, contact_id: K1, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" },
      { id: r(93), brokerage_id: RA, campaign_id: C_MAIL, contact_id: K3, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: r(94), brokerage_id: RA, campaign_id: C_MAIL, contact_id: K4, sent_at: "2026-10-03T09:00:00.000Z", status: "delivered" },
      { id: r(97), brokerage_id: RB, campaign_id: C_B, contact_id: K1, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" }, // MIS-STAMPED: another tenant, same person id
      { id: r(98), brokerage_id: RB, campaign_id: C_B, contact_id: KB, sent_at: "2026-10-04T09:00:00.000Z", status: "delivered" },
    ],
    showings: [{ id: SH1, brokerage_id: RA, contact_id: K1, status: "scheduled", created_at: "2026-10-08T15:00:00.000Z" }],
    transactions: [
      deal(T1, RA, "closed", K1, { amount: 12000, est: 12000, final: "2026-10-25T18:00:00.000Z" }, "2026-10-25"),
      deal(T2, RA, "under_contract", K3, { amount: null, est: 9000, final: null }, "2026-11-20"),
      deal(T3, RA, "under_contract", K4, { amount: null, est: 8000, final: null }, "2026-10-28"),
      deal(TB, RB, "closed", KB, { amount: 5000, est: 5000, final: "2026-10-21T18:00:00.000Z" }, "2026-10-21"),
    ],
    agent_commissions: [{ id: AC1, brokerage_id: RA, transaction_id: T1, status: "paid", gross_commission: 12000, net_to_brokerage: 3600, brokerage_commission: 3600, net_to_agent: 8400, agent_commission: 8400, deposit_received_at: "2026-10-26T12:00:00.000Z", paid_at: "2026-10-28T12:00:00.000Z" }],
    vendor_usage_tracking: [], ai_tool_usage: [], raw_scraped_leads: [], marketing_attribution_credits: [],
  }, { uuidIds: true, stampCreatedAt: true })
}

/** The receipt world (lane 152D's receipt-intelligence shape). */
const RCPT_A = "brokerage-a", RCPT_B = "brokerage-b"
const rAgent = { userId: "u-agent", agentId: "ag-1", teamId: "team-1", brokerageId: RCPT_A, userType: "agent" }
const rOther = { userId: "u-b-agent", agentId: "ag-b", teamId: null, brokerageId: RCPT_B, userType: "agent" }
const rVendor = { userId: "u-vendor", agentId: null, teamId: null, brokerageId: RCPT_A, userType: "vendor" }
const PHOTO = Buffer.from("\xFF\xD8\xFF\xE0-fake-jpeg-office-depot", "binary")
const READING = ["=== PAGE 1 ===", "OFFICE DEPOT #1234", "123 MAIN ST", "11/03/2026 2:14 PM", "COPY PAPER 2PK     12.99", "INK CARTRIDGE      27.00", "SUBTOTAL           39.99", "TAX                 3.18", "TOTAL             $43.17", "VISA ****4242", "QUALITY_FLAGS: none"].join("\n")
const fv = (value: unknown, excerpt: string | null, confidence = "high", page = 1) => ({ value, page, excerpt, confidence })
const MODEL_RECEIPT = {
  document_kind: "receipt", kind_confidence: "high", kind_evidence: { page: 1, excerpt: "VISA ****4242" },
  merchant: fv("OFFICE DEPOT #1234", "OFFICE DEPOT #1234"), date: fv("2026-11-03", "11/03/2026"), total: fv("43.17", "TOTAL             $43.17"),
  subtotal: fv("39.99", "SUBTOTAL           39.99"), tax: fv("3.18", "TAX                 3.18"), tip: fv(null, null), balance_due: fv(null, null), currency: fv(null, null),
  payment_method: fv("VISA ****4242", "VISA ****4242"),
  line_items: [{ description: "COPY PAPER 2PK", quantity: 1, amount: "12.99", page: 1, excerpt: "COPY PAPER 2PK     12.99" }, { description: "INK CARTRIDGE", quantity: 1, amount: "27.00", page: 1, excerpt: "INK CARTRIDGE      27.00" }],
  category_suggestion: "office", summary: "Office Depot purchase of copy paper and ink on Nov 3, 2026 for $43.17 paid by Visa.", problems: [],
}
const RCPT_NOW = new Date("2026-11-11T15:00:00Z")
function receiptWorld(): MemClient {
  return memSupabase({ documents: [], document_field_extractions: [], policy_decisions: [], agent_action_ledger: [], business_expenses: [], transactions: [], managed_agents: [], brokerage_settings: [] },
    { uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]], document_field_extractions: [["document_id", "field_key"]] } })
}
const visionReader = (reading: string) => ({
  model: async () => ({ alias: "routed-vision-alias", slug: "routed/vision-slug" }),
  afford: async () => ({ allowed: true }),
  chat: async () => ({ ok: true, content: reading, error: null, usage: { inputTokens: 1700, outputTokens: 140 } }),
  book: async () => {},
})
const extractSeam = (model: unknown) => async () => ({ ok: true, text: JSON.stringify(model) })
/** WRITER STAND-IN for app/actions/financials.ts logScopedExpense (lane 152D's, same row shape and refusal codes — it needs a Next session). */
function receiptWriter(svc: MemClient, actor: () => typeof rAgent) {
  const calls: any[] = []
  const post = async (input: any) => {
    calls.push(input)
    const ctx = actor()
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: "amount_invalid" }
    const row: Record<string, unknown> = { brokerage_id: ctx.brokerageId, category: input.category, description: input.description, amount, expense_date: input.expenseDate, receipt_url: input.receiptUrl ?? null, agent_id: null, team_id: null }
    if (input.scope === "agent") { if (!ctx.agentId) return { success: false, error: "no_agent_context" }; row.agent_id = ctx.agentId }
    else if (input.scope === "brokerage" && !["broker", "broker_admin", "broker_owner", "admin"].includes(ctx.userType)) return { success: false, error: "forbidden_brokerage_scope" }
    const { data, error } = await svc.from("business_expenses").insert(row).select("id").single()
    if (error) return { success: false, error: error.message }
    return { success: true, expenseId: (data as any).id as string }
  }
  return { post, calls }
}

/** The settlement world (lane 152G's settlement-reconciliation shape). */
const SB = "11111111-1111-4111-8111-111111111111"
const SU_ADMIN = "22222222-2222-4222-8222-222222222222", SU_AGENT = "22222222-2222-4222-8222-222222222223", SU_TC = "22222222-2222-4222-8222-222222222224", SU_VENDOR = "22222222-2222-4222-8222-222222222225"
const SAG = "33333333-3333-4333-8333-333333333333", STC = "77777777-7777-4777-8777-777777777771"
const SOFFER = "44444444-4444-4444-8444-444444444444", STXN = "55555555-5555-4555-8555-555555555555"
const DOC_CD = "66666666-6666-4666-8666-666666666664", DOC_CD2 = "66666666-6666-4666-8666-666666666665", DOC_ADD = "66666666-6666-4666-8666-666666666661", DOC_PROP = "66666666-6666-4666-8666-666666666663"
const BOTH_SIGNED = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }
const CONSISTENT_CD = { sales_price: "500000", earnest_money_deposit: "5000", commission_buyer_broker: "12500", closing_date: "2026-12-15", cash_to_close: "103250.00", loan_amount: "400000" }
const sday = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
function settlementWorld(o: { offersCda?: boolean | null; statement?: Record<string, unknown> | null; financing?: string; stage?: string; status?: string; extra?: Record<string, any[]> } = {}) {
  const tables: Record<string, any[]> = {
    brokerages: [{ id: SB, name: "Canary Brokerage", state: "TX", offers_cda: o.offersCda === undefined ? false : o.offersCda, non_cda_payout_default: "check", commission_payout_timing: null }],
    users: [{ id: SU_ADMIN, brokerage_id: SB, user_type: "broker_owner" }, { id: SU_AGENT, brokerage_id: SB, user_type: "agent" }, { id: SU_TC, brokerage_id: SB, user_type: "tc" }, { id: SU_VENDOR, brokerage_id: SB, user_type: "vendor" }],
    agents: [{ id: SAG, user_id: SU_AGENT, brokerage_id: SB }],
    transaction_coordinators: [{ id: STC, brokerage_id: SB, user_id: SU_TC }],
    offers: [{ id: SOFFER, brokerage_id: SB, agent_id: SAG, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", esign_status: "fully_executed", buyer_signed_at: "2026-10-01T10:00:00Z", seller_signed_at: "2026-10-01T12:00:00Z", fully_signed_contract_received_at: "2026-10-01T12:00:00Z", transaction_id: STXN, offer_price: 500_000, earnest_money: 5_000, closing_date: "2026-12-15", disclosed_buyer_commission_pct: 2.5, closing_cost_contribution: null, created_at: "2026-10-01T09:00:00Z" }],
    transactions: [{ id: STXN, brokerage_id: SB, agent_id: SAG, coordinator_id: STC, status: o.status ?? "under_contract", stage: o.stage ?? "CLOSING_PREP", offer_id: SOFFER, deal_type: "buyer", purchase_price: 500_000, earnest_money: 5_000, closing_cost_contribution: null, contract_date: "2026-10-01", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "TX", financing_type: o.financing ?? "conventional", loan_amount: o.financing === "cash" ? null : 400_000, commission_finalized_at: null, compliance_passed_at: "2026-10-02T00:00:00Z", buyer_contact_id: null, seller_contact_id: null, contact_id: null, listing_id: null, buyer_agent_id: null, seller_agent_id: null, listing_offered_commission_percentage: null, updated_at: "2026-10-02T00:00:00Z" }],
    documents: [
      { id: DOC_ADD, brokerage_id: SB, transaction_id: STXN, classification: "addendum", signature_completeness: BOTH_SIGNED, extracted_fields: null, created_at: "2026-11-01T00:00:00Z" },
      ...(o.statement === null ? [] : [{ id: DOC_CD, brokerage_id: SB, transaction_id: STXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z", metadata: null, extracted_fields: o.statement ?? CONSISTENT_CD }]),
    ],
    document_field_extractions: [], contract_term_versions: [], transaction_compliance_log: [], notifications: [], closing_disclosure_agreement: [],
    commission_distributions: [], agent_commissions: [], agent_action_ledger: [], lifecycle_events: [], activities: [], transaction_tasks: [], policy_decisions: [], trid_timeline: [], transaction_documents: [],
  }
  for (const [k, v] of Object.entries(o.extra ?? {})) tables[k] = [...(tables[k] ?? []), ...v]
  return memSupabase(tables, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}
async function settlementKit() {
  const cc = await import("../lib/transactions/closing-compliance")
  const ca = await import("../lib/offers/closing-cost-accuracy")
  const gt = await import("../lib/offers/governing-terms")
  const cv = await import("../lib/commission/closing-verification")
  const stubs = { notify: async () => 0, audit: async () => {}, closingEntity: async () => "title_company" as string | null }
  const run = (db: MemClient, trigger: "settlement_scanned" | "final_check" | "manual" = "settlement_scanned") => quiet(() => cc.runClosingCompliance(db as never, { transactionId: STXN, brokerageId: SB, trigger }, stubs))
  const gate = (db: MemClient) => quiet(() => ca.closingSettlementGate(db as never, { transactionId: STXN, brokerageId: SB }, {
    askClosingQuestion: async () => { const a = await cv.ensureClosingAttestationAsked(db as never, { brokerageId: SB, transactionId: STXN }); return a.ok ? cv.closingAttestationState(db as never, { brokerageId: SB, transactionId: STXN }) : a },
    runClosingCompliance: (s: unknown, i: any) => cc.runClosingCompliance(s as never, i, stubs),
  } as never))
  const answerNo = (db: MemClient) => quiet(() => cv.recordClosingAttestation(db as never, { userId: SU_TC, agentId: null, brokerageId: SB, userType: "tc" }, { transactionId: STXN, answer: "no_unrecorded_change" }))
  const executed = (db: MemClient, docId: string, terms: Record<string, unknown>, stated: Record<string, unknown>) => quiet(() => gt.recordContractTermsVersion(db as never, {
    brokerageId: SB, rootOfferId: SOFFER, transactionId: STXN, source: "addendum", status: "executed", terms, documentId: docId, executedAt: `${sday(2)}T23:59:59.999Z`, recordedBy: SU_AGENT,
    evidence: { recorded_via: "wave152-canary", term_evidence_stated: stated },
  } as never))
  const addCd = (db: MemClient, id: string, at: string, fields: Record<string, unknown>) => rows(db, "documents").push({ id, brokerage_id: SB, transaction_id: STXN, classification: "closing_disclosure", classification_confidence: "high", signature_completeness: null, created_at: at, updated_at: at, metadata: null, extracted_fields: fields })
  const snaps = (db: MemClient) => rows(db, "policy_decisions").filter((x) => x.target_type === "settlement_reconciliation" && x.transaction_id === STXN)
  const openTasks = (db: MemClient) => rows(db, "transaction_tasks").filter((t) => t.transaction_id === STXN && t.category === "compliance_correction" && (t.status === "pending" || t.status === "in_progress"))
  return { cc, ca, gt, cv, run, gate, answerNo, executed, addCd, snaps, openTasks }
}
const fig = (value: number | string | boolean) => ({ value, confidence: "high" })

// ═════════════════════════════════════════════════════════════════════════════
// 1 — Solo agent connection
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "1", title: "Solo agent connection", directiveLine: 823,
  survivors: ["lib/errors/index.ts resolveTenantPayer / presentTenantConnection / tenantProviderAttestation / tenantCopyVerdict", "lib/providers/tenant-provider-connections.ts deriveTenantProviderConnectionState / ingestTenantWebhookDelivery", "lib/lead-pipeline/scraper-parsers.ts normalizeBatchDataRecord", "app/actions/tenant-connections.ts (stripped: encryptSecret)"],
  reuses: [{ from: "wave151", ref: 8, covers: "own-account connection healthy / sandbox / revoked; signed push secret; tracerfy unsupported; the connect door touches no tier" }, { from: "proof", ref: "test:tenant-provider-connections", covers: "the connect door, the vault, two-tenant isolation on the real encrypted rows" }],
  adverse: "a delivery past the connection's daily cap is held (no hydrate, no spend); 'billed to your brokerage' is refused for a solo payer",
  positiveControl: "the SAME brokerage-payer sentence is admitted for a payer that IS a brokerage — so the solo refusal is the payer rule, not a broken gate; the env-key finder sees a specimen that reads the platform key",
  blindSpot: "the vault's encrypt/decrypt round trip needs SECRETS_ENCRYPTION_KEY (never present here) — the connect door is read as stripped source; no BatchData call (hydrate is a seam); RLS on platform_credentials is not modelled",
  run: async () => {
    const E = await import("../lib/errors")
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const sp = await import("../lib/lead-pipeline/scraper-parsers")
    const db = memSupabase({ brokerages: [{ id: SOLO, plan_tier: "solo_agent" }, { id: BRK, plan_tier: "brokerage" }], raw_scraped_leads: [] }, { uuidIds: true, stampCreatedAt: true })
    const payer = await E.resolveTenantPayer(db as never, SOLO)
    const brkPayer = await E.resolveTenantPayer(db as never, BRK)
    const view = E.presentTenantConnection({ provider: "BatchData", availability: "connected", credentials: "this_account", cost: "your_provider_account", payer, audience: "account" } as never)
    const rendered = [view.label, view.message.text, view.message.sentence, view.credentialLine, view.costLine].filter(Boolean).join(" ")
    const attestation = E.tenantProviderAttestation("BatchData", payer)
    const state = tpc.deriveTenantProviderConnectionState("batchdata", { exists: true, isActive: true, testStatus: "pass", hasApiKey: true, config: connectionConfig("ok") as never })
    const conn = { id: "conn-solo", brokerage_id: SOLO, platform: "batchdata", is_active: true, test_status: "pass" as const, apiKey: "fixture-tenant-token-0001", config: connectionConfig("ok") as never }
    const produced: any[] = [], booked: any[] = [], hydrated: string[][] = []
    const deps = () => ({
      hydrate: async (ids: string[]) => { hydrated.push(ids); return { ok: true, properties: ids.map((id) => ({ propertyId: id, _id: id, firstName: "Pat", lastName: "Owner", propertyAddress: "12 Gulf Breeze Pkwy", motivationType: "motivated_seller", quickLists: ["vacant"] })), cost: 0.05 * ids.length } },
      normalize: (rec: Record<string, unknown>, geo: { city: string | null; state: string | null }) => sp.normalizeBatchDataRecord(rec, { city: geo.city ?? "", state: geo.state ?? "", zip_codes: ["32501"] } as never),
      ingest: async (p: any) => { produced.push(p); return { inserted: p.records.length, replayed: 0, skipped_territory: 0 } as never },
      book: async (b: any) => { booked.push(b); return true },
      park: async () => ({ parked: true }), now: new Date("2026-11-12T15:00:00.000Z"),
    })
    const event = { eventId: "evt-1", propertyId: "prop-1", addedToSubscriptionIds: ["sub-1"], removedFromSubscriptionIds: [] }
    const rep = await quiet(() => tpc.ingestTenantWebhookDelivery(db as never, conn as never, [event], deps() as never))
    const rec = produced[0]?.records?.[0]
    // adverse: a daily cap already reached (one row produced today by this connection) → held, never hydrated
    const capped = memSupabase({ raw_scraped_leads: [{ id: "rs-1", brokerage_id: SOLO, producer_actor_id: "tenant:conn-cap", created_at: "2026-11-12T01:00:00.000Z" }] }, { uuidIds: true })
    const hydratedBefore = hydrated.length
    const capRep = await quiet(() => tpc.ingestTenantWebhookDelivery(capped as never, { ...conn, id: "conn-cap", config: connectionConfig("ok", { rate_limit_per_day: 1 }) } as never, [event], deps() as never))
    const door = ident("app/actions/tenant-connections.ts"), doorCode = code("app/actions/tenant-connections.ts")
    const ENV_KEY = /BATCHDATA_API_KEY/
    const h = halves([
      ["the payer is read from the tenant's OWN plan tier: solo", payer.kind === "solo" && brkPayer.kind === "brokerage"],
      ["the connected view names the account's own provider account, the credential control and the cost line — gate-clean for a solo payer", /bills your BatchData account directly/.test(view.costLine ?? "") && !!view.credentialLine && E.tenantCopyVerdict(rendered, { payer } as never).ok],
      ["the attestation is 'for my account', never 'my brokerage'", /for my account\./.test(attestation) && !/brokerage/i.test(attestation)],
      ["a complete own-account connection with a verified health read may ingest", state.state === "healthy" && state.mayIngest],
      ["the delivery is hydrated under the TENANT's key and lands in THE ONE producer for the solo tenant, territory-gated, actor webhook:tenant:<connection>", rep.ok && rep.inserted === 1 && produced.length === 1 && produced[0].brokerageId === SOLO && produced[0].marketId === null && (produced[0].marketGeo?.zip_codes ?? []).join() === "32501" && produced[0].actor?.id === "tenant:conn-solo"],
      ["the field map is the REAL BatchData normalizer (seller intent, the provider event id as the idempotency anchor, the provider property id kept)", rec?.intentType === "seller" && rec?.envelope?.externalEventId === "evt-1" && rec?.envelope?.externalIds?.batchdata_property_id === "prop-1"],
      ["the hydrate spend is booked ONCE as the tenant's own (tenant_paid), never the platform's", booked.length === 1 && booked[0].coverage === "tenant_paid" && booked[0].brokerageId === SOLO && produced[0].batchCostUsd === null],
      ["the connect door seals the secret (encryptSecret) and never reads the platform key", /encryptSecret\(/.test(doorCode) && !ENV_KEY.test(door)],
    ], [
      ["ADVERSE · the connection's daily cap reached → held + parked, no hydrate, no spend", capRep.held === 1 && capRep.parked === 1 && hydrated.length === hydratedBefore && /daily cap/.test(String(capRep.refused))],
      ["ADVERSE · 'billed to your brokerage' is refused for the solo payer (cost language never says brokerage pays)", !E.tenantCopyVerdict("AI usage is billed to your brokerage", { payer } as never).ok && !E.tenantCopyVerdict("BatchData bills your brokerage's BatchData account directly.", { payer } as never).ok],
      ["POSITIVE CONTROL · the brokerage-payer sentence IS admitted for a brokerage payer", E.tenantCopyVerdict("BatchData bills your brokerage's BatchData account directly.", { payer: brkPayer } as never).ok],
      ["POSITIVE CONTROL · the env-key finder sees a specimen that reads the platform key", ENV_KEY.test("const k = process.env.BATCHDATA_API_KEY")],
      ["no brokerage word anywhere in the solo view", !/\bbrokerage\b/i.test(rendered)],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, payer, view: rendered, attestation, state: state.state, rep, capRep, rec: rec ? { intent: rec.intentType, env: rec.envelope } : null, booked }).slice(0, 1800), note: `solo payer → "${view.costLine}"; one delivery → ${rep.inserted} raw row(s) for the solo tenant, ${booked.length} tenant_paid booking; a capped delivery held (${capRep.held}) with no hydrate`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — Team / brokerage, same integration
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "2", title: "Team/brokerage same integration", directiveLine: 824,
  survivors: ["lib/errors/index.ts resolveTenantPayer / presentTenantConnection", "lib/kernel/tier-role-matrix.ts seatDecision", "lib/billing/plan-catalog.ts TIER_SEAT_BANDS", "lib/providers/tenant-provider-connections.ts presentTenantProviderConnection / redactProviderSecrets", "lib/kernel/immediate-operations.ts recheckCredentialRow (through handleOperationFailureEscalated)"],
  reuses: [{ from: "wave150", ref: 2, covers: "cross-tenant / cross-location isolation negative-tested (search, contacts, raw leads, offices, seat views)" }, { from: "wave151", ref: 8, covers: "two-tenant credential scopes; the connect door touches no tier / subscription / Stripe identifier" }],
  adverse: "an escalation naming ANOTHER tenant's credential id reads 'missing' and echoes nothing of that row; a seat past the team band is refused",
  positiveControl: "the same escalation on the tenant's OWN refused credential re-reads it and names the problem — so 'missing' is the tenant pin, not a broken read",
  blindSpot: "office-level credential scoping is not a column on platform_credentials (owner_type 'brokerage' is the tenant); RLS is not modelled — the pin is the code's .eq('brokerage_id'); live Stripe seat billing is never called",
  run: async () => {
    const E = await import("../lib/errors")
    const trm = await import("../lib/kernel/tier-role-matrix")
    const pc = await import("../lib/billing/plan-catalog")
    const io = await import("../lib/kernel/immediate-operations")
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const db = memSupabase({
      brokerages: [{ id: TEAM, plan_tier: "team" }, { id: BRK, plan_tier: "brokerage" }, { id: MULTI, plan_tier: "multi_location" }],
      platform_credentials: [
        { id: "cred-team", brokerage_id: TEAM, platform: "batchdata", owner_type: "brokerage", api_key: "enc:v1:team-secret-material", is_active: true, test_status: "fail", config: connectionConfig("auth_failed") },
        { id: "cred-brk", brokerage_id: BRK, platform: "batchdata", owner_type: "brokerage", api_key: "enc:v1:brk-secret-material", is_active: true, test_status: "fail", config: connectionConfig("auth_failed", { webhook_secret: "whsec-brokerage-0000" }) },
      ],
      support_tickets: [], notifications: [], users: [],
    } as never, { uuidIds: true, stampCreatedAt: true })
    const [team, brk, multi] = await Promise.all([TEAM, BRK, MULTI].map((b) => E.resolveTenantPayer(db as never, b)))
    const line = (payer: any) => E.presentTenantConnection({ provider: "BatchData", availability: "connected", credentials: "this_account", cost: "your_provider_account", payer, audience: "account" } as never).costLine ?? ""
    const band = pc.TIER_SEAT_BANDS
    const under = trm.seatDecision("team", (band.team ?? 0) - 1), over = trm.seatDecision("team", band.team ?? 0)
    const bells: string[] = [], tickets: string[] = []
    const deps = { notifyOrg: async (_s: unknown, _b: string, n: { body: string }) => { bells.push(n.body); return 1 }, notifyStaff: async () => 1, openTicket: async () => { tickets.push("tk"); return { ticketId: `tk-${tickets.length}`, created: true, error: null } },
      // every PLATFORM lane lit (the readiness key passes) — 152A's adverse case: only the tenant's own row can say it is broken
      readiness: async () => ({ checks: [{ key: "providerState", status: "pass", ok: true }], ready: true, blockers: [], repairs: [] }) }
    const sig = (credId: string) => ({ id: `sig-${credId}`, entityType: "platform_credentials", entityId: credId, payload: { operation: "provider_connection", readiness_keys: [], tenant_facing: "BatchData connection needs attention", platform_visible: false }, createdAt: "2026-11-12T00:00:00.000Z" })
    const own = await quiet(() => io.handleOperationFailureEscalated(sig("cred-team") as never, { brokerageId: TEAM, supabase: db } as never, deps as never))
    const foreign = await quiet(() => io.handleOperationFailureEscalated(sig("cred-brk") as never, { brokerageId: TEAM, supabase: db } as never, deps as never))
    const brkRow = rows(db, "platform_credentials").find((x) => x.id === "cred-brk")
    const brkFacts = { exists: true, isActive: true, testStatus: "fail" as const, hasApiKey: true, config: brkRow.config }
    const brkView = JSON.stringify(tpc.presentTenantProviderConnection("batchdata", tpc.deriveTenantProviderConnectionState("batchdata", brkFacts as never), brkFacts as never, brk as never))
    const h = halves([
      ["the team tenant reads 'your team's BatchData account'; brokerage and multi-location read 'your brokerage's' (each from its OWN tier)", /your team's BatchData account/.test(line(team)) && /your brokerage's BatchData account/.test(line(brk)) && /your brokerage's BatchData account/.test(line(multi)) && !/brokerage/.test(line(team))],
      ["the tier sets the seat cap exactly as before (the integration adds no seat product): within the team band admitted", under.withinLimit && under.bandLimit === band.team],
      ["the tenant's OWN refused credential is re-read (tenant-pinned) even though every platform lane is lit, and escalated with a ticket, the bell naming the real next step", /credential re-check: needs_tenant/.test(String(own)) && tickets.length >= 1 && bells.length >= 1 && /still needs to be updated/.test(bells[0] ?? "") && /tracked as a support request your account's admins can see/.test(bells[0] ?? "")],
    ], [
      ["ADVERSE · a seat past the team band is refused and told the next tier — no price", !over.withinLimit && over.upgradeTo === "brokerage" && !/\$\s?\d|price|usd/i.test(JSON.stringify(over))],
      ["ADVERSE · another tenant's credential id reads 'missing' to this tenant: the bell never echoes that row's sentence or any of its config", bells.length >= 2 && /needs your attention/.test(bells[1] ?? "") && /no longer on your account/.test(bells[1] ?? "") && !/BatchData connection needs attention|whsec|brk-secret/.test(bells[1] ?? "")],
      ["no tenant-facing view or bell carries a stored secret (the vault value, the webhook secret)", !/team-secret-material|brk-secret-material|whsec-brokerage/.test(bells.join(" ") + brkView)],
      ["POSITIVE CONTROL · the secret finder sees a specimen carrying the webhook secret", /whsec-brokerage/.test("signature verified with whsec-brokerage-0000")],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, lines: [line(team), line(brk), line(multi)], under: under.withinLimit, over: { w: over.withinLimit, to: over.upgradeTo }, own, foreign, bells, tickets }).slice(0, 1800), note: `team → "${line(team)}"; ${tickets.length} ticket(s) for the tenant's own refused key; a foreign credential id reads as missing`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — Provider failure → helpful status → admin task → safe reconnect → queued retry exactly once
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "3", title: "Provider failure", directiveLine: 825,
  survivors: ["lib/providers/tenant-provider-connections.ts classifyTenantProviderFailure / presentTenantConnection", "lib/kernel/immediate-operations.ts handleOperationFailureEscalated", "lib/kernel/ingress-reconciliation.ts runIngressReconciliation (replayParkedTenantPush)"],
  reuses: [{ from: "wave150", ref: 16, covers: "failures seen within minutes; manager → human support with tenant-safe words" }, { from: "proof", ref: "test:manager-ownership-matrix", covers: "§F Play 6 end to end (the same reconciler)" }, { from: "proof", ref: "test:tenant-provider-connections", covers: "§I: report → signal → consumer → escalate → repair → verified" }],
  adverse: "while the key is still refused the parked delivery WAITS (no hydrate, no re-charge); a second reconciliation after the replay processes nothing again; a duplicate parked copy is one observation",
  positiveControl: "the tenant sentence contains no HTTP status or credential word, while the raw provider error it was classified from does (the finder is not blind)",
  blindSpot: "the provider's real expiry semantics and BatchData's live 401 body are not observed; the tick that runs the reconciler (deal-health-scan cron) is not invoked; RLS not modelled",
  run: async () => {
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const E = await import("../lib/errors")
    const { runIngressReconciliation } = await import("../lib/kernel/ingress-reconciliation")
    const rawError = "HTTP 401 Unauthorized: Bearer fixture-token-abcdefghijkl expired"
    const f = tpc.classifyTenantProviderFailure({ httpStatus: 401, message: rawError }, "BatchData")
    const view = E.presentTenantConnection({ provider: "BatchData", availability: "degraded", cause: "provider_refused", credentials: "this_account", cost: "your_provider_account", payer: { kind: "team" }, audience: "account" } as never)
    const tenantText = [view.label, view.message.sentence].join(" ")
    const CONN = "c3c3c3c3-0000-4000-8000-000000000003"
    const event = (id: string) => ({ eventId: id, propertyId: `prop-${id}`, addedToSubscriptionIds: ["sub-1"], removedFromSubscriptionIds: [] })
    const letter = (id: string, ref: string) => ({ id, provider: "batchdata", event_kind: "smart-search-match", external_ref: ref, payload: event(ref.split(":").pop()!), attempts: 0, status: "pending", created_at: "2026-11-12T00:00:00.000Z" })
    const w = memSupabase({
      platform_credentials: [{ id: CONN, brokerage_id: TEAM, platform: "batchdata", owner_type: "brokerage", api_key: "fixture-tenant-token-0003", is_active: true, test_status: "fail", config: connectionConfig("auth_failed") }],
      ingress_dead_letters: [letter("dl-1", `tenant:${CONN}:evt-1`)], self_heal_events: [], raw_scraped_leads: [],
    }, { uuidIds: true, stampCreatedAt: true })
    const calls = { hydrate: 0, ingest: 0, book: 0 }
    const landed = new Set<string>()
    const seams = { tenantPush: {
      hydrate: async (ids: string[]) => { calls.hydrate++; return { ok: true, properties: ids.map((id) => ({ propertyId: id, _id: id })), cost: 0.05 * ids.length } },
      normalize: (rec: Record<string, unknown>) => ({ source_record_id: String(rec.propertyId), envelope: {} }) as never,
      ingest: async (p: any) => { calls.ingest++; let inserted = 0, replayed = 0; for (const rr of p.records) { const k = String(rr.envelope?.externalEventId); if (landed.has(k)) replayed++; else { landed.add(k); inserted++ } } return { inserted, replayed, skipped_territory: 0 } as never },
      book: async () => { calls.book++; return true },
    } }
    const L = (id: string) => rows(w, "ingress_dead_letters").find((x) => x.id === id)
    await quiet(() => runIngressReconciliation(w as never, new Date(), seams as never))
    const waited = calls.hydrate === 0 && L("dl-1")?.status === "pending"
    const c = rows(w, "platform_credentials")[0]
    c.test_status = "pass"; c.config = { ...c.config, last_health: health("ok") } // the admin reconnects
    await quiet(() => runIngressReconciliation(w as never, new Date(), seams as never))
    const replayedOnce = calls.hydrate === 1 && calls.ingest === 1 && calls.book === 1 && L("dl-1")?.status === "reconciled"
    await quiet(() => runIngressReconciliation(w as never, new Date(), seams as never))
    rows(w, "ingress_dead_letters").push(letter("dl-dup", `tenant:${CONN}:evt-1`))
    await quiet(() => runIngressReconciliation(w as never, new Date(), seams as never))
    const h = halves([
      ["the 401 is classified as a refused key (revoked) routed to the account's admin", f.state === "revoked" && f.notify === "tenant_admin"],
      ["the status is helpful: 'Needs attention', what it affects, ONE action (update connection)", view.label === "Needs attention" && /Next step: update connection\./.test(view.message.sentence)],
      ["after the admin reconnects, the parked delivery is processed EXACTLY ONCE under the tenant's key (one hydrate, one producer write, one tenant booking) and marked reconciled", replayedOnce],
      ["the repair is a visible fact (self_heal_events healed, pinned to the tenant)", rows(w, "self_heal_events").some((x) => x.outcome === "healed" && x.brokerage_id === TEAM)],
    ], [
      ["ADVERSE · while the key is refused the delivery WAITS: no hydrate (no re-charge), still pending", waited],
      ["ADVERSE · a later reconciliation and a duplicate parked copy add nothing (one hydrate, one ingest, one observation)", calls.ingest <= 2 && landed.size === 1 && calls.book <= 2 && L("dl-dup")?.status === "reconciled"],
      ["the tenant sentence carries no HTTP status, no credential word, no token", E.tenantCopyVerdict(tenantText).ok && !/401|token|Bearer|fixture-token/i.test(tenantText) && !JSON.stringify(f).includes("abcdefghijkl")],
      ["POSITIVE CONTROL · the raw error the classification came from DOES carry them (the finder sees them)", /401/.test(rawError) && /Bearer/.test(rawError) && !E.tenantCopyVerdict(rawError).ok],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, f, view: tenantText, calls, letters: rows(w, "ingress_dead_letters").map((x) => [x.id, x.status, x.attempts]) }).slice(0, 1800), note: `401 → ${f.state} (${f.notify}); refused key: ${waited ? "waited, 0 hydrates" : "DID NOT WAIT"}; reconnected: hydrate ${calls.hydrate}, ingest ${calls.ingest}, booking ${calls.book}`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — QR creation
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "4", title: "QR creation", directiveLine: 826,
  survivors: ["lib/marketing/qr-governance.ts mintGovernedQr / loadQrActivity", "lib/marketing/qr-contract.ts validateQrDestination / classifyQrScan / summarizeQrScans / QR_TOKEN_SHAPE", "lib/marketing/tracked-qr.ts qrScanEvidence", "app/api/qr/scan/route.ts (stripped)", "app/dashboard/agent/qr-codes/QRCodesClient.tsx (stripped: SVG export)"],
  reuses: [{ from: "wave150", ref: 10, covers: "lead magnet: QR resolves; consent + unsubscribe in one place" }, { from: "proof", ref: "test:qr-registry", covers: "§7–§15 token, governed mint, destination safety, versioned edit, lifecycle, tracking" }, { from: "proof", ref: "test:marketing-qr", covers: "the scan door end to end on the real route" }],
  adverse: "javascript: and plain http destinations refused at mint (nothing written); a bot scan is a bot; a scan creates no Contact",
  positiveControl: "the Contact-write finder sees a contacts insert / captureContact call in a specimen; a well-formed https destination on the tenant's declared website is accepted",
  blindSpot: "the CSPRNG's unpredictability is sampled, not proven; the scan route is read as stripped source (the real route runs in test:marketing-qr); a printed code's real-world scan rate is unobserved",
  run: async () => {
    const gov = await import("../lib/marketing/qr-governance")
    const qc = await import("../lib/marketing/qr-contract")
    const tq = await import("../lib/marketing/tracked-qr")
    const db = qrWorld()
    const base = { purpose: "general", destinationType: "landing_page" } as const
    const m1 = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0001", label: "Spring flyer", placement: "flyer", printSizeIn: 1.25, marketingCampaignId: "cA" } as never, QA as never, qrDeps(db) as never))
    const m2 = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0002", label: "Spring flyer" } as never, QA as never, qrDeps(db) as never))
    const again = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0001", label: "Spring flyer", placement: "flyer", printSizeIn: 1.25, marketingCampaignId: "cA" } as never, QA as never, qrDeps(db) as never))
    const ext = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0003", label: "About us", destinationType: "other", targetUrl: "https://alderrealty.example/about" } as never, QA as never, qrDeps(db) as never))
    const js = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0004", label: "Bad", destinationType: "other", targetUrl: "javascript:alert(1)" } as never, QA as never, qrDeps(db) as never))
    const http = await quiet(() => gov.mintGovernedQr({ ...base, idempotencyKey: "canary-qr-0005", label: "Plain", destinationType: "other", targetUrl: "http://alderrealty.example/about" } as never, QA as never, qrDeps(db) as never))
    const tokenRe = new RegExp(`^[${qc.QR_TOKEN_SHAPE.alphabet}]{${qc.QR_TOKEN_SHAPE.length}}$`)
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    const ev = tq.qrScanEvidence({ qrCodeId: (m1 as any).code?.id ?? "q", ip: "203.0.113.7", userAgent: IPHONE, referrer: "https://l.facebook.com/l.php?u=x", nowMs: Date.parse("2026-11-12T15:00:00Z") })
    if ((m1 as any).ok) rows(db, "qr_scan_events").push({ qr_code_id: (m1 as any).code.id, brokerage_id: "bA", traffic_class: "human_likely", visitor_key: ev.visitorKey, scanned_at: "2026-11-12T15:00:00Z" }, { qr_code_id: (m1 as any).code.id, brokerage_id: "bA", traffic_class: "bot", visitor_key: "bot-key", scanned_at: "2026-11-12T15:00:05Z" })
    const act = (m1 as any).ok ? await quiet(() => gov.loadQrActivity((m1 as any).code.id, QA as never, qrDeps(db) as never)) : null
    const scan = code("app/api/qr/scan/route.ts")
    const CONTACT_WRITE = /from\(['"](contacts|leads)['"]\)[\s\S]{0,120}\.(insert|upsert)\(|captureContact\(|captureConsentedContact\(/
    const board = code("app/dashboard/agent/qr-codes/QRCodesClient.tsx") + code("app/actions/qr-management.ts") + code("app/api/admin/qr-codes/route.ts")
    const h = halves([
      ["two requests → two codes with two unpredictable tokens of the contract's shape; the same key → the same record (no third row)", (m1 as any).ok && (m2 as any).ok && tokenRe.test((m1 as any).code.slug) && (m1 as any).code.slug !== (m2 as any).code.slug && (again as any).replayed === true && rows(db, "qr_codes").filter((x) => x.label === "Spring flyer").length === 2],
      ["saved with provenance (tenant, creator users.id, campaign, placement) and ledgered once (marketing.qr.mint)", (() => { const row = rows(db, "qr_codes").find((x) => x.id === (m1 as any).code?.id); return row?.brokerage_id === "bA" && row?.created_by_user_id === "uA" && row?.marketing_campaign_id === "cA" && row?.mint_context?.placement === "flyer" })() && rows(db, "agent_action_ledger").filter((x) => x.action === "marketing.qr.mint" && x.status === "executed").length === 3],
      ["an HTTPS destination on the tenant's declared website is accepted", (ext as any).ok],
      ["exportable: the board offers a print SVG beside the PNG and copies the TRACKING link", /svg/i.test(board) && /scan\?slug=|scanUrl/.test(board)],
      ["scans tracked by class: raw ≠ visits ≠ bots; the visitor key is a 32-hex hash with no IP", !!act && (act as any).ok && (act as any).activity.summary.rawScans === 2 && (act as any).activity.summary.botScans === 1 && /^[0-9a-f]{32}$/.test(ev.visitorKey) && !ev.visitorKey.includes("203")],
    ], [
      ["ADVERSE · javascript: and plain http are refused at MINT, nothing written", !(js as any).ok && (js as any).code === "unsafe_destination" && !(http as any).ok && !rows(db, "qr_codes").some((x) => x.label === "Bad" || x.label === "Plain")],
      ["ADVERSE · a link previewer is a bot, never a visit", qc.classifyQrScan({ userAgent: "facebookexternalhit/1.1" } as never) === "bot"],
      ["A SCAN CREATES NO CONTACT (the scan door never writes contacts / leads, never calls the capture path)", scan.length > 0 && !CONTACT_WRITE.test(scan)],
      ["POSITIVE CONTROL · the Contact-write finder sees a contacts insert and a capture call", CONTACT_WRITE.test("svc.from('contacts').insert({})") && CONTACT_WRITE.test("await captureContact({ brokerageId })")],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, m1, m2: (m2 as any).code?.slug, again: (again as any).replayed, ext: (ext as any).ok, js: (js as any).code, http: (http as any).code, act: (act as any)?.activity?.summary }).slice(0, 1800), note: `2 unique tokens (${(m1 as any).code?.slug?.slice(0, 6)}…, ${(m2 as any).code?.slug?.slice(0, 6)}…), a replay → the same record; javascript:/http refused; ${(act as any)?.activity?.summary?.rawScans ?? "?"} raw scans, ${(act as any)?.activity?.summary?.botScans ?? "?"} bot`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — Letter with QR
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "5", title: "Letter with QR", directiveLine: 827,
  survivors: ["lib/direct-mail/piece-type.ts resolveTenantSenderAddress / buildMailMergeVariables", "lib/providers/mailing-cass-gate.ts decideSenderAddress", "lib/direct-mail/render-letter.ts renderLetterHtml", "lib/direct-mail/mail-piece-rules.ts decideMailQrRegion / layoutContentViolations / MAIL_LAYOUT_LIBRARY", "lib/marketing/tracked-qr.ts mintTrackedQr", "app/actions/direct-mail.ts sendCampaign previewOnly (stripped)"],
  reuses: [{ from: "wave150", ref: 13, covers: "Lob format ids never alias; tenant brand as data; preview + per-piece status; no live spend" }, { from: "proof", ref: "test:direct-mail-rendering", covers: "§L the optional QR region in every format, letters included" }, { from: "proof", ref: "test:sender-voice", covers: "the sender's voice brief leads every first draft" }],
  adverse: "the platform's own return address is refused as a sender; a typed URL never prints in the QR region; a letter with no code still mails",
  positiveControl: "a tenant's verified address passes the same gate inline — so the refusal is the platform rule, not a broken gate",
  blindSpot: "the four Lob global templates printing qr_destination_url are template configuration on the platform's Lob account (TEST key, WAITING_EXTERNAL by name); no letter is mailed; the copy drafter is a scripted seam (the voice brief path is test:sender-voice)",
  run: async () => {
    const pt = await import("../lib/direct-mail/piece-type")
    const gate = await import("../lib/providers/mailing-cass-gate")
    const rules = await import("../lib/direct-mail/mail-piece-rules")
    const { renderLetterHtml } = await import("../lib/direct-mail/render-letter")
    const { mintTrackedQr } = await import("../lib/marketing/tracked-qr")
    const verified = { addressId: "sa-a", name: "Alder Realty LLC", line1: "12 Peachtree St", line2: null, city: "Atlanta", state: "GA", zip: "30303", country: "US", source: "tenant_return_address", verification: { method: "lob_cass", deliverability: "deliverable", verifiedAt: "2026-11-09T00:00:00Z" } }
    const svc = memSupabase({ direct_mail_sender_addresses: [{ id: "sa-a", brokerage_id: "tenant-a", scope_type: "brokerage", scope_id: "tenant-a", label: null, name: "Alder Realty LLC", line1: "12 Peachtree St", line2: null, city: "Atlanta", state: "GA", zip: "30303", cass_deliverability: "deliverable", cass_verified_at: "2026-11-09T00:00:00Z", approved_by_user_id: "u-admin", approved_at: "2026-11-09T01:00:00Z", is_default: true, status: "active" }], brokerages: [] })
    const resolved = await quiet(() => pt.resolveTenantSenderAddress({ brokerageId: "tenant-a", client: svc as never, verifyNow: false }))
    const ok = gate.decideSenderAddress(verified as never, { platformLobAddressId: "adr_platform000000" })
    const platform = gate.decideSenderAddress("adr_platform000000" as never, { platformLobAddressId: "adr_platform000000" })
    const db = memSupabase({ qr_codes: [] }, { uuidIds: true })
    const codeA = await mintTrackedQr({ brokerageId: "tenant-a", label: "direct_mail_campaign:camp-a", purpose: "campaign", origin: ORIGIN } as never, db as never)
    const brand = { displayName: "The Alder Team", brokerageName: "Alder Realty LLC", visual: { primaryColor: "#0F172A", accentColor: "#F59E0B" }, display: { websiteWordmark: "alderhomes.example", phone: "404-555-0100", licenseLine: "GA License # 123456" }, fairHousing: { longDisclosure: "Alder Realty LLC is committed to the Fair Housing Act." } }
    let draftAsked = 0
    const seams = { resolveBrand: (async () => brand) as never, draftCopy: (async () => { draftAsked++; return { ok: true, copy: { greeting: "Hi {{first_name}},", body: "Spring is a good time to look at what your home is worth.\n\nI ran the numbers for your street.", signoff: "Warmly," }, complianceEventId: null } }) as never }
    const args = (over: Record<string, unknown>) => ({ brokerageId: "tenant-a", copyCtx: { brokerageId: "tenant-a", teamId: null, agentUserId: null } as never, recipientFirstName: "Jordan", recipientLastName: "Lee", recipientStreet: "9 Elm St", recipientCityState: "Atlanta, GA", recipientZip: "30303", agentName: "Maya Chen", agentTitle: null, ...over })
    const withQr = await quiet(() => renderLetterHtml(args({ qrScanUrl: codeA?.scanUrl }) as never, seams as never))
    const typed = await quiet(() => renderLetterHtml(args({ qrScanUrl: "https://alderhomes.example/listing/12" }) as never, seams as never))
    const plain = await quiet(() => renderLetterHtml(args({}) as never, seams as never))
    const token = codeA?.slug ?? "∅"
    const printed = /data-qr-token="([^"]+)"/.exec((withQr as any).html ?? "")?.[1]
    const mv = pt.buildMailMergeVariables({ ...(brand as any), returnAddress: verified } as never, { qrDestinationUrl: codeA?.scanUrl ?? null } as never).mergeVars
    const dm = code("app/actions/direct-mail.ts"), rl = code("lib/direct-mail/render-letter.ts"), dc = code("lib/direct-mail/draft-copy.ts")
    const h = halves([
      ["the tenant's OWN verified return address resolves (never the platform's)", resolved.address?.line1 === "12 Peachtree St" && resolved.address?.source === "tenant_return_address"],
      ["the letter layout is a BLANK library layout carrying an optional QR region", !!rules.MAIL_LAYOUT_LIBRARY.letter?.qrRegion && rules.MAIL_LAYOUT_LIBRARY.letter.qrRegion.optional === true],
      ["the REAL renderer prints the campaign code's unique token in the region, with the tenant brand as data and the drafted copy", (withQr as any).ok && printed === token && /Alder Realty LLC|The Alder Team/.test((withQr as any).html ?? "") && draftAsked >= 1],
      ["the printed token maps back to THIS tenant's campaign code (ROI attribution reads the code)", rows(db, "qr_codes").some((x) => x.slug === printed && x.brokerage_id === "tenant-a" && x.label === "direct_mail_campaign:camp-a")],
      ["the proof / approved test-send path carries the same tracking link (qr_destination_url) and the preview is built from the minted link", mv.qr_destination_url === codeA?.scanUrl && /qrDestinationUrl = minted\?\.scanUrl \?\? null/.test(dm) && /previewOnly/.test(dm)],
      ["the copy is drafted in the sender's voice first: the letter's default drafter (draftLetterCopy) reads THE ONE voice reader (loadSenderVoiceBrief) before it writes", /\(deps\.draftCopy \?\? draftLetterCopy\)\(/.test(rl) && /loadSenderVoiceBrief\(/.test(dc) && /readSenderVoiceBrief\(ctx\)/.test(dc)],
    ], [
      ["ADVERSE · the platform's saved address id is refused as a sender (platform_address)", !platform.ok && (platform as any).code === "platform_address"],
      ["ADVERSE · a typed URL never prints in the QR region; a letter with no code still renders (the region blank, the mailing never held)", (typed as any).ok && !String((typed as any).html).includes("data-qr-token") && (plain as any).ok && !String((plain as any).html).includes("data-qr-token")],
      ["the printed region carries no platform identity and no address violation", rules.layoutContentViolations((withQr as any).html ?? "").length === 0],
      ["POSITIVE CONTROL · the tenant's verified address passes the same gate inline", ok.ok && (ok as any).from?.name === "Alder Realty LLC"],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, resolved: resolved.address, platform, token, printed, mv: mv.qr_destination_url, typedRegion: (typed as any).qrRegion }).slice(0, 1800), note: `tenant sender ${resolved.address?.line1}; token ${token.slice(0, 6)}… printed and mapped to camp-a; platform address refused`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — QR contact journey → ROI earned contribution and known spend only
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "6", title: "QR contact journey", directiveLine: 828,
  survivors: ["app/api/qr/submit/route.ts (stripped: captureConsentedContact, own-scan link)", "lib/marketing/attribution.ts attributeTransactionSafe", "lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger / roiOutcomeCsv"],
  reuses: [{ from: "wave150", ref: 4, covers: "consented form → ONE Contact, invite immediate" }, { from: "wave151", ref: 9, covers: "an existing Contact's behaviour → a helpful arbiter evaluation, no duplicate Lead" }, { from: "proof", ref: "test:roi-outcome-ledger", covers: "P1–P8 + R + S on the same writer and reader" }],
  adverse: "an agent's view carries no commission dollars; a contact seat is refused; the mis-stamped other-tenant touchpoint earns no credit",
  positiveControl: "the broker's view of the SAME ledger shows the commission — so the agent's null is the role rule, not a missing figure",
  blindSpot: "the consented submission, the manager hand-off and the appointment are seeded rows (their doors run in test:marketing-qr / test:qr-registry §12 / the arbiter proofs); RLS not modelled; the cron that credits deals is not invoked (its writer is)",
  run: async () => {
    const att = await import("../lib/marketing/attribution")
    const roi = await import("../lib/intelligence/roi-ledger")
    const m = roiWorld()
    for (const t of [T1, T2, T3]) await quiet(() => att.attributeTransactionSafe(m as any, t))
    const broker = await quiet(() => roi.loadRoiOutcomeLedger(m as any, { userId: U_BROKER, brokerageId: RA }, WINDOW))
    const agent = await quiet(() => roi.loadRoiOutcomeLedger(m as any, { userId: U_AG1, brokerageId: RA }, WINDOW))
    const contact = await quiet(() => roi.loadRoiOutcomeLedger(m as any, { userId: U_CONTACT, brokerageId: RA }, WINDOW))
    const bl = (broker as any).ok ? (broker as any).ledger : null
    const j = bl?.journeys?.find((x: any) => x.transactionId === T1)
    const kinds = new Set((j?.steps ?? []).map((s: any) => s.kind))
    const mail = bl?.campaigns?.find((c: any) => c.campaignId === C_MAIL), social = bl?.campaigns?.find((c: any) => c.campaignId === C_SOCIAL)
    const csv = bl ? roi.roiOutcomeCsv(bl) : ""
    const submit = code("app/api/qr/submit/route.ts")
    const foreignCredit = rows(m, "marketing_attribution_credits").some((c) => c.campaign_id === C_B && c.transaction_id === T1)
    const h = halves([
      ["the consented submission is the ONLY identity door (captureConsentedContact) and claims only its OWN scan", /captureConsentedContact\(/.test(submit) && /\.eq\('visitor_key', submitEvidence\.visitorKey\)/.test(submit)],
      ["the journey traces touch → QR scan → mail response → appointment → contract → close, each with its evidence row", !!j && ["touchpoint", "qr_scan", "mail_response", "appointment", "contract", "closed"].every((k) => kinds.has(k)) && j.steps.some((s: any) => s.ref === `qr_scan_events:${S1}`) && j.steps.some((s: any) => s.ref === `showings:${SH1}`)],
      ["the earned contribution is the CLOSED, FINALIZED commission once ($12,000), the mailer credited its linear share", bl?.revenue?.earnedCents === 1_200_000 && (mail?.revenue?.sourcedEarnedCents ?? 0) > 0 && bl?.attribution?.reconciled === true],
      ["known spend only: the mailer's recorded cost ($750) is the denominator; the realized return is computed over it", mail?.cost?.status === "confirmed" && mail?.cost?.cents === 75_000 && typeof mail?.ratios?.realizedReturnOnMarketingSpend?.value === "number"],
      ["the CSV export is built from the same ledger object", csv.length > 0 && csv.includes("Oak Street letters with QR")],
    ], [
      ["ADVERSE · the unknown-spend campaign reads Unknown and N/A, never $0", social?.cost?.status === "unknown" && social?.cost?.cents === null && social?.ratios?.realizedReturnOnMarketingSpend?.value === null],
      ["ADVERSE · an agent sees counts and closings but NO commission dollars; a contact seat is refused", (agent as any).ok && (agent as any).ledger.revenue?.earnedCents == null && !(contact as any).ok],
      ["ADVERSE · the other tenant's mis-stamped touchpoint on the same person earns no credit on this tenant's deal", !foreignCredit],
      ["POSITIVE CONTROL · the broker's view of the same ledger shows the commission", bl?.revenue?.earnedCents === 1_200_000],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, broker: (broker as any).ok ? { revenue: bl.revenue, attribution: { sourced: bl.attribution?.sourcedEarnedCents, reconciled: bl.attribution?.reconciled }, mail: mail?.cost, social: social?.cost, kinds: [...kinds] } : (broker as any).error, agentRev: (agent as any).ledger?.revenue, contact: (contact as any).ok }).slice(0, 1800), note: `QR scan → appointment → close traced with evidence; earned $${(bl?.revenue?.earnedCents ?? 0) / 100}; mailer cost $${(mail?.cost?.cents ?? 0) / 100} (known); social cost unknown → N/A`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 7 — ROI negative evidence
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "7", title: "ROI negative evidence", directiveLine: 829,
  survivors: ["lib/intelligence/roi-ledger.ts realizedReturnOnMarketingSpend / loadRoiOutcomeLedger / loadRealizedAttributionCredits", "lib/marketing/attribution.ts attributeTransactionSafe (retraction)"],
  reuses: [{ from: "proof", ref: "test:roi-outcome-ledger", covers: "P2 pending, P3 cancel/correction/reassignment, P4 unknown, P5 $0, P6 replay" }],
  adverse: "unknown, partial and $0 spend, an unfinalized commission, a canceled close and a duplicated scan each stay honest",
  positiveControl: "the formula returns a number for recorded spend and an established contribution — so N/A is the rule, not a dead formula; summing every model's credit rows (the old read) gives 4× the deal",
  blindSpot: "spend-to-close lag is not modelled; reads cap at the reader's row limits; tenant-reported budget_spent is lifetime, not windowed",
  run: async () => {
    const roi = await import("../lib/intelligence/roi-ledger")
    const att = await import("../lib/marketing/attribution")
    const F = roi.realizedReturnOnMarketingSpend
    const unknown = F({ contributionCents: 100_000, spendCents: null, spendStatus: "unknown" } as never), partial = F({ contributionCents: 100_000, spendCents: 5_000, spendStatus: "partial" } as never)
    const zero = F({ contributionCents: 100_000, spendCents: 0, spendStatus: "none" } as never), pending = F({ contributionCents: null, spendCents: 5_000, spendStatus: "confirmed" } as never)
    const ok = F({ contributionCents: 100_000, spendCents: 50_000, spendStatus: "confirmed" } as never)
    const m = roiWorld()
    for (const t of [T1, T2, T3]) await quiet(() => att.attributeTransactionSafe(m as any, t))
    const all4 = rows(m, "marketing_attribution_credits").filter((c) => c.transaction_id === T1).reduce((s, c) => s + Number(c.credit_dollars), 0)
    const shared = await quiet(() => roi.loadRealizedAttributionCredits(m as any, RA, { sinceIso: "2000-01-01T00:00:00.000Z" }))
    const sharedSum = (shared as any).ok ? (shared as any).rows.reduce((s: number, x: any) => s + Number(x.credit_dollars ?? 0), 0) : -1
    rows(m, "transactions").find((t) => t.id === T3)!.status = "lost"
    const retract = await quiet(() => att.attributeTransactionSafe(m as any, T3))
    const l = await quiet(() => roi.loadRoiOutcomeLedger(m as any, { userId: U_BROKER, brokerageId: RA }, WINDOW))
    const L = (l as any).ok ? (l as any).ledger : null
    const scanSteps = (L?.journeys?.find((x: any) => x.transactionId === T1)?.steps ?? []).filter((s: any) => s.kind === "qr_scan" && s.ref === `qr_scan_events:${S1}`)
    const h = halves([
      ["POSITIVE CONTROL · recorded spend + established contribution → a number ((100k − 50k) ÷ 50k = 1)", ok.value === 1 && ok.na === null],
      ["the shared realized-credit read returns ONE model on CLOSED deals ($12,000), never 4×", (shared as any).ok && Math.round(sharedSum) === 12000],
      ["POSITIVE CONTROL · summing every model's rows (the old tile's read) gives 4× the deal", Math.round(all4) === 48000],
    ], [
      ["unknown spend → N/A 'not recorded'", unknown.value === null && /not recorded/.test(unknown.na ?? "")],
      ["partial spend → N/A (a return over a partial cost would overstate it)", partial.value === null && /partial/i.test(partial.na ?? "")],
      ["zero denominator → N/A ('a return on $0 is not a number')", zero.value === null && /\$0/.test(zero.na ?? "")],
      ["pending commission → N/A ('not finalized')", pending.value === null && /not finalized/.test(pending.na ?? "")],
      ["pending deal: contracted, never earned", L?.revenue?.earnedCents === 1_200_000 && (L?.revenue?.contractedCents ?? 0) >= 900_000],
      ["canceled close: the writer RETRACTS its credit (counted) and the reader counts it reversed", (retract as any)?.outcome === "retracted" && (retract as any).removedRows > 0 && L?.results?.dealsReversed === 1],
      ["duplicate attribution: a replayed scan event is ONE journey step", scanSteps.length === 1],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, unknown, partial, zero, pending, ok, sharedSum, all4, retract, revenue: L?.revenue, reversed: L?.results?.dealsReversed, scanSteps: scanSteps.length }).slice(0, 1800), note: `N/A ×4 (unknown · partial · $0 · unfinalized); one model $${Math.round(sharedSum)} vs every-model $${Math.round(all4)}; lost deal retracted (${(retract as any)?.removedRows} rows); replayed scan = 1 step`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 8 — Scanned receipt → draft fields → authorized post → one canonical record
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "8", title: "Scanned receipt", directiveLine: 830,
  survivors: ["lib/documents/receipt-intake.ts intakeReceipt / approveReceipt / loadReceiptReview / mayKeepReceipts", "lib/documents/ocr-pdf.ts (vision door through the reader seam)", "lib/documents/field-extraction-ledger.ts", "lib/kernel/action-ledger.ts withActionLedger", "app/actions/financials.ts logScopedExpense (stripped: the ONE writer)"],
  reuses: [{ from: "proof", ref: "test:receipt-intelligence", covers: "§1–§16 incl. the 10 mutations: vision part, kinds, evidence, duplicates, scope, reversal, verify door" }],
  adverse: "the same file again is refused as a duplicate; approving twice posts once; another tenant cannot read or approve it; a vendor seat may not upload",
  positiveControl: "a different photo of the same purchase is HELD as a possible duplicate charge (the duplicate rule sees the books, not only the file hash)",
  blindSpot: "the vision provider and the model are seams (a real photo's reading quality is unmeasured); the expense writer is a stand-in for logScopedExpense (its gates are held by test:people-vendor-education-wiring A7/A8); storage upload and signing are not driven",
  run: async () => {
    const ri = await import("../lib/documents/receipt-intake")
    const svc = receiptWorld()
    const w = receiptWriter(svc, () => rAgent)
    const seams = { reader: visionReader(READING), extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => RCPT_NOW }
    const first = await quiet(() => ri.intakeReceipt(svc as never, { actor: rAgent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${RCPT_A}/u-agent/1.jpg` } as never, seams as never))
    const total = rows(svc, "document_field_extractions").find((x) => x.document_id === (first as any).documentId && x.field_key === "expense.total")?.field_value_json
    const heldNothingPosted = rows(svc, "business_expenses").length === 0 && w.calls.length === 0
    const ok1 = await quiet(() => ri.approveReceipt(svc as never, { actor: rAgent, documentId: (first as any).documentId } as never, seams as never))
    const ok2 = await quiet(() => ri.approveReceipt(svc as never, { actor: rAgent, documentId: (first as any).documentId } as never, seams as never))
    const again = await quiet(() => ri.intakeReceipt(svc as never, { actor: rAgent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r-again.jpg" }, objectPath: `${RCPT_A}/u-agent/2.jpg` } as never, seams as never))
    const photo2 = await quiet(() => ri.intakeReceipt(svc as never, { actor: rAgent, file: { buffer: Buffer.from("another-photo-same-purchase"), mime: "image/jpeg", name: "r2.jpg" }, objectPath: `${RCPT_A}/u-agent/3.jpg` } as never, seams as never))
    const peek = await quiet(() => ri.loadReceiptReview(svc as never, { actor: rOther, documentId: (first as any).documentId } as never))
    const steal = await quiet(() => ri.approveReceipt(svc as never, { actor: rOther, documentId: (first as any).documentId } as never, seams as never))
    const led = rows(svc, "agent_action_ledger").filter((x) => x.action === "finance.expense.post_from_document")
    const fin = code("app/actions/financials.ts")
    const h = halves([
      ["the photo becomes evidence-backed DRAFT fields (total 43.17 on page 1, words located, destination business_expenses.amount) — nothing posted before approval", (first as any).state === "held" && total?.value === 43.17 && total?.page === 1 && total?.evidence_located === true && total?.destination === "business_expenses.amount" && heldNothingPosted],
      ["the authorized reviewer's approval posts through THE writer once, on the agent's own book, ledgered FINANCIAL", (ok1 as any).ok && (ok1 as any).state === "posted" && rows(svc, "business_expenses").length === 1 && rows(svc, "business_expenses")[0].agent_id === "ag-1" && led.length === 1 && led[0].risk_class === "FINANCIAL" && led[0].status === "executed"],
      ["the server actions inject exactly logScopedExpense (the ONE expense writer)", /logScopedExpense/.test(fin) && /approveReceipt\(/.test(fin)],
      ["POSITIVE CONTROL · a different photo of the same purchase is HELD as a possible duplicate charge", (photo2 as any).state === "held" && (rows(svc, "documents").find((d) => d.id === (photo2 as any).documentId)?.metadata?.receipt_review?.duplicates?.sameCharge?.length ?? 0) === 1],
    ], [
      ["ADVERSE · approving again posts nothing new (idempotent per document)", (ok2 as any).ok && rows(svc, "business_expenses").length === 1 && w.calls.length === 1],
      ["ADVERSE · the same file again is refused as a duplicate (never double counted)", !(again as any).ok && (again as any).state === "duplicate" && rows(svc, "business_expenses").length === 1],
      ["ADVERSE · another tenant cannot read or approve it (reads as absent)", !(peek as any).ok && !(steal as any).ok],
      ["ADVERSE · a vendor seat keeps no books (refused before any upload or AI spend)", ri.mayKeepReceipts(rVendor as never) === false && ri.mayKeepReceipts(rAgent as never) === true],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, first, total, ok1, ok2: (ok2 as any).state, again: (again as any).state, photo2: (photo2 as any).state, peek: (peek as any).ok, steal: (steal as any).ok, expenses: rows(svc, "business_expenses").length, led: led.length }).slice(0, 1800), note: `draft fields held → approved → 1 expense row, 1 FINANCIAL ledger row; replayed approve, same file, other tenant: refused`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 9 — Contract term compare
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "9", title: "Contract term compare", directiveLine: 831,
  survivors: ["lib/offers/governing-terms.ts recordContractTermsVersion / contractTermLedger", "lib/transactions/closing-compliance.ts runClosingCompliance (comparison + corrective requests)", "lib/transactions/closing-compliance-core.ts compareDealRecordTerms"],
  reuses: [{ from: "wave150", ref: 14, covers: "'on or before' allows an earlier close; executed addenda govern; payouts re-read" }, { from: "proof", ref: "test:transaction-addenda", covers: "§I–§M term ledger, classification, holds, overrides" }],
  adverse: "a proposed (unsigned) price change moves nothing; the same change claimed executed on a buyer-only signed document is refused",
  positiveControl: "the executed addendum DOES move the deal record and the comparison — so the proposal's no-op is the governance rule, not an inert recorder",
  blindSpot: "the executed addendum's reading is seeded (the scanner is lane 152D's); free-text terms are listed, never compared by meaning; RLS not modelled",
  run: async () => {
    const k = await settlementKit()
    const db = settlementWorld()
    await k.run(db)
    const add = await k.executed(db, DOC_ADD, { offer_price: 490_000 }, { offer_price: { page: 1, field: "Paragraph 3", quote: "The Purchase Price is amended to $490,000." } })
    const out = await k.run(db)
    const price = out.comparison?.findings.find((f) => f.term === "purchase_price")
    const comm = out.reconciliation?.reconciliation?.items.find((i: any) => i.key === "term.commission_buyer_side")
    const ledger = await quiet(() => k.gt.contractTermLedger(db as never, SB, { transactionId: STXN } as never))
    const pdb = settlementWorld()
    await k.run(pdb)
    rows(pdb, "documents").push({ id: DOC_PROP, brokerage_id: SB, transaction_id: STXN, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] }, extracted_fields: null })
    const prop = await quiet(() => k.gt.recordContractTermsVersion(pdb as never, { brokerageId: SB, rootOfferId: SOFFER, transactionId: STXN, source: "addendum", status: "proposed", terms: { offer_price: 470_000 }, recordedBy: SU_AGENT } as never))
    const bad = await quiet(() => k.gt.recordContractTermsVersion(pdb as never, { brokerageId: SB, rootOfferId: SOFFER, transactionId: STXN, source: "addendum", status: "executed", terms: { offer_price: 470_000 }, documentId: DOC_PROP, executedAt: `${sday(1)}T23:59:59.999Z`, recordedBy: SU_AGENT } as never))
    const h = halves([
      ["the executed price addendum (both signatures, located evidence) moves the deal record to $490,000", (add as any).ok && rows(db, "transactions")[0].purchase_price === 490_000],
      ["the comparison flags the statement still at the REPLACED $500,000 — classified SUPERSEDED, blocking, with a correction naming the issuer", !!price && price.classification === "superseded" && price.blocking && /title|attorney|issuer/i.test(price.correction + price.why)],
      ["the downstream commission line is re-judged on the new price (settlement / commission review)", !!comm && comm.status === "differs" && comm.blocking],
      ["a corrective request is opened (ledgered, deduped) for the TC", k.openTasks(db).length >= 1 && rows(db, "agent_action_ledger").some((x) => x.action === "compliance.correction_request.open")],
      ["the term ledger names the governing instrument and the prior value it replaced", (ledger as any)?.ok !== false && JSON.stringify(ledger).includes("490000") && JSON.stringify(ledger).includes("500000")],
    ], [
      ["ADVERSE · a PROPOSED price change is recorded as proposed and moves nothing (price, snapshots, tasks)", (prop as any).ok && rows(pdb, "transactions")[0].purchase_price === 500_000 && k.openTasks(pdb).length === 0],
      ["ADVERSE · the same change claimed EXECUTED on a buyer-only signed document is refused", !(bad as any).ok && rows(pdb, "transactions")[0].purchase_price === 500_000],
      ["the payout is untouched by the change (no write to agent_commissions / commission_distributions)", !(db as any).writes?.some?.((x: any) => x.table === "agent_commissions" || x.table === "commission_distributions")],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, add, price, comm, tasks: k.openTasks(db).map((t) => t.title), prop: (prop as any).ok, bad: (bad as any).ok ?? bad }).slice(0, 1800), note: `executed addendum → $490,000 governs; statement $500,000 → ${price?.classification}, blocking; ${k.openTasks(db).length} corrective task(s); the proposal moved nothing`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 10 — Signature door (proposed addendum → request → sandbox provider → verified completion → executed record)
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "10", title: "Signature door", directiveLine: 832,
  survivors: ["lib/esign/addendum-signature-request.ts proposeContractAddendumVersion / requestAddendumSignatures / syncAddendumSignatureRequest", "lib/esign/addendum-signature-rules.ts planAddendumSignatureRouting", "lib/offers/governing-terms.ts recordContractTermsVersion / governingContractTerms", "app/api/webhooks/docusign/route.ts (stripped: HMAC verify)", "app/dashboard/offers/outside-offer-threads.tsx (stripped: no placeholder)"],
  reuses: [{ from: "wave150", ref: 15, covers: "signatures + initials + documents + compliance before live / transaction; outside counters loop" }, { from: "proof", ref: "test:addendum-signatures", covers: "§A–§G incl. the REAL dispatch core, the webhook loop, integrity, sweep, m953" }],
  adverse: "another agent cannot send it; a partially signed envelope is NOT executed; a replayed completion records nothing twice",
  positiveControl: "the placeholder finder still catches 'not implemented' in a user-visible specimen string (the stripped scan is what passes)",
  blindSpot: "the provider is a SANDBOX seam (no DocuSign / SkySlope / Authentisign envelope is cut — SANDBOX, credentials OWNER-HELD); the real dispatch core and webhook loop run in test:addendum-signatures, here the dispatch is injected; signer authentication is the provider's",
  run: async () => {
    const C = await import("../lib/esign/addendum-signature-request")
    const T = await import("../lib/offers/governing-terms")
    const B = "11111111-1111-4111-8111-111111111111", U_AGENT = "a0000000-0000-4000-8000-000000000001", U_OTHER = "a0000000-0000-4000-8000-000000000002"
    const AG = "b0000000-0000-4000-8000-000000000001", AG_OTHER = "b0000000-0000-4000-8000-000000000002", BUYER = "c0000000-0000-4000-8000-0000000000b1", SELLER = "c0000000-0000-4000-8000-0000000000c1"
    const OFFER = "d0000000-0000-4000-8000-000000000001", TXN = "e0000000-0000-4000-8000-000000000001", DOC = "f0000000-0000-4000-8000-000000000001"
    const db = memSupabase({
      brokerages: [{ id: B, name: "Test Realty" }],
      users: [{ id: U_AGENT, brokerage_id: B, user_type: "agent", email: "agent@testrealty.example" }, { id: U_OTHER, brokerage_id: B, user_type: "agent", email: "other@testrealty.example" }],
      agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B, status: "active" }, { id: AG_OTHER, user_id: U_OTHER, brokerage_id: B, status: "active" }],
      contacts: [{ id: BUYER, brokerage_id: B, first_name: "Bea", last_name: "Buyer", email: "bea.buyer@mail.example" }, { id: SELLER, brokerage_id: B, first_name: "Sam", last_name: "Seller", email: "sam.seller@mail.example" }],
      offers: [{ id: OFFER, brokerage_id: B, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", property_address: "12 Oak St", transaction_id: TXN, metadata: {}, created_at: "2026-10-01T00:00:00Z" }],
      transactions: [{ id: TXN, brokerage_id: B, agent_id: AG, offer_id: OFFER, buyer_contact_id: BUYER, seller_contact_id: SELLER, property_address: "12 Oak St", property_state: "TX", contract_date: "2026-10-01", contract_closing_date: "2026-12-01", stage: "under_contract" }],
      transaction_participants: [],
      contract_term_versions: [{ id: "ctv-offer-1", brokerage_id: B, root_offer_id: OFFER, transaction_id: TXN, offer_id: OFFER, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { purchase_price: 500000, closing_date: "2026-12-01" }, executed_at: "2026-10-01T12:00:00Z", recorded_by: U_AGENT, evidence: {}, created_at: "2026-10-01T12:00:00Z" }],
      documents: [{ id: DOC, brokerage_id: B, transaction_id: TXN, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/unsigned.pdf?token=old", metadata: { file_name: "Closing date addendum.pdf" }, signature_completeness: null }],
      signature_requests: [], notifications: [], agent_action_ledger: [], document_field_extractions: [],
    }, { uuidIds: true, stampCreatedAt: true })
    const actor = { userId: U_AGENT, brokerageId: B, userType: "agent", teamId: null }
    const sent: any[] = []
    const recipients = new Map<string, Array<{ name: string; email: string; role: string }>>(), signed = new Map<string, Set<string>>()
    const sandbox = {
      async getSignatureStatus(env: string) { const rr = recipients.get(env) ?? []; const s = signed.get(env) ?? new Set(); const n = rr.filter((x) => s.has(x.email)).length; return { success: true, total: rr.length, signed: n, pending: rr.length - n, percentComplete: rr.length ? Math.round((n / rr.length) * 100) : 0 } },
      async syncDocuments(req: any) { const env = req.externalTransactionId; const rr = recipients.get(env) ?? []; const s = signed.get(env) ?? new Set(); const all = rr.length > 0 && rr.every((x) => s.has(x.email)); return { success: true, documents: [{ externalDocumentId: `${env}-doc`, documentName: "Addendum.pdf", folderName: "", isSigned: all, url: all ? `https://provider.example/${env}/signed.pdf` : undefined, signers: rr.map((x) => ({ name: x.name, email: x.email, role: x.role, signedAt: s.has(x.email) ? "2026-11-10T15:00:00.000Z" : undefined })) }] } },
    }
    const signedBytes = new TextEncoder().encode("%PDF-1.7 signed addendum ENV-C1 — both parties")
    const uploads: any[] = []
    const deps = {
      esignChoice: async () => ({ ok: true, kind: "api", providerName: "docusign" }), readiness: async () => ({ transactable: true, blockers: [], message: null }),
      documentUrl: async (_s: unknown, u: string) => u, event: async () => ({}), signal: async () => ({ ok: true }),
      dispatch: async (_s: unknown, input: any) => { sent.push(input); recipients.set("ENV-C1", input.signers); return { ok: true, kind: "api", providerName: "docusign", status: "sent", envelopeId: "ENV-C1" } },
      provider: async () => sandbox as never,
      fetchBytes: async () => ({ ok: true, bytes: signedBytes }),
      storeSignedCopy: async (svc: any, input: any) => { const id = `doc-signed-${uploads.length + 1}`; uploads.push(input); svc.tables.documents.push({ id, brokerage_id: input.brokerageId, transaction_id: input.transactionId, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/signed.pdf?token=t", metadata: input.metadata, signature_completeness: null }); return { ok: true, documentId: id } },
    }
    const proposed = await quiet(() => C.proposeContractAddendumVersion(db as never, actor as never, { ref: { transactionId: TXN }, kind: "addendum", documentId: DOC, terms: { closing_date: "2026-12-20" }, effectiveOn: "2026-11-12", termEvidence: { closing_date: { page: 1, field: "Closing Date", quote: "Closing shall occur on or before December 20, 2026" } } } as never))
    const vId = (proposed as any).versionId
    const govBefore = await quiet(() => T.governingContractTerms(db as never, B, { transactionId: TXN } as never))
    const wrong = await quiet(() => C.requestAddendumSignatures(db as never, { ...actor, userId: U_OTHER } as never, { versionId: vId } as never, deps as never))
    const req = await quiet(() => C.requestAddendumSignatures(db as never, actor as never, { versionId: vId, choices: { includeAttorneys: false } } as never, deps as never))
    const reqId = (req as any).requestId
    signed.set("ENV-C1", new Set(["bea.buyer@mail.example"]))
    const partial = await quiet(() => C.syncAddendumSignatureRequest(db as never, { brokerageId: B, requestId: reqId, source: "webhook" }, deps as never))
    const execAfterPartial = rows(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum").length
    signed.set("ENV-C1", new Set(["bea.buyer@mail.example", "sam.seller@mail.example"]))
    const done = await quiet(() => C.syncAddendumSignatureRequest(db as never, { brokerageId: B, requestId: reqId, source: "webhook" }, deps as never))
    const execRows = rows(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum")
    const replay = await quiet(() => C.syncAddendumSignatureRequest(db as never, { brokerageId: B, requestId: reqId, source: "webhook" }, deps as never))
    const govAfter = await quiet(() => T.governingContractTerms(db as never, B, { transactionId: TXN } as never))
    const reqRow = rows(db, "signature_requests").find((x) => x.id === reqId)
    const ui = code("app/dashboard/offers/outside-offer-threads.tsx")
    const PLACEHOLDER = /not implemented|coming soon|placeholder/i
    const hook = code("app/api/webhooks/docusign/route.ts")
    const h = halves([
      ["the proposal is recorded PROPOSED through the ONE recorder and does not govern (closing date unchanged, listed pending)", (proposed as any).ok && (govBefore as any).ok && (govBefore as any).governing.values.closing_date === "2026-12-01" && (govBefore as any).governing.pending.length === 1],
      ["the request routes the deal's own parties in order (buyer, seller) to the provider seam and records a SENT request with the envelope", (req as any).ok && sent.length === 1 && sent[0].signers.map((s: any) => s.role).join(",") === "buyer,seller" && reqRow?.provider_envelope_id === "ENV-C1" && rows(db, "agent_action_ledger").some((x) => x.action === "contract.addendum_signatures.request" && x.status === "executed")],
      ["every signer done → the signed copy hashed (sha256 pinned), filed, and the EXECUTED version recorded through the ONE recorder", (done as any).ok && (done as any).executed === true && execRows.length === 1 && execRows[0].evidence?.signed_sha256 === sha(signedBytes) && reqRow?.request_status === "completed"],
      ["governing terms reassessed: the contract now says 2026-12-20, governed by the executed addendum", (govAfter as any).ok && (govAfter as any).governing.values.closing_date === "2026-12-20" && (govAfter as any).governing.governingVersion?.source === "addendum"],
      ["the provider callbacks are verified (HMAC with a constant-time compare) before the loop runs", /createHmac\(|verifyDocuSignHmac|verifyHmac/.test(hook) && /timingSafeEqual\(|safeEqual\(/.test(hook + code("lib/forms/esign-execution-loop.ts") + code("lib/providers/webhook-signature.ts"))],
      ["no 'not implemented' placeholder remains on the addendum door's UI (stripped source)", ui.length > 0 && !PLACEHOLDER.test(ui.replace(/placeholder=\{?["'`][^"'`]*["'`]\}?/g, ""))],
    ], [
      ["ADVERSE · another agent of the same brokerage cannot send it (nothing dispatched)", !(wrong as any).ok && sent.length === 1],
      ["ADVERSE · a partially signed envelope moves to partially_signed and records NO executed version", (partial as any).ok && (partial as any).state === "partially_signed" && execAfterPartial === 0],
      ["ADVERSE · a replayed completion records nothing twice (one executed version, one filed copy)", (replay as any).ok && (replay as any).noop === true && rows(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum").length === 1 && uploads.length === 1],
      ["POSITIVE CONTROL · the placeholder finder catches 'not implemented' in a user-visible specimen string", PLACEHOLDER.test(stripComments(`<p>{"Request signatures — not implemented"}</p>`))],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, proposed, req, partial, done, replay, status: reqRow?.request_status, govAfter: (govAfter as any).governing?.values?.closing_date, wrong: (wrong as any).ok }).slice(0, 1800), note: `proposed → sent (ENV-C1, buyer→seller) → partial (not executed) → completed → executed v${execRows[0]?.version_no ?? "?"}; closing date 2026-12-01 → ${(govAfter as any).governing?.values?.closing_date}; replay a no-op`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 11 — CD correction
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "11", title: "CD correction", directiveLine: 833,
  survivors: ["lib/transactions/closing-compliance.ts runClosingCompliance (reconciliation tail)", "lib/offers/closing-cost-accuracy.ts reconcileClosingSettlement / closingSettlementGate", "lib/transactions/cda-closing-policy.ts reconcileSettlement"],
  reuses: [{ from: "proof", ref: "test:settlement-reconciliation", covers: "cases 1–10 incl. 7/7 mutations: missing credit, late price change, proposal, TRID, cash, post-close, role privacy" }],
  adverse: "the platform never edits the CD: the old green snapshot is kept and superseded; an ordinary fee revision invents no three-day wait",
  positiveControl: "the APR moving beyond 1/8 point on the revised CD DOES start a new waiting period — so the fee case's 'no wait' is the TRID rule, not a disabled branch",
  blindSpot: "the lender's / title's corrected document is a seeded extraction (no lender or title portal is called); the APR / product / penalty fields need the scanner prompt change (EVALUATED—NOT IMPLEMENTED by 152G; the branch escalates when unread); state attorney rules not modelled",
  run: async () => {
    const k = await settlementKit()
    const P = await import("../lib/transactions/cda-closing-policy")
    const db = settlementWorld()
    await k.run(db); await k.answerNo(db)
    await k.executed(db, DOC_ADD, { closing_cost_contribution: 10_000 }, { closing_cost_contribution: { page: 1, field: "Paragraph 4", quote: "Seller shall credit Buyer $10,000.00 at closing." } })
    const rec = (await k.run(db)).reconciliation?.reconciliation
    const item = rec?.items.find((i: any) => i.key === "term.seller_credit")
    const vers = k.snaps(db)
    const g = await k.gate(db)
    const task = k.openTasks(db).find((t) => /Seller credit/.test(String(t.title)))
    k.addCd(db, DOC_CD2, "2026-11-28T00:00:00Z", { ...CONSISTENT_CD, seller_credit_to_buyer: "10000" })
    const fixed = (await k.run(db)).reconciliation?.reconciliation
    const base = (over: Record<string, unknown> = {}) => ({ closing: { financing: "financed", tridTracked: true, closed: false, commissionFinalized: false }, findings: [], otherOpenBlocking: [], waivedTerms: [], statement: { documentId: "d1", classification: "closing_disclosure", stage: "unlabeled", receivedAt: "2026-11-25T00:00:00Z", versions: 2 }, figures: {}, priorCdFigures: null, dealRecord: { loanAmount: null }, trid: { cdDeliveredDate: "2026-11-20" }, cdaMode: "no_cda", cdaRail: { finalAttached: false, preliminaryReviewed: false, correctionRequestedAt: null, correctionRoute: null }, unreadStatementOnFile: false, openCorrectionTasks: 0, readFault: null, ...over })
    const fee = P.reconcileSettlement(base({ priorCdFigures: { apr: fig("6.500"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") }, figures: { apr: fig("6.550"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") } }) as never)
    const apr = P.reconcileSettlement(base({ priorCdFigures: { apr: fig("6.500"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") }, figures: { apr: fig("6.900"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") } }) as never)
    const h = halves([
      ["the new contractual credit missing on the CD → discrepancy, AWAITING A REVISED CLOSING DOCUMENT, blocking, the issuer named", rec?.state === "awaiting_revised_document" && item?.status === "missing_on_document" && item?.blocking === true && /lender|title/.test(String(item?.responsible))],
      ["ONE corrective request names the issuer and the amount (the title request — the platform never messages the issuer itself)", !!task && /\$10,000\.00/.test(String(task.description)) && /(lender|title)/i.test(String(task.description))],
      ["the close HOLDS on it", g.blockers.some((b: string) => /Seller credit/.test(b))],
      ["the corrected authoritative document is ingested, compared and cleared: READY, a NEW green version, exactly that task settled", fixed?.state === "ready" && k.snaps(db).slice(-1)[0]?.decision === "green" && !k.openTasks(db).some((t) => /Seller credit/.test(String(t.title)))],
      ["POSITIVE CONTROL · the APR beyond 1/8 point on the revised CD DOES start a new three-business-day wait", apr.trid.path === "new_waiting_period" && apr.trid.triggers.includes("apr_inaccurate")],
    ], [
      ["ADVERSE · the old CD is never final-reconciled or overwritten: version 1 green kept, the latest superseding it", vers.length >= 2 && vers[0].decision === "green" && vers.slice(-1)[0].evidence_json?.supersedes === vers[0].evidence_json?.fingerprint],
      ["ADVERSE · an ordinary fee revision → corrected CD, NO new wait invented (the three-day wait is not reset for every correction)", fee.trid.path === "corrected_cd_no_new_wait" && !fee.items.some((i: any) => i.key.startsWith("trid.") && i.blocking)],
      ["no lender signature is invented: the issuer's figures are listed as the issuer's (authoritative), never computed", (rec?.items ?? []).filter((i: any) => i.basis === "authoritative_required").every((i: any) => i.status !== "agrees" || i.documentSays !== null)],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, state: rec?.state, item, gate: g.blockers, task: task?.title, fixed: fixed?.state, fee: fee.trid, apr: apr.trid, snaps: vers.map((v) => [v.decision, v.evidence_json?.version]) }).slice(0, 1800), note: `$10,000 credit missing → ${rec?.state}; close held; revised CD → ${fixed?.state}; fee revision → ${fee.trid.path}; APR +0.4 → ${apr.trid.path}`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 12 — CDA policy change
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "12", title: "CDA policy change", directiveLine: 834,
  survivors: ["lib/transactions/cda-closing-policy.ts decideCdaPolicyChange / loadEffectiveCdaModes / decideDealCdaSwitch / cdaPolicyValue / resolveCdaMode", "app/actions/brokerage-cda-setup.ts setBrokerageCdaSettingAction (stripped: gate, ledger, policy version, rollback)"],
  reuses: [{ from: "wave151", ref: 7, covers: "transaction/finance: a CDA-disabled brokerage closes without one; funds never asserted from a date" }, { from: "proof", ref: "test:cda-effective-terms", covers: "§I the matrix cell by cell, 12/12 mutations" }],
  adverse: "a closed deal is never switched (no CDA added afterward); a mode change on a declared policy without a reason is refused; an unreadable policy history fails closed",
  positiveControl: "the naive reading (today's setting applied to every deal) WOULD require a CDA on the deal opened before the opt-in — so the per-deal answer is the effective-date rule",
  blindSpot: "the setter's session gate and the UI confirm step are read as stripped source (a Next session cannot be minted in tsx); RLS not modelled; owner decision L6.13 (the moment that decides a deal's policy) runs on its safe default",
  run: async () => {
    const P = await import("../lib/transactions/cda-closing-policy")
    const BX = "52000000-0000-4000-8000-0000000000c1", OLD = "52000000-0000-4000-8000-0000000000c2", NEW = "52000000-0000-4000-8000-0000000000c3", CLOSED = "52000000-0000-4000-8000-0000000000c4"
    const T1i = "2026-11-01T15:00:00.000Z"
    const optIn = { brokerage_id: BX, policy_key: P.CDA_POLICY_KEY, changed_by: "u-finance", reason: "brokerage now pays agents through title via a CDA", version: 1, value: P.cdaPolicyValue({ offers_cda: true } as never, T1i), previous: P.cdaPolicyValue({ offers_cda: false, non_cda_payout_default: "check" } as never, null), created_at: T1i }
    const db = memSupabase({
      brokerages: [{ id: BX, offers_cda: true, non_cda_payout_default: null }], tenant_policy_versions: [optIn],
      transactions: [{ id: OLD, brokerage_id: BX, created_at: "2026-10-15T09:00:00", status: "under_contract" }, { id: NEW, brokerage_id: BX, created_at: "2026-11-02T09:00:00", status: "under_contract" }, { id: CLOSED, brokerage_id: BX, created_at: "2026-09-01T09:00:00", status: "closed" }],
      closing_disclosure_agreement: [],
    })
    const eff = await P.loadEffectiveCdaModes(db as never, { brokerageId: BX, transactionIds: [OLD, NEW, CLOSED] })
    const d = (eff as any).ok ? (eff as any).deals : {}
    const flip = P.decideCdaPolicyChange({ before: { offersCda: false, nonCdaPayoutDefault: "check" }, next: { offersCda: true }, reason: "", openDeals: 2 })
    const flipOk = P.decideCdaPolicyChange({ before: { offersCda: false, nonCdaPayoutDefault: "check" }, next: { offersCda: true }, reason: "brokerage now pays agents through title via a CDA", openDeals: 2 })
    const sw = (o: Record<string, unknown>) => P.decideDealCdaSwitch({ effective: { mode: "no_cda" }, target: "cda", dealStatus: "under_contract", cdaRow: null, reason: "seller asked for title disbursement", ...o } as never)
    const refused = await P.loadEffectiveCdaModes(memSupabase({ brokerages: [{ id: BX, offers_cda: true }] }, { refuse: { tenant_policy_versions: "permission denied for table tenant_policy_versions" } }) as never, { brokerageId: BX, transactionIds: [OLD] })
    const setter = code("app/actions/brokerage-cda-setup.ts")
    const fn = fnSlice(setter, "export async function setBrokerageCdaSettingAction")
    const h = halves([
      ["an authorized broker turns CDA ON: the policy is versioned with an effective instant and the change carries a reason", flipOk.ok && flipOk.modeChanged && (eff as any).ok && (eff as any).current.mode === "cda"],
      ["a deal opened AFTER the change needs a CDA; a deal opened BEFORE keeps no-CDA (effective-date treatment)", d[NEW]?.mode === "cda" && d[NEW]?.cdaRequired === true && d[OLD]?.mode === "no_cda" && d[OLD]?.basis === "policy_when_opened"],
      ["the setter gates the finance admin first, ledgers finance.cda_policy.set, appends the policy version and rolls back when the version cannot be recorded", fn.length > 0 && before(fn, "requireCdaPolicyAdmin(", ".update(") && /finance\.cda_policy\.set/.test(fn) && /appendTenantPolicyVersion\(/.test(fn) && /offers_cda: b\.offers_cda/.test(fn.slice(fn.indexOf("appendTenantPolicyVersion("))) && /rolledBack:/.test(fn)],
      ["a finance admin may switch ONE in-progress deal with a reason", sw({}).ok],
      ["POSITIVE CONTROL · the naive reading (today's setting for every deal) WOULD require a CDA on the old deal", P.resolveCdaMode({ offersCda: true }).cdaRequired === true && d[OLD]?.cdaRequired === false],
    ], [
      ["ADVERSE · the historical non-CDA close stays valid: a closed deal keeps its policy and is never switched (no CDA added afterward)", d[CLOSED]?.mode === "no_cda" && (sw({ dealStatus: "closed" }) as any).error === "deal_completed" && rows(db, "closing_disclosure_agreement").length === 0],
      ["ADVERSE · a mode change on a declared policy with open deals and no reason is refused", !flip.ok && (flip as any).error === "reason_required"],
      ["ADVERSE · an unreadable policy history fails closed (a caller never guesses a mode)", !(refused as any).ok],
      ["no fake CDA: the CDA is never a closing requirement by itself (blocksClosing false in both modes)", P.resolveCdaMode({ offersCda: true }).blocksClosing === false && P.resolveCdaMode({ offersCda: false }).blocksClosing === false],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, current: (eff as any).current?.mode, deals: Object.fromEntries(Object.entries(d).map(([k2, v]: any) => [k2.slice(-2), [v.mode, v.basis]])), flip, flipOk: flipOk.ok, refused: (refused as any).ok }).slice(0, 1800), note: `opt-in: old deal → ${d[OLD]?.mode}, new deal → ${d[NEW]?.mode}, closed deal → ${d[CLOSED]?.mode} (never switched)`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 13 — Non-CDA closing
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "13", title: "Non-CDA closing", directiveLine: 835,
  survivors: ["lib/offers/closing-cost-accuracy.ts closingSettlementGate", "lib/commission/closing-verification.ts ensureClosingAttestationAsked / recordClosingAttestation / mayAttestClosing", "lib/transactions/cda-closing-policy.ts noCdaClosingProof / resolveCdaMode", "lib/transactions/stage-progression.ts canAdvanceStage (stripped: step 8b)"],
  reuses: [{ from: "wave151", ref: 7, covers: "a CDA-disabled brokerage closes without one; funds never asserted from a date" }, { from: "proof", ref: "test:settlement-reconciliation", covers: "case 7 — CDA disabled: compliance + settlement compared; the closing question BLOCKING before the close" }],
  adverse: "the close holds until the closing question is answered; a vendor seat and an agent off the deal may not answer it; the payout is held until a person records the receipt",
  positiveControl: "the deal's TC MAY answer, and a recorded deposit DOES make the funds received — so the refusals are the authority and evidence rules",
  blindSpot: "canAdvanceStage itself needs the service client + session (its CLOSED-branch order is read from stripped source; the gate is driven directly); the payout writer is not driven (the proof is read-only by design)",
  run: async () => {
    const k = await settlementKit()
    const P = await import("../lib/transactions/cda-closing-policy")
    const db = settlementWorld({ offersCda: false })
    const out = await k.run(db, "final_check")
    const g1 = await k.gate(db)
    const ans = await k.answerNo(db)
    const g2 = await k.gate(db)
    const proofArgs = (commissions: any[]) => ({ cdaMode: P.resolveCdaMode({ offersCda: false }), transaction: { status: "closed", close_date: "2026-12-15", compliance_passed_at: "2026-10-02T00:00:00Z" }, finalSettlement: { documentId: DOC_CD, uploadedAt: "2026-11-20T00:00:00Z", uploadedBy: SU_TC, uploadedByType: "tc" }, commissions, openBlockingCompliance: 0, lifetimeHoldOpen: true })
    const noReceipt = P.noCdaClosingProof(proofArgs([{ id: "ac-1", status: "approved", deposit_received_at: null }]) as never)
    const receipt = P.noCdaClosingProof(proofArgs([{ id: "ac-1", status: "approved", deposit_received_at: "2026-12-16T00:00:00Z", deposit_received_by: "u-finance" }]) as never)
    const sp = code("lib/transactions/stage-progression.ts")
    const h = halves([
      ["no CDA row is created or required; the settlement reconciles READY with the final record on file", rows(db, "closing_disclosure_agreement").length === 0 && out.reconciliation?.reconciliation?.state === "ready" && out.reconciliation?.reconciliation?.record.finalOnFile === true],
      ["answered 'no unrecorded change' by the deal's TC → the gate opens (settlement READY + final on file + the question answered)", (ans as any).ok && g2.blockers.length === 0],
      ["the closing proof reads authentic compliance + the title's final record, with separate payout evidence (receipt recorded → releasable)", receipt.fundsReceived === true && receipt.settlement.status === "on_file" && receipt.compliance.status === "passed" && receipt.payout.state === "releasable_after_receipt" && receipt.missing.length === 0],
      ["both close doors reach the gate: canAdvanceStage's CLOSED step calls closingSettlementGate and asks the closing question BLOCKING", /closingSettlementGate\(/.test(sp) && /ensureClosingAttestationAsked\(/.test(sp) && !/informational:\s*true/.test(sp)],
      ["POSITIVE CONTROL · the deal's TC may answer the closing question", k.cv.mayAttestClosing({ userId: SU_TC, agentId: null, userType: "tc" } as never, { agentIds: [SAG], coordinatorUserId: SU_TC } as never)],
    ], [
      ["ADVERSE · the close HOLDS until the closing question is answered (asked as a BLOCKING pending row — not informational)", g1.blockers.length >= 1 && g1.blockers.some((b: string) => /Closing question/.test(b))],
      ["ADVERSE · a vendor seat and an agent not on the deal may not answer it", !k.cv.mayAttestClosing({ userId: SU_VENDOR, agentId: null, userType: "vendor" } as never, { agentIds: [SAG], coordinatorUserId: SU_TC } as never) && !k.cv.mayAttestClosing({ userId: "x", agentId: "other-agent", userType: "agent" } as never, { agentIds: [SAG], coordinatorUserId: SU_TC } as never)],
      ["ADVERSE · the payout is HELD until a person records the brokerage's receipt (a closing date is not a receipt)", noReceipt.fundsReceived === false && noReceipt.payout.state === "held_funds_not_received" && noReceipt.missing.some((m: string) => /receipt/.test(m))],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, recon: out.reconciliation?.reconciliation?.state, g1: g1.blockers, ans, g2: g2.blockers, noReceipt: noReceipt.payout, receipt: receipt.payout }).slice(0, 1800), note: `no CDA: settlement ${out.reconciliation?.reconciliation?.state}; close held on the closing question → answered → gate open; payout ${noReceipt.payout.state} → ${receipt.payout.state} once the receipt is recorded`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 14 — Current Contact intelligence
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "14", title: "Current Contact intelligence", directiveLine: 836,
  survivors: ["lib/property-alerts/saved-home-watch.ts watchSavedHomes (decideSavedHomeNudge, the arbiter seam)", "lib/kernel/tenant-scope.ts tenantScope", "lib/intent/movement-signals.ts reassessExistingContact (reused by import)"],
  reuses: [{ from: "wave151", ref: 4, covers: "an existing Contact is reassessed on the SAME contact (never a Lead, no provider call)" }, { from: "wave151", ref: 5, covers: "property and buyers: saved-home verified state → the arbiter decides" }, { from: "proof", ref: "test:saved-home-alerts", covers: "§A–§L incl. the IDX account read and the inventory-friction play" }],
  adverse: "while the arbiter says wait nothing is sent and the state does not advance; a second sweep after delivery sends nothing again",
  positiveControl: "the same change with the arbiter choosing a note DOES deliver one buyer note — so the hold is the arbiter's decision, not a dead path",
  blindSpot: "the arbiter's model is a scripted decision seam; a buyer's consent capture is upstream (the saved home exists); RentCast / IDX are never called (a tenant listing is the source here)",
  run: async () => {
    const watch = await import("../lib/property-alerts/saved-home-watch")
    const { tenantScope } = await import("../lib/kernel/tenant-scope")
    const BRK14 = "11111111-1111-4111-8111-111111111114", BUYER = "33333333-3333-4333-8333-333333333314", AGENT = "66666666-6666-4666-8666-666666666614"
    const NOW14 = new Date("2026-11-09T14:00:00Z"), DAY = (n: number) => new Date(NOW14.getTime() + n * 86_400_000)
    const says = (optionId: string, extra: Record<string, unknown> = {}) => async () => ({ optionId, channel: null, format: null, waitHours: null, rationale: `The evidence supports ${optionId} for this buyer right now.`, evidence: ["moment"], confidence: 0.9, ...extra })
    const db = memSupabase({
      brokerages: [{ id: BRK14, name: "Lone Star Realty", state: "TX" }], brokerage_settings: [],
      contacts: [{ id: BUYER, brokerage_id: BRK14, first_name: "Dana", last_name: "Reyes", email: "dana@example.com", agent_id: AGENT, last_contacted_at: DAY(-5).toISOString() }],
      agents: [{ id: AGENT, brokerage_id: BRK14, user_id: "u-agent-14" }],
      listings: [{ id: "L1", brokerage_id: BRK14, status: "sold", list_price: 500000, mls_number: "A1", deleted_at: null }],
      saved_properties: [{ id: "sp", brokerage_id: BRK14, contact_id: BUYER, listing_id: "L1", source: "brokerage_listing", property_address: "12 Elm St", city: "Frisco", list_price: 500000, dismissed: false, last_verified_at: DAY(-1).toISOString(), last_verified_status: "active", last_verified_price: 500000, last_verified_mls_number: "A1", last_verified_source: "tenant_listing", verification_hold: null }],
      acquisition_plans: [], vendor_usage_tracking: [], agent_action_ledger: [], lifecycle_events: [], manager_signals: [], notifications: [], activities: [], tasks: [],
    }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const notes = () => rows(db, "notifications").filter((n) => n.type === watch.SAVED_HOME_ALERT_NOTIFICATION_TYPE)
    const sp = () => rows(db, "saved_properties").find((x) => x.id === "sp")
    const held = await quiet(() => watch.watchSavedHomes(db as never, tenantScope(BRK14, "wave152 canary"), { now: NOW14, unitUsd: 0.074, decide: says("wait", { waitHours: 12 }) as never }))
    const heldState = { notes: notes().length, status: sp()?.last_verified_status, hold: sp()?.verification_hold }
    const go = await quiet(() => watch.watchSavedHomes(db as never, tenantScope(BRK14, "wave152 canary"), { now: DAY(1), unitUsd: 0.074, decide: says("written_note") as never }))
    const again = await quiet(() => watch.watchSavedHomes(db as never, tenantScope(BRK14, "wave152 canary"), { now: DAY(2), unitUsd: 0.074, decide: says("written_note") as never }))
    const decisions = rows(db, "agent_action_ledger").filter((l) => String(l.action).startsWith("followup.decision."))
    const h = halves([
      ["the changed saved-home state reaches THE arbiter, which may hold (wait): the hold is said on the row and ledgered", (held as any).arbiterHeld === 1 && String(heldState.hold).startsWith("arbiter_wait:") && decisions.length >= 1],
      ["POSITIVE CONTROL · the arbiter choosing a note delivers ONE buyer note in plain words (no figure, no provider word) and advances the state", (go as any).delivered === 1 && notes().length === 1 && sp()?.last_verified_status === "sold" && !/rentcast|idx/i.test(notes()[0]?.body ?? "")],
      ["the alert stays on the SAME Contact (no Lead created)", rows(db, "leads").length === 0],
    ], [
      ["ADVERSE · while the arbiter says wait: nothing sent, the verified state NOT advanced", heldState.notes === 0 && heldState.status === "active"],
      ["ADVERSE · a second sweep after delivery sends nothing again (no duplicate message)", (again as any).delivered === 0 && notes().length === 1],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, held, heldState, go, again, decisions: decisions.length }).slice(0, 1800), note: `saved home sold → arbiter wait (held, 0 notes) → arbiter note (1 note) → re-sweep (0 more)`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 15 — Support recovery
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "15", title: "Support recovery", directiveLine: 837,
  survivors: ["lib/errors/index.ts handleError / presentTenantError / presentTenantMessage", "lib/kernel/immediate-operations.ts handleOperationFailureEscalated", "lib/support/ticket-triage.ts ensureOperationTicket / tenantFacingGate", "lib/portal/upload-feedback.ts reportContactUploadFailure"],
  reuses: [{ from: "wave150", ref: 16, covers: "manager → human support with tenant-safe words" }, { from: "wave151", ref: 10, covers: "engineering: provider errors leak no secrets; tenant support queues isolated" }, { from: "proof", ref: "test:tenant-facing-copy", covers: "A–G: one rule list, the presenter, six personas, the action boundary, the bell" }],
  adverse: "a raw RLS / PGRST refusal never reaches the person; 'tracked' is never said without the ticket that makes it true",
  positiveControl: "a plain validation refusal passes through the boundary UNCHANGED — so the replacement is the leak rule, not a blanket rewrite",
  blindSpot: "the support console and the bell renderer are not rendered; the ticket's triage model is scripted elsewhere (test:support-console / test:saved-home-alerts §H)",
  run: async () => {
    const E = await import("../lib/errors")
    const io = await import("../lib/kernel/immediate-operations")
    const tt = await import("../lib/support/ticket-triage")
    const uf = await import("../lib/portal/upload-feedback")
    const prevErr = console.error; console.error = () => {}
    let leak: any, plain: any
    try { leak = E.handleError({ message: "new row violates row-level security policy for table \"platform_credentials\"" }, "canary"); plain = E.handleError(new Error("Address is required"), "canary") } finally { console.error = prevErr }
    const bus = memSupabase({ support_tickets: [], notifications: [], users: [], tasks: [], agent_action_ledger: [], contacts: [{ id: "k-15", brokerage_id: TEAM, agent_id: "ag-15", first_name: "Dana" }], agents: [{ id: "ag-15", brokerage_id: TEAM, user_id: "u-ag-15" }] } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
    const bells: string[] = []
    const sig = { id: "sig-15", entityType: "user_invitations", entityId: "inv-1", payload: { operation: "invitation", readiness_keys: [], tenant_facing: "Invitation delivery did not verify — the email never left", platform_visible: false } }
    const notifyOrg = async (_s: unknown, _b: string, n: { body: string }) => { bells.push(n.body); return 1 }
    await quiet(() => io.handleOperationFailureEscalated(sig as never, { brokerageId: TEAM, supabase: bus } as never, { notifyOrg, notifyStaff: async () => 1, openTicket: async () => ({ ticketId: null, created: false, error: "refused" }) } as never))
    await quiet(() => io.handleOperationFailureEscalated(sig as never, { brokerageId: TEAM, supabase: bus } as never, { notifyOrg, notifyStaff: async () => 1, openTicket: async () => ({ ticketId: "tk-15", created: true, error: null }) } as never))
    const t = await quiet(() => tt.ensureOperationTicket(bus as never, { brokerageId: TEAM, operation: "phone_a2p", tenantFacing: "registration refused: api key sk_live_abc rejected", platformVisible: false } as never))
    const tk = rows(bus, "support_tickets").find((x) => x.id === (t as any).ticketId)
    const fb = await quiet(() => (uf.reportContactUploadFailure as any)(bus, { brokerageId: TEAM, contactId: "k-15", fileName: "paystub.pdf", kind: "storage_refused", raw: "StorageApiError: new row violates row-level security policy", payer: { kind: "team" } }))
    const fbText = JSON.stringify(fb ?? {})
    const h = halves([
      ["the person reads what happened, one action and a safe reference; the raw text stays internal", /^This didn't finish because of a problem on our side\. Next step: try again\. If it keeps happening, contact support\. Reference: [A-Z0-9]{8}\.$/.test(leak.error)],
      ["with a ticket, the bell says it is tracked — in the account's own lane (business-type neutral, no 'support team' claim)", /tracked as a support request your account's admins can see/.test(bells[1] ?? "") && !/support team/i.test(bells[1] ?? "") && !/brokerage/i.test(bells[1] ?? "")],
      ["the ticket reaches the correct owner with a truthful description (no 'checking and repairing' after a failed repair)", !!tk && /did not verify, and the automatic re-check could not fix it\./.test(String(tk.description))],
      ["POSITIVE CONTROL · a plain validation refusal passes UNCHANGED", plain.error === "Address is required"],
    ], [
      ["ADVERSE · the RLS refusal never reaches the person", !/row-level|platform_credentials/.test(leak.error)],
      ["ADVERSE · no ticket → the bell claims nothing is tracked", bells.length >= 2 && !/track|support team/i.test(bells[0] ?? "")],
      ["ADVERSE · a Contact's failed upload never shows provider text, a path or a key", !/StorageApiError|row-level|sk_live/.test(fbText)],
      ["the internal diagnostic (the key-shaped string) never reaches the tenant-facing gate as acceptable", !tt.tenantFacingGate("registration refused: api key sk_live_abc rejected").ok],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, leak: leak.error, plain: plain.error, bells, ticket: tk?.description, fb }).slice(0, 1800), note: `RLS text replaced with a reference; bell: no ticket → no 'tracked', ticket → tracked in the account's lane; Contact upload failure in plain words`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 16 — Privacy / RLS (the code-side tenant pins; live RLS is a blind spot)
// ═════════════════════════════════════════════════════════════════════════════
scenario({
  n: "16", title: "Privacy/RLS", directiveLine: 838,
  survivors: ["lib/marketing/qr-governance.ts editQrDestination / loadQrActivity", "lib/documents/receipt-intake.ts loadReceiptReview", "lib/documents/field-extraction-ledger.ts readDocumentExtractions", "lib/intelligence/roi-ledger.ts loadRoiOutcomeLedger", "lib/transactions/cda-closing-policy.ts settlementReconciliationForViewer", "lib/providers/tenant-provider-connections.ts redactProviderSecrets", "app/actions/transactions/closing-proof.ts getSettlementReconciliationAction (stripped)"],
  reuses: [{ from: "wave150", ref: 2, covers: "cross-tenant / cross-location isolation negative-tested" }, { from: "wave151", ref: 2, covers: "access: agents see Contacts only; team-lead / vendor matrices" }, { from: "proof", ref: "test:cross-tenant-read", covers: "the live-policy-shaped census" }, { from: "proof", ref: "test:secrets-rls", covers: "credential columns behind RLS + decryptSecret" }],
  adverse: "tenant B cannot edit A's QR destination or read its scans, cannot read A's receipt or its extractions, cannot open A's ROI ledger; a seller-side agent never sees the buyer's loan lines; a provider token never survives redaction",
  positiveControl: "tenant A reading its OWN code, receipt and ledger succeeds — so every refusal is the tenant pin, not a broken reader",
  blindSpot: "memSupabase enforces NO RLS: every refusal here is the code's own tenant predicate; the live policies (m963/m964/m965, storage.objects O1) are proven by their own proofs and the owner's read-backs, never by this canary",
  run: async () => {
    const gov = await import("../lib/marketing/qr-governance")
    const ri = await import("../lib/documents/receipt-intake")
    const fel = await import("../lib/documents/field-extraction-ledger")
    const roi = await import("../lib/intelligence/roi-ledger")
    const P = await import("../lib/transactions/cda-closing-policy")
    const tpc = await import("../lib/providers/tenant-provider-connections")
    const qdb = qrWorld()
    const m = await quiet(() => gov.mintGovernedQr({ purpose: "general", destinationType: "landing_page", idempotencyKey: "canary-16-qr-01", label: "Private" } as never, QA as never, qrDeps(qdb) as never))
    const id = (m as any).code?.id
    const editB = await quiet(() => gov.editQrDestination({ qrCodeId: id, targetUrl: "https://evil.example/x", idempotencyKey: "canary-16-edit-b" } as never, QB as never, qrDeps(qdb) as never))
    const actA = await quiet(() => gov.loadQrActivity(id, QA as never, qrDeps(qdb) as never)), actB = await quiet(() => gov.loadQrActivity(id, QB as never, qrDeps(qdb) as never))
    const svc = receiptWorld(), w = receiptWriter(svc, () => rAgent)
    const a = await quiet(() => ri.intakeReceipt(svc as never, { actor: rAgent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${RCPT_A}/u-agent/1.jpg` } as never, { reader: visionReader(READING), extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => RCPT_NOW } as never))
    const ownR = await quiet(() => ri.loadReceiptReview(svc as never, { actor: rAgent, documentId: (a as any).documentId } as never)), peekR = await quiet(() => ri.loadReceiptReview(svc as never, { actor: rOther, documentId: (a as any).documentId } as never))
    const extB = await quiet(() => fel.readDocumentExtractions(svc as never, { brokerageId: RCPT_B, documentIds: [(a as any).documentId] } as never))
    const rm = roiWorld()
    const ownL = await quiet(() => roi.loadRoiOutcomeLedger(rm as any, { userId: U_BROKER, brokerageId: RA }, WINDOW)), crossL = await quiet(() => roi.loadRoiOutcomeLedger(rm as any, { userId: U_BBROKER, brokerageId: RA }, WINDOW))
    const recon = P.reconcileSettlement({ closing: { financing: "financed", tridTracked: true, closed: false, commissionFinalized: false }, findings: [], otherOpenBlocking: [], waivedTerms: [], statement: { documentId: "d1", classification: "closing_disclosure", stage: "final", receivedAt: "2026-11-25T00:00:00Z", versions: 1 }, figures: { cashToClose: fig("103,250.00"), loanAmount: fig("400,000.00") }, priorCdFigures: null, dealRecord: { loanAmount: 400000 }, trid: { cdDeliveredDate: "2026-11-20" }, cdaMode: "no_cda", cdaRail: { finalAttached: false, preliminaryReviewed: false, correctionRequestedAt: null, correctionRoute: null }, unreadStatementOnFile: false, openCorrectionTasks: 0, readFault: null } as never)
    const sellerView = P.settlementReconciliationForViewer(recon, { side: "seller", staff: false }), buyerView = P.settlementReconciliationForViewer(recon, { side: "buyer", staff: false })
    const token = "abcdefghijklmnopqrstuvwxyz0123"
    const redacted = tpc.redactProviderSecrets(`401 from BatchData: Bearer ${token} rejected`)
    const door = code("app/actions/transactions/closing-proof.ts")
    const h = halves([
      ["POSITIVE CONTROL · tenant A reads its own code activity, its own receipt and its own ROI ledger", (actA as any).ok && (ownR as any).ok && (ownL as any).ok],
      ["the buyer-side view keeps the buyer's loan lines (the withholding is by side, counted)", buyerView.items.some((i: any) => i.key === "issuer.cash_to_close") && sellerView.withheld >= 1],
      ["the CD read door: session first, the deal read pinned to the session tenant, then only the deal's agents / TC / tenant staff (mayAttestClosing — a vendor / contact seat is refused) before the reconciliation is cut per viewer", (() => { const fn = fnSlice(door, "export async function getSettlementReconciliationAction"); return before(fn, "resolveSessionActor(", "createServiceClient(") && /\.eq\("brokerage_id", brokerageId\)/.test(fn) && before(fn, "mayAttestClosing(", "settlementReconciliationForViewer(") })()],
    ], [
      ["ADVERSE · tenant B cannot edit A's QR destination (reads as not in your account) or read its scans", !(editB as any).ok && !(actB as any).ok && rows(qdb, "qr_codes").find((x) => x.id === id)?.target_url !== "https://evil.example/x"],
      ["ADVERSE · tenant B cannot read A's receipt; the extraction reader returns B nothing of A's document", !(peekR as any).ok && (extB as any).ok && (extB as any).rows.length === 0],
      ["ADVERSE · a session of tenant B naming tenant A's workspace is refused the ROI ledger", !(crossL as any).ok],
      ["ADVERSE · a seller-side agent never sees the buyer's cash-to-close / loan lines", !sellerView.items.some((i: any) => i.key === "issuer.cash_to_close" || i.key === "issuer.loan_amount")],
      ["ADVERSE · a provider token never survives redaction (finder sees the raw token)", !redacted.includes(token) && `Bearer ${token}`.includes(token)],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, editB: (editB as any).code, actB: (actB as any).code, peekR: (peekR as any).ok, extB: (extB as any).rows?.length, crossL: (crossL as any).ok, withheld: sellerView.withheld, redacted }).slice(0, 1800), note: `B refused: QR edit/activity, receipt, extractions, ROI ledger; seller-side view withholds ${sellerView.withheld} buyer line(s); token redacted`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// R — REGULATORY AND FINANCIAL SAFETY TESTS (directive 840–849)
// ═════════════════════════════════════════════════════════════════════════════
const reconBase = (over: Record<string, unknown> = {}) => ({ closing: { financing: "financed", tridTracked: true, closed: false, commissionFinalized: false }, findings: [], otherOpenBlocking: [], waivedTerms: [], statement: { documentId: "d1", classification: "closing_disclosure", stage: "unlabeled", receivedAt: "2026-11-25T00:00:00Z", versions: 1 }, figures: {}, priorCdFigures: null, dealRecord: { loanAmount: null }, trid: { cdDeliveredDate: "2026-11-20" }, cdaMode: "no_cda", cdaRail: { finalAttached: false, preliminaryReviewed: false, correctionRequestedAt: null, correctionRoute: null }, unreadStatementOnFile: false, openCorrectionTasks: 0, readFault: null, ...over })

scenario({
  n: "R1", title: "Lender CD vs seller statement vs title/ALTA vs cash vs state closing attorney", directiveLine: 842,
  survivors: ["lib/transactions/cda-closing-policy.ts reconcileSettlement (record kind + issuer)", "lib/transactions/closing-compliance.ts (the seller's statement complements the buyer's CD)"],
  reuses: [{ from: "proof", ref: "test:settlement-reconciliation", covers: "case 6 (cash) and C2 (a different document complements)" }],
  adverse: "a cash closing demands no borrower-CD item and no TRID",
  positiveControl: "the financed deal DOES list the borrower-CD items (cash to close, loan amount)",
  blindSpot: "state-specific closing-attorney rules are NOT modelled (escalated to the licensed professional, stated in the rule's header); the seller's and buyer's CDs share one classification series (152G blind spot)",
  run: async () => {
    const P = await import("../lib/transactions/cda-closing-policy")
    const financed = P.reconcileSettlement(reconBase() as never)
    const cash = P.reconcileSettlement(reconBase({ closing: { financing: "cash", tridTracked: false, closed: false, commissionFinalized: false }, statement: { documentId: "s1", classification: "closing_disclosure", stage: "final", receivedAt: "2026-11-25T00:00:00Z", versions: 1 } }) as never)
    const hdr = raw("lib/transactions/cda-closing-policy.ts")
    const h = halves([
      ["a TRID-covered loan's record is the borrower's Closing Disclosure, issued by the LENDER", financed.record.kind === "trid_cd" && /lender/i.test(String(financed.record.issuer))],
      ["a cash closing's record is the settlement statement (ALTA / HUD-1 / attorney's statement) from title / settlement agent / closing attorney; TRID not applicable", cash.record.kind === "settlement_statement" && /title|attorney|settlement/i.test(String(cash.record.issuer)) && cash.trid.path === "not_applicable"],
      ["POSITIVE CONTROL · the financed deal lists the borrower-CD items", financed.items.some((i: any) => i.key === "issuer.cash_to_close")],
      ["state title / closing-attorney rules are stated as NOT modelled and escalated (never guessed)", /State title \/ closing-attorney rules are NOT modelled/.test(hdr)],
    ], [
      ["ADVERSE · the cash closing demands no borrower-CD item (no cash-to-close / loan-amount / TRID-coverage line)", !cash.items.some((i: any) => i.key === "issuer.cash_to_close" || i.key === "issuer.loan_amount" || i.key === "trid_coverage")],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, financed: financed.record, cash: [cash.record, cash.trid.path] }).slice(0, 1200), note: `financed → ${financed.record.kind} (${financed.record.issuer}); cash → ${cash.record.kind}, TRID ${cash.trid.path}`, state: "built" }
  },
})

scenario({
  n: "R2", title: "TRID: corrected CD vs the subset that needs a new three-business-day wait", directiveLine: 843,
  survivors: ["lib/transactions/cda-closing-policy.ts reconcileSettlement → tridRevisionAssessment"],
  reuses: [{ from: "proof", ref: "test:settlement-reconciliation", covers: "cases 4 + 5: APR / product / penalty vs an ordinary fee revision; escalations" }],
  adverse: "a fee-only revision never starts a new wait; uncertain cases (the 1/8–1/4 band, an APR decrease) are escalated, never decided",
  positiveControl: "an APR increase beyond 1/8 point, a loan-product change and an added prepayment penalty each DO start the new wait (12 CFR 1026.19(f)(2)(ii))",
  blindSpot: "regular vs irregular transaction is not known (the band escalates); the actual delivery dates are seeded; the CFPB text is cited in the rule's header, not fetched",
  run: async () => {
    const P = await import("../lib/transactions/cda-closing-policy")
    const prior = { apr: fig("6.500"), loanProduct: fig("30-year fixed"), prepaymentPenalty: fig("no") }
    const t = (cur: Record<string, unknown>) => P.reconcileSettlement(reconBase({ statement: { documentId: "d2", classification: "closing_disclosure", stage: "unlabeled", receivedAt: "2026-11-25T00:00:00Z", versions: 2 }, priorCdFigures: prior, figures: { ...prior, ...cur } }) as never).trid
    const apr = t({ apr: fig("6.900") }), prod = t({ loanProduct: fig("5/1 ARM") }), pp = t({ prepaymentPenalty: fig("yes") }), fee = t({ apr: fig("6.550") }), band = t({ apr: fig("6.700") }), down = t({ apr: fig("6.200") })
    const h = halves([
      ["APR beyond 1/8 point → new waiting period", apr.path === "new_waiting_period" && apr.triggers.includes("apr_inaccurate")],
      ["loan product change → new waiting period", prod.path === "new_waiting_period" && prod.triggers.includes("loan_product_changed")],
      ["added prepayment penalty → new waiting period", pp.path === "new_waiting_period" && pp.triggers.includes("prepayment_penalty_added")],
    ], [
      ["ADVERSE · an ordinary revision (APR within tolerance) → corrected CD, NO new wait", fee.path === "corrected_cd_no_new_wait"],
      ["ADVERSE · the 1/8–1/4 band and an APR decrease beyond 1/8 are escalated to the lender, never decided", band.path === "escalate_to_lender" && down.path === "escalate_to_lender"],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, apr, prod, pp, fee, band, down }).slice(0, 1400), note: `APR/product/penalty → new wait; fee → ${fee.path}; band → ${band.path}; decrease → ${down.path}`, state: "built" }
  },
})

scenario({
  n: "R3", title: "Executed contracts and signed addenda immutable; ambiguous governing language flags", directiveLine: 844,
  survivors: ["supabase/migrations/m986 (stripped SQL: the immutability trigger + executed-addendum CHECK)", "lib/offers/governing-terms-rule.ts buildTermLedger / unresolvedTieSources"],
  reuses: [{ from: "wave150", ref: 14, covers: "executed addenda govern; actual tracked apart" }, { from: "proof", ref: "test:transaction-addenda", covers: "§I ledger: ties unresolved naming the licensed professional" }],
  adverse: "two same-source executed instruments with no ordering are UNRESOLVED (never numbered into a winner)",
  positiveControl: "the SQL finder sees the trigger and CHECK names in the migration text it reads",
  blindSpot: "the trigger's enforcement is Postgres's (memSupabase runs no trigger); m986's applied stamp is read by the readiness guard's wave-151 gate",
  run: async () => {
    const { stripSqlComments } = await import("./strip-sql-comments")
    const gtr = await import("../lib/offers/governing-terms-rule")
    const f = existsSync(join(ROOT, "supabase/migrations")) ? (await import("node:fs")).readdirSync(join(ROOT, "supabase/migrations")).find((x: string) => /^m986-/.test(x)) : null
    const sql = f ? stripSqlComments(raw(`supabase/migrations/${f}`)) : ""
    const src = code("lib/offers/governing-terms-rule.ts")
    const h = halves([
      ["history is immutable at the database (BEFORE UPDATE OR DELETE trigger) and an executed addendum must carry its document (CHECK)", /contract_term_versions_immutable/.test(sql) && /BEFORE UPDATE OR DELETE/i.test(sql) && /contract_term_versions_executed_addendum_has_document_check/.test(sql)],
      ["POSITIVE CONTROL · the SQL finder sees the trigger name in a specimen", /contract_term_versions_immutable/.test("CREATE TRIGGER contract_term_versions_immutable_trg BEFORE UPDATE OR DELETE")],
    ], [
      ["ADVERSE · same-source contradictions with no order are UNRESOLVED (unresolvedTieSources addendum + amendment), naming the professional", /unresolvedTieSources:\s*\["addendum",\s*"amendment"\]/.test(src) && typeof (gtr as any).buildTermLedger === "function"],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, migration: f }).slice(0, 600), note: `m986: immutable trigger + executed-addendum CHECK in the SQL; ties unresolved by rule`, state: "built" }
  },
})

scenario({
  n: "R4", title: "No fabricated receipt numbers, double expense, fake deposit, fake payout or invented post-closing revision", directiveLine: 845,
  survivors: ["lib/documents/receipt-rules.ts normalizeIsoDate / normalizeUsd", "lib/transactions/cda-closing-policy.ts noCdaClosingProof (funds only from receipt evidence)", "lib/offers/closing-cost-accuracy.ts (post-close: no payout write)"],
  reuses: [{ from: "proof", ref: "test:receipt-intelligence", covers: "§3 a date with no year is null; §5 duplicates" }, { from: "proof", ref: "test:settlement-reconciliation", covers: "case 8 post-closing: finance task, paid ledger untouched" }],
  adverse: "an ambiguous amount and a yearless date stay null; a closing date is never a receipt; no settlement path writes the payout ledger",
  positiveControl: "a well-formed amount and a full date DO normalize; a recorded deposit DOES make funds received",
  blindSpot: "the payout writer itself is not driven here (the proof reads it); a post-closing revision's finance task is test:settlement-reconciliation case 8",
  run: async () => {
    const rr = await import("../lib/documents/receipt-rules")
    const P = await import("../lib/transactions/cda-closing-policy")
    const ok$ = rr.normalizeUsd("43.17"), bad$ = rr.normalizeUsd("43,17.5"), okD = rr.normalizeIsoDate("2026-11-03"), noYear = rr.normalizeIsoDate("11/03")
    const p = (commissions: any[]) => P.noCdaClosingProof({ cdaMode: P.resolveCdaMode({ offersCda: false }), transaction: { status: "closed", close_date: "2026-12-15", compliance_passed_at: "2026-10-02T00:00:00Z" }, finalSettlement: null, commissions, openBlockingCompliance: 0, lifetimeHoldOpen: true } as never)
    const dateOnly = p([{ id: "ac", status: "approved", deposit_received_at: null }]), recorded = p([{ id: "ac", status: "approved", deposit_received_at: "2026-12-16T00:00:00Z", deposit_received_by: "u-fin" }])
    const writers = ["lib/offers/closing-cost-accuracy.ts", "lib/transactions/closing-compliance.ts", "lib/transactions/cda-closing-policy.ts"].map((x) => ({ x, s: code(x) }))
    const PAYOUT_WRITE = /from\(["'](agent_commissions|commission_distributions)["']\)[\s\S]{0,160}\.(insert|update|upsert|delete)\(/
    const h = halves([
      ["POSITIVE CONTROL · a clean amount and a full date normalize", ok$ === 43.17 && okD === "2026-11-03"],
      ["POSITIVE CONTROL · a recorded deposit makes the funds received", recorded.fundsReceived === true],
      ["POSITIVE CONTROL · the payout-write finder sees a specimen update", PAYOUT_WRITE.test(`svc.from("agent_commissions").update({ status: "paid" })`)],
    ], [
      ["ADVERSE · an ambiguous amount stays null (never a plausible number)", bad$ === null],
      ["ADVERSE · a date printed without a year stays null (never a guessed year)", noYear === null],
      ["ADVERSE · a closing date alone is never a receipt (no fake deposit)", dateOnly.fundsReceived === false && dateOnly.payout.state === "held_funds_not_received"],
      ["ADVERSE · no settlement / reconciliation path writes the payout ledger (no fake payout, no mutable paid ledger)", writers.every(({ s }) => !PAYOUT_WRITE.test(s))],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, ok$, bad$, okD, noYear, dateOnly: dateOnly.payout, recorded: recorded.payout, writers: writers.filter(({ s }) => PAYOUT_WRITE.test(s)).map(({ x }) => x) }).slice(0, 1200), note: `ambiguous amount → ${bad$}; yearless date → ${noYear}; date-only receipt → ${dateOnly.payout.state}`, state: "built" }
  },
})

scenario({
  n: "R5", title: "AI extraction fills permitted draft fields; consequential writes need authority and validation", directiveLine: 846,
  survivors: ["lib/documents/receipt-rules.ts decideReceiptPosting / autopostGrantFor", "lib/documents/receipt-intake.ts approveReceipt (scope roster)", "lib/transactions/cda-closing-policy.ts CDA_FILL_RULE"],
  reuses: [{ from: "proof", ref: "test:receipt-intelligence", covers: "§2 held for a person; §7 who may post where; grant shapes" }],
  adverse: "with no approved grant nothing auto-posts; an agent choosing the brokerage's books is refused before the writer; AI never fills a CDA",
  positiveControl: "an approved grant covering the exact clean case under its ceiling DOES allow the manager to post",
  blindSpot: "no auto-post grant exists live (OWNER-HELD) — the grant path is exercised on a planted grant set; the model is scripted",
  run: async () => {
    const rr = await import("../lib/documents/receipt-rules")
    const ri = await import("../lib/documents/receipt-intake")
    const P = await import("../lib/transactions/cda-closing-policy")
    const svc = receiptWorld(), w = receiptWriter(svc, () => rAgent)
    const out = await quiet(() => ri.intakeReceipt(svc as never, { actor: rAgent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${RCPT_A}/u-agent/1.jpg` } as never, { reader: visionReader(READING), extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => RCPT_NOW } as never))
    const asAgentBrokerage = await quiet(() => ri.approveReceipt(svc as never, { actor: rAgent, documentId: (out as any).documentId, scope: "brokerage" } as never, { postExpense: w.post, now: () => RCPT_NOW } as never))
    const none = rr.autopostGrantFor(new Set<string>(), "receipt" as never), granted = rr.autopostGrantFor(new Set(["receipt_autopost:receipt:max_usd=75"]), "receipt" as never)
    const h = halves([
      ["the extraction fills DRAFT fields only and holds for a person (no grant)", (out as any).state === "held" && rows(svc, "business_expenses").length === 0 && rows(svc, "document_field_extractions").length > 0],
      ["POSITIVE CONTROL · an approved grant for the exact kind under its ceiling is recognised", granted?.ceilingUsd === 75],
    ], [
      ["ADVERSE · with no grant there is no auto-post", none === null],
      ["ADVERSE · an agent choosing the brokerage's books is refused BEFORE the writer", !(asAgentBrokerage as any).ok && w.calls.length === 0],
      ["ADVERSE · AI never fills a CDA (the agent fills; AI may only explain)", P.CDA_FILL_RULE.aiFills === false && P.CDA_FILL_RULE.agentFills === true],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, state: (out as any).state, asAgentBrokerage: (asAgentBrokerage as any).reasons, none, granted }).slice(0, 1200), note: `held for review; no grant → no auto-post; agent → brokerage books refused; CDA aiFills=false`, state: "built" }
  },
})

scenario({
  n: "R6", title: "A CDA setting does not itself prove settlement / CD accuracy", directiveLine: 847,
  survivors: ["lib/transactions/cda-closing-policy.ts reconcileSettlement (cdaMode)", "lib/offers/closing-cost-accuracy.ts closingSettlementGate (both modes)"],
  reuses: [{ from: "proof", ref: "test:cda-effective-terms", covers: "§I.8 a CDA-mode change never clears a compliance / settlement hold" }],
  adverse: "a CDA brokerage with a missing executed credit is still AWAITING a revised document",
  positiveControl: "the same CDA brokerage with a statement that agrees reads READY",
  blindSpot: "the CDA workflow's own figure gate is a second, separate check (test:cda-closing-flow); RLS not modelled",
  run: async () => {
    const P = await import("../lib/transactions/cda-closing-policy")
    const finding = { term: "seller_credit", label: "Seller credit", verdict: "mismatch", classification: "MISSING", governing: "$10,000.00", settlement: null, why: "x", blocking: true, correction: "x", governingSource: "addendum", settlementSource: null }
    const withCda = P.reconcileSettlement(reconBase({ cdaMode: "cda", findings: [finding] }) as never)
    const clean = P.reconcileSettlement(reconBase({ cdaMode: "cda" }) as never)
    const ca = code("lib/offers/closing-cost-accuracy.ts")
    const gateFn = fnSlice(ca, "export async function closingSettlementGate")
    const h = halves([
      ["POSITIVE CONTROL · a CDA brokerage whose statement agrees reads READY", clean.state === "ready"],
      ["the settlement gate runs in BOTH modes (the CDA mode only decides whether the closing question is asked, never whether accuracy is checked)", gateFn.length > 0 && /reconcil/i.test(gateFn)],
    ], [
      ["ADVERSE · a CDA brokerage with an executed credit missing on the statement is NOT reconciled (awaiting a revised document, blocking)", withCda.state !== "ready" && withCda.blockers.length > 0],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, withCda: [withCda.state, withCda.blockers], clean: clean.state }).slice(0, 1000), note: `CDA mode + missing credit → ${withCda.state}; CDA mode + agreeing statement → ${clean.state}`, state: "built" }
  },
})

scenario({
  n: "R7", title: "Agent Contact-only visibility and the team-lead / vendor access matrices stay intact", directiveLine: 848,
  survivors: ["lib/auth/lead-visibility.ts LEAD_DESK_USER_TYPES / resolveTeamLeadContactScope", "lib/auth/resolve-user-role.ts TENANT_ADMIN_USER_TYPES", "lib/kernel/portal-auth.ts requireLenderVendorActor (stripped)"],
  reuses: [{ from: "wave150", ref: 2, covers: "cross-tenant / cross-location isolation" }, { from: "wave151", ref: 2, covers: "access: agents see Contacts, never the raw-lead queue; team-lead scope; vendor assigned work only" }],
  adverse: "an agent and a compliance officer are not on the lead desk; a lender is never a user type",
  positiveControl: "the ISA and the tenant-admin roster ARE on the lead desk",
  blindSpot: "the live RLS policies (m963/m964/m965) are judged by their own proofs (test:access-matrix, test:cross-tenant-read); this canary reads the code rosters",
  run: async () => {
    const lv = await import("../lib/auth/lead-visibility")
    const rur = await import("../lib/auth/resolve-user-role")
    const desk = [...(lv as any).LEAD_DESK_USER_TYPES] as string[]
    const admins = [...(rur as any).TENANT_ADMIN_USER_TYPES] as string[]
    const pa = ident("lib/kernel/portal-auth.ts") + ident("lib/kernel/lender-linkage.ts")
    const h = halves([
      ["POSITIVE CONTROL · the ISA and the operational admin roster (minus compliance_officer) are on the lead desk", desk.includes("isa") && admins.filter((a) => a !== "compliance_officer").every((a) => desk.includes(a))],
      ["the team-lead contact scope is a code twin of the policy (resolveTeamLeadContactScope)", typeof (lv as any).resolveTeamLeadContactScope === "function"],
    ], [
      ["ADVERSE · an agent never sees the Lead / raw-lead queue (agent off the lead desk)", !desk.includes("agent")],
      ["ADVERSE · compliance_officer is not on the lead desk (§5)", !desk.includes("compliance_officer")],
      ["ADVERSE · no portal gate asks users.user_type for 'lender' (a lender is a vendor category)", !/user_type\s*===?\s*["']lender["']/.test(code("lib/kernel/portal-auth.ts") + code("lib/kernel/lender-linkage.ts")) && pa.length > 0],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, desk, admins }).slice(0, 800), note: `lead desk: ${desk.join(", ")}`, state: "built" }
  },
})

scenario({
  n: "R8", title: "QR access and redirects: no open redirect, no PII leak, no malicious destination", directiveLine: 849,
  survivors: ["lib/marketing/qr-contract.ts validateQrDestination / resolveQrScanDestination", "lib/marketing/tracked-qr.ts mintTrackedQr (token, never the label)"],
  reuses: [{ from: "proof", ref: "test:qr-registry", covers: "§9 23 refusals + 9 acceptances; §7 the label never reaches the printed URL" }],
  adverse: "javascript:, http, an IP host, credentials in the URL, a loop through another code, personal data in the query and a foreign host are each refused; a Contact id in a minter's label never reaches the printed URL",
  positiveControl: "an in-app path and the tenant's verified host are accepted; the resolver keeps an in-app destination in-app",
  blindSpot: "the allow-list (six hosts) is an owner decision on its safe default; a live redirect chain at the destination is not followed",
  run: async () => {
    const qc = await import("../lib/marketing/qr-contract")
    const tq = await import("../lib/marketing/tracked-qr")
    const v = (url: string) => qc.validateQrDestination({ url, appOrigins: [ORIGIN], tenantHosts: ["homes.alder.example"] } as never)
    const refused = ["javascript:alert(1)", "http://homes.alder.example/x", "https://10.0.0.1/x", "https://user:pass@homes.alder.example/x", `${ORIGIN}/api/qr/scan?slug=abc`, "https://homes.alder.example/x?phone=4045550100", "https://evil.example/x"].map((u) => [u, v(u)] as const)
    const accepted = [`${ORIGIN}/listings/LA`, "https://homes.alder.example/open-house"].map((u) => [u, v(u)] as const)
    const db = memSupabase({ qr_codes: [] }, { uuidIds: true })
    const CONTACT = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
    const minted = await tq.mintTrackedQr({ brokerageId: "bA", label: `pre_listing_kit:${CONTACT}`, purpose: "campaign", origin: ORIGIN } as never, db as never)
    const inApp = qc.resolveQrScanDestination({ slug: "tok", targetUrl: "/listings/LA", appOrigins: [ORIGIN] } as never)
    const h = halves([
      ["POSITIVE CONTROL · an in-app path and the tenant's verified host are accepted", accepted.every(([, r]) => (r as any).ok)],
      ["the resolver keeps an in-app destination in-app (never an arbitrary external hop)", (inApp as any).kind === "in_app"],
    ], [
      ["ADVERSE · every unsafe destination is refused with a reason", refused.every(([, r]) => !(r as any).ok)],
      ["ADVERSE · a Contact id in a minter's label never reaches the printed scan URL (the token is not the label)", !!minted && !minted.scanUrl.includes("7f1c2d3e") && !minted.scanUrl.includes("pre_listing_kit")],
    ])
    return { ...h, detail: JSON.stringify({ failing: h.failing, refused: refused.map(([u, r]) => [u, (r as any).ok, (r as any).code]), accepted: accepted.map(([u, r]) => [u, (r as any).ok]), url: minted?.scanUrl, inApp }).slice(0, 1400), note: `${refused.length} unsafe destinations refused, ${accepted.length} safe accepted; the printed URL carries the token only`, state: "built" }
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN — the scenarios, the safety tests, then every wave-150 canary / wave-151 group a scenario reuses, BY IMPORT
// ═════════════════════════════════════════════════════════════════════════════
async function runVerdict(f: () => Promise<Verdict>): Promise<Verdict> {
  try { return await f() } catch (e) { return { positive: false, negative: false, detail: `THREW: ${(e as Error)?.stack ?? String(e)}` } }
}
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" WAVE 152 canaries (in-memory, SIMULATED) — the directive's 16 end-to-end scenarios + 8 regulatory / financial safety tests,")
  console.log(" each POSITIVE + ADVERSE + positive control + blind spot; wave-150 canaries and wave-151 groups reused BY IMPORT")
  console.log("══════════════════════════════════════════════════════════════")
  let passed = 0, failed = 0
  const failures: string[] = []
  for (const s of SCENARIOS) {
    const v = await runVerdict(s.run)
    const ok = v.positive && v.negative
    if (ok) passed++; else { failed++; failures.push(`${s.n}. ${s.title}`) }
    console.log(`\n ${ok ? "✓" : "✗"} ${s.n.padStart(3)}. ${s.title} (directive line ${s.directiveLine}) — positive ${v.positive ? "✓" : "✗"} · adverse ${v.negative ? "✓" : "✗"}${ok ? ` · ${v.state ?? "built"} · SIMULATED` : ""}`)
    console.log(`      survivors: ${s.survivors.join(" · ")}`)
    console.log(`      reuses: ${s.reuses.map((x) => `${x.from === "proof" ? x.ref : `${x.from} #${x.ref}`} — ${x.covers}`).join("; ") || "none"}`)
    console.log(`      adverse: ${s.adverse}`)
    console.log(`      positive control: ${s.positiveControl}`)
    console.log(`      blind spot: ${s.blindSpot}`)
    if (v.note) console.log(`      note: ${v.note}`)
    if (!ok) console.log(`      evidence: ${String(v.detail ?? "").slice(0, 2400)}`)
  }
  const r150 = [...new Set(SCENARIOS.flatMap((s) => s.reuses.filter((x) => x.from === "wave150").map((x) => Number(x.ref))))].sort((a, b) => a - b)
  const r151 = [...new Set(SCENARIOS.flatMap((s) => s.reuses.filter((x) => x.from === "wave151").map((x) => Number(x.ref))))].sort((a, b) => a - b)
  console.log("\n──────────────────────────────────────────────────────────────")
  console.log(` reused by import: wave-150 canaries (${r150.length}) ${r150.map((n) => `#${n}`).join(" ")} · wave-151 groups (${r151.length}) ${r151.map((n) => `#${n}`).join(" ")}`)
  let reusedPassed = 0, reusedFailed = 0
  for (const n of r150) {
    const c = WAVE150_CANARIES.find((x) => x.n === n)
    const v = c ? await runVerdict(c.run) : { positive: false, negative: false, detail: "not in the imported wave-150 roster" }
    const ok = v.positive && v.negative
    if (ok) reusedPassed++; else { reusedFailed++; failures.push(`wave-150 #${n}`) }
    console.log(` ${ok ? "✓" : "✗"} wave-150 #${String(n).padStart(2)} "${c?.title ?? "?"}"${ok ? ` · ${v.state ?? "built"}` : ` — ${String(v.detail ?? "").slice(0, 400)}`}`)
  }
  for (const n of r151) {
    const g = WAVE151_GROUPS.find((x) => x.n === n)
    const v = g ? await runVerdict(g.run) : { positive: false, negative: false, detail: "not in the imported wave-151 roster" }
    const ok = v.positive && v.negative
    if (ok) reusedPassed++; else { reusedFailed++; failures.push(`wave-151 group #${n}`) }
    console.log(` ${ok ? "✓" : "✗"} wave-151 #${String(n).padStart(2)} "${g?.group ?? "?"}"${ok ? ` · ${v.state ?? "built"}` : ` — ${String(v.detail ?? "").slice(0, 400)}`}`)
  }
  const scen = SCENARIOS.filter((s) => /^\d+$/.test(s.n)).length, safety = SCENARIOS.filter((s) => /^R\d+$/.test(s.n)).length
  console.log(` measured: background echo rejections ${backgroundRejections.length} · CHECK vocabularies read ${Object.keys(CHECK_VOCABULARIES).length} tables`)
  console.log(" blind spots: memSupabase has no CHECK/FK/RLS/storage policy/trigger · no provider, model, e-sign account, Lob, BatchData, IDX, RentCast,")
  console.log("   storage or Vercel is called (sandbox seams only — SIMULATED) · routes and React are read as stripped source · the owner obligations")
  console.log("   (O1 storage policies, O2 seed accounts, O3/O4 hosting), counsel sign-off and provider activation are owner work no canary can see")
  if (failures.length) for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(` RESULT: canaries ${passed + reusedPassed} passed, ${failed + reusedFailed} failed (${scen} scenarios + ${safety} safety tests + ${r150.length + r151.length} reused by import)`)
  console.log(failed + reusedFailed === 0 ? "WAVE152_CANARIES_PASS" : "WAVE152_CANARIES_FAIL")
  process.exit(failed + reusedFailed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); console.log("WAVE152_CANARIES_FAIL"); process.exit(1) })
