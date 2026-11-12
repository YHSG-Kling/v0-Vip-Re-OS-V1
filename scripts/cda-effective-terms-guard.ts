/**
 * scripts/cda-effective-terms-guard.ts — test:cda-effective-terms (wave 150, lane 150XY / directive 150Y + canary 14;
 * pure + in-memory, no DB, no network, no model).
 *
 * WHAT IT HOLDS:
 *   A · CDA ONLY WHEN THE TENANT USES IT — resolveCdaMode over brokerages.offers_cda (true / false / undeclared) driven; a missing
 *       CDA never blocks closing; the payout gate needs a CDA brokerage for closing-time release.
 *   B · AGENT-FILLED — CDA_FILL_RULE (agent fills, AI never fills, AI may explain); the template never pre-fills money from a model.
 *   C · EXECUTED ADDENDA SUPERSEDE TERMS BEFORE CLOSING — resolveGoverningTerms driven: an executed addendum replaces the price, a
 *       PROPOSED one never governs, the original is preserved; a version is executed only with both signatures (recorder text).
 *   D · COMPLIANCE + PAYOUTS RE-READ EFFECTIVE TERMS — the consequence runner's impact driven (price → gross commission, CDA, cap,
 *       referral, seller net; a contingency-days change moves no money); closing compliance, the closing verification and the CDA
 *       page read the ONE reader; the transaction row the commission engine prices is mirrored from executed terms.
 *   E · CANARY 14 — "on or before" + an earlier lender/title day: no executed amendment, anticipated moves, the contract date and
 *       the actual date stay separate facts; a fixed "on" day moved needs one; the closing_date term reaches the agreement-as-of date.
 *   F · THE MONEY CHAIN — caps/anniversary, referral, team split, revenue share, fees are waterfall steps; HUD/CD figures compared
 *       (never fabricated as $0); title vs attorney by state; seller-vs-agent concessions follow the offer chain onto the deal.
 *   G · CLOSED → LIFETIME MONOTONICITY — the verdict ladder (not closed / records pending / payout pending / lifetime) driven.
 *   H · CLOSING ATTESTATION WITHOUT A CDA IS AN OWNER DECISION — the attestation is asked ONLY on the CDA path today; nothing in
 *       this lane invented a non-CDA closing gate (census with a positive control).
 *   I · THE EFFECTIVE CDA POLICY (wave 152, lane 152H; owner: "if a brokerage changes their policy from a no cda to now using cda can
 *       turn the setting to opt in") — driven on the in-memory client through the REAL doors: no-CDA close → the brokerage opts in
 *       (finance admin, brokerage-wide scope, reason, ledgered, versioned, effective at the save) → a deal opened after needs the CDA
 *       at the closing gate → the earlier completed close stays completed and gets no CDA → an in-progress deal keeps its policy (no
 *       fake form) unless a finance admin switches it → the agent fills (AI never) → opt-out keeps a signed CDA → turning CDA off
 *       never clears a compliance / TRID hold → agent, team lead, compliance officer, office admin and another brokerage are refused.
 *
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { resolveCdaMode, resolvePayoutTiming, CDA_FILL_RULE, comparePreliminaryStatementFigures } from "../lib/transactions/cda-closing-policy"
import { resolveGoverningTerms, type TermsVersion } from "../lib/offers/governing-terms-rule"
import { afterExecutedContractChange } from "../lib/offers/governing-terms-consequences"
import { resolveClosingDates, assessClosingDateChange } from "../lib/transactions/closing-dates"
import { closingStateNote } from "../lib/state-forms/closing-participants"
import { lifetimeConversionVerdict } from "../lib/kernel/lifetime-conversion"

// ── §I seams (wave 152, lane 152H): installed before §I's first dynamic import of the doors. The session is a fixture caller; the
//    clients are the in-memory one; kernel events are recorded; the closing-compliance gate is the fixture's verdict. Static imports
//    above loaded nothing that needs them. (The repo's idiom — scripts/tenant-policy-versions-guard.ts, scripts/journey-promotion-gates-guard.ts.)
type Caller = { userId: string; agentId: string | null; brokerageId: string; userType: string; isTenantPrincipal: boolean }
const H = globalThis as unknown as { __152H: { svc: unknown; caller: Caller | null; events: unknown[]; closingGate: { allowed: boolean; blockers: string[] }; scans: string[] } }
H.__152H = { svc: null, caller: null, events: [], closingGate: { allowed: true, blockers: [] }, scans: [] }
// The universal scanner OCRs a URL (network) — RECORDED instead, only at its one importer (lib/documents/upload-document.ts).
const SCANNER_STUB = "export async function scanUploadedDocument(p){ globalThis.__152H.scans.push(p.documentId); return { success: true, documentId: p.documentId } }"
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__152H.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__152H.svc; export const createServerClient = createClient",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export async function emitKernelEvent(i){ globalThis.__152H.events.push(i); return { inserted: true, lifecycleEventId: 'ev-' + globalThis.__152H.events.length, fanOutOk: true, error: null } }",
  "@/lib/agreements/session-actor": "export async function resolveSessionActor(){ const c = globalThis.__152H.caller; return c ? { ok: true, actor: { userId: c.userId, agentId: c.agentId, brokerageId: c.brokerageId, userType: c.userType, isTenantPrincipal: c.isTenantPrincipal } } : { ok: false, error: 'unauthenticated' } }",
  "@/lib/kernel/api-auth": "export async function requireAuth(){ const c = globalThis.__152H.caller; return c ? { ok: true, user: { id: c.userId }, userId: c.userId, agentId: c.agentId, brokerageId: c.brokerageId, userType: c.userType, platformRole: null } : { ok: false, response: null } }",
  "@/app/actions/transaction-compliance": "export async function canProceedToClosingPrep(){ return globalThis.__152H.closingGate } export async function seedTransactionComplianceChecks(){ return { success: true } }",
}
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module's ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec] ?? (spec === "./scan-uploaded-document" && String(ctx?.parentURL ?? "").includes("lib/documents/upload-document") ? SCANNER_STUB : undefined)
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
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
const code = (p: string) => stripComments(raw(p))
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f() } finally { console.error = e; console.warn = w } }

const B = "11111111-1111-4111-8111-111111111111"
const v = (over: Partial<TermsVersion>): TermsVersion => ({ versionNo: 1, source: "offer", status: "executed", offerId: null, documentId: null, executedAt: "2026-10-01T00:00:00Z", terms: {}, derived: false, ...over })

async function main() {
  section("A · a CDA only when the tenant uses one")
  {
    const yes = resolveCdaMode({ offersCda: true }), no = resolveCdaMode({ offersCda: false, nonCdaPayoutDefault: "check" }), undeclared = resolveCdaMode({ offersCda: null })
    check("offers_cda true → CDA mode; false → no CDA (payout default kept); undeclared → no CDA (never manufactured)",
      yes.mode === "cda" && yes.cdaRequired && no.mode === "no_cda" && no.payoutMethodDefault === "check" && undeclared.mode === "no_cda" && undeclared.reason === "cda_not_declared")
    check("a missing CDA never blocks closing in either mode", yes.blocksClosing === false && no.blocksClosing === false)
    const t = resolvePayoutTiming({ offersCda: false, payoutTiming: "at_closing_per_cda" })
    check("closing-time payout without a CDA brokerage falls back to the brokerage-receipt gate, with the finding said", t.timing === "after_brokerage_receipt" && !!t.finding)
    const readers = ["lib/transactions/stage-progression.ts", "lib/transactions/closing-orchestration.ts", "lib/transactions/cda-delivery-reaper.ts", "lib/commission/reconcile-tracking.ts"].filter((p) => /resolveCdaMode\(/.test(code(p)))
    check("every closing reader asks the ONE switch (resolveCdaMode)", readers.length === 4, readers.join(", "))
  }

  section("B · the agent fills the CDA; AI only explains")
  {
    check("CDA_FILL_RULE: agent fills, AI never fills, AI may explain figures", CDA_FILL_RULE.agentFills === true && CDA_FILL_RULE.aiFills === false && CDA_FILL_RULE.aiMayExplainFigures === true)
    const MODEL = /from\s+["']@\/lib\/ai\/|anthropic|openai|generateText/i
    const cdaFiles = ["lib/transactions/cda-template-fields.ts", "lib/transactions/cda-pdf-fill.ts", "lib/transactions/cda-closing-policy.ts", "lib/commission/cda-discrepancy.ts"]
    const hits = cdaFiles.filter((p) => MODEL.test(code(p)))
    check("no model in the CDA fill / template / policy / discrepancy code", hits.length === 0, hits.join(", "))
    check("POSITIVE CONTROL: the model finder recognises a specimen", MODEL.test(`import { generateText } from "ai"`))
  }

  section("C · executed addenda supersede terms before closing — originals preserved")
  {
    const original = v({ versionNo: 1, source: "offer", terms: { offer_price: 500_000, closing_date: "2026-12-15", title_policy_payer: "seller" }, executedAt: "2026-10-01T00:00:00Z" })
    const addendum = v({ versionNo: 1, source: "addendum", terms: { offer_price: 490_000 }, executedAt: "2026-10-20T00:00:00Z", documentId: "doc-add-1" })
    const proposed = v({ versionNo: 2, source: "addendum", status: "proposed", terms: { offer_price: 480_000 }, executedAt: null })
    const g = resolveGoverningTerms([original, addendum, proposed])
    check("the EXECUTED addendum governs the price (490,000); untouched terms stay from the original", g.values.offer_price === 490_000 && g.values.title_policy_payer === "seller" && g.values.closing_date === "2026-12-15")
    check("the superseded original value is preserved as a conflict record, and every version is kept", g.conflicts.some((c) => c.key === "offer_price" && c.superseded.value === 500_000 && c.governing.value === 490_000) && g.versions.length === 3)
    check("a PROPOSED addendum never governs — it is reported as pending", g.pending.length === 1 && g.values.offer_price !== 480_000)
    check("the governing version is the addendum", g.governingVersion?.source === "addendum")
    const rec = code("lib/offers/governing-terms.ts")
    check("an executed version needs a stored document showing BOTH signatures (the recorder refuses otherwise)", /signaturesPresent\([\s\S]{0,120}?\["buyer", "seller"\]\)/.test(rec) && /an executed version needs the executed document/.test(rec))
  }

  section("D · compliance and payouts re-read the EFFECTIVE terms")
  {
    const impact = async (changedTerms: Record<string, unknown>) => (await quiet(() => afterExecutedContractChange(memSupabase({}) as never, { brokerageId: B, transactionId: null, rootOfferId: "root-1", versionNo: 2, source: "addendum", changedTerms, documentId: "doc-1", executedOn: "2026-10-20", recordedBy: null }))).impact
    const price = await impact({ offer_price: 490_000 })
    const days = await impact({ inspection_period_days: 12 })
    const date = await impact({ closing_date: "2026-12-08" })
    check("a price change reaches gross commission, CDA, cap contribution, referral fee and seller net", price.moneyMoved && ["gross_commission", "cda", "cap_contribution", "referral_fee", "seller_net"].every((o) => price.obligations.includes(o as never)))
    check("a contingency-days change moves no money (the deadlines rail reads it)", !days.moneyMoved && days.nonFinancialTerms.includes("inspection_period_days"))
    check("a closing-date change reaches the agreement-as-of date and the cap cycle (which agreement and cap year price the deal)", date.obligations.includes("agreement_as_of_date" as never) && date.obligations.includes("cap_contribution" as never))
    const cons = code("lib/offers/governing-terms-consequences.ts")
    check("the runner mirrors executed money terms onto the transaction row the engine prices, re-runs compliance, reopens the attestation and the CDA",
      /offer_price:\s*"purchase_price"/.test(cons) && /runClosingCompliance/.test(cons) && /reopenClosingAttestation/.test(cons) && /reopenCdaForCorrection/.test(cons))
    const readers = ["lib/commission/closing-verification.ts", "app/actions/cda-portal.ts", "lib/transactions/closing-compliance.ts"].filter((p) => /governingContractTerms\(/.test(code(p)))
    check("closing verification, the CDA page and closing compliance call the ONE reader (governingContractTerms)", readers.length === 3, readers.join(", "))
    check("the recorder runs the consequences for every EXECUTED addendum / amendment", /afterExecutedContractChange\(/.test(code("lib/offers/governing-terms.ts")))
  }

  section("E · canary 14 — 'on or before', earlier closing, actual tracked separately")
  {
    const deal = { status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_terms: "on_or_before", contract_closing_source: "executed_contract", property_state: "CA", financing_type: "conventional" }
    const early = assessClosingDateChange(deal, { date: "2026-12-08", kind: "anticipated" })
    check("an earlier lender/title day under 'on or before' is within the contract and needs NO executed amendment", early.direction === "earlier" && early.withinContract === true && early.requiresExecutedAmendment === false)
    check("...and the lender (TRID CD ≥ 3 business days), title/escrow and the CDA are named to coordinate", early.coordinate.some((c) => /TRID/.test(c)) && early.coordinate.some((c) => /CDA/.test(c)))
    const fixed = assessClosingDateChange({ ...deal, contract_closing_terms: "on" }, { date: "2026-12-08", kind: "anticipated" })
    check("POSITIVE CONTROL: a fixed 'on' day moved earlier DOES need an amendment", fixed.requiresExecutedAmendment === true)
    const unread = assessClosingDateChange({ ...deal, contract_closing_terms: null }, { date: "2026-12-08", kind: "anticipated" })
    check("an unread wording is 'unknown' — never a default amendment demand", unread.requiresExecutedAmendment === "unknown")
    const closed = resolveClosingDates({ ...deal, status: "closed", actual_close_date: "2026-12-09", close_date: "2026-12-09" })
    check("actual is its own fact: closed on 12-09 while the contract still says on or before 12-15", closed.actual?.date === "2026-12-09" && closed.contractual?.date === "2026-12-15" && closed.contractual?.terms === "on_or_before")
  }

  section("F · the money chain — caps, referral, team, revenue share, fees, HUD/CD, title/attorney, concessions")
  {
    const steps = readdirSync(join(ROOT, "lib/commission/waterfall")).filter((f) => f.endsWith(".ts"))
    const need = ["03b-referral-deduction.ts", "07-apply-cap.ts", "08-team-split.ts", "09-revenue-share.ts", "10-fees.ts"]
    check("the waterfall carries referral, cap, team split, revenue share and fees as ordered steps", need.every((s) => steps.includes(s)), steps.join(","))
    check("cap anniversary basis is a declared vocabulary (lib/commission/cap-resolver.ts)", /export const CAP_ANNIVERSARY_BASES/.test(code("lib/commission/cap-resolver.ts")) && /export function resolveAnniversaryWindow/.test(code("lib/commission/cap-resolver.ts")))
    const cmp = comparePreliminaryStatementFigures({ sales_price: 490_000, gross_commission: 15_000 }, { sales_price: 490_000, gross_commission: 14_700, agent_net: 10_000 })
    check("HUD/CD: a $300 / 2% gross gap is a discrepancy; a figure the statement lacks is UNVERIFIABLE, never $0",
      cmp.discrepancies.some((d) => d.field === "gross_commission" && d.severity === "warning") && cmp.unverifiable.includes("agent_net") && !cmp.discrepancies.some((d) => d.field === "agent_net"))
    const ny = closingStateNote("NY"), ca = closingStateNote("CA")
    check("who conducts the closing comes from the state (attorney vs title/escrow), never assumed", ny.conductedBy.startsWith("attorney") && ca.conductedBy === "title_or_escrow_typically")
    check("seller-vs-agent concessions requested on the offer chain follow it onto the deal at promotion", /anchorOfferConcessionsToTransaction\(/.test(code("lib/offers/governing-terms.ts")) && existsSync(join(ROOT, "lib/commission/agent-concession.ts")))
  }

  section("G · closed → lifetime monotonicity")
  {
    const not = lifetimeConversionVerdict({ closed: false, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: false })
    const rec = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: false, payoutVerified: true, requirePayoutVerified: false })
    const pay = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: true })
    const life = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: false, requirePayoutVerified: false })
    check("not closed → no conversion; records pending → hold; payout pending (when the tenant requires it) → hold; otherwise LIFETIME",
      not.action === "not_closed" && rec.action === "hold_records" && pay.action === "hold_payout_pending" && life.action === "convert")
    const DEMOTE = /\.update\(\{[^}]*lifecycle_state:\s*["'](lead|prospect|active)["'][^}]*\}\)[\s\S]{0,120}["']lifetime/
    const kernel = code("lib/kernel/lifetime-conversion.ts")
    check("the ONE lifetime writer only promotes (no demotion from lifetime in the module); POSITIVE CONTROL on a specimen",
      !DEMOTE.test(kernel) && /export async function promoteDealContactsToLifetime/.test(kernel) && DEMOTE.test(`.update({ lifecycle_state: "lead" }).eq("lifecycle_state", "lifetime")`))
  }

  section("H · closing attestation WITHOUT a CDA — asked BEFORE the no-CDA close as a BLOCKING row (wave 152 owner ruling: 'that is not informational')")
  {
    // WAVE 151 (lane 151K; OWNER-SQL §L L6.2 option (b)): the question is asked on exactly TWO paths — the CDA submit door (blocking,
    // the CDA is held on it) and the no-CDA gated close (informational: is_blocking false, the close is never held). Option (c), a
    // blocking ask for no-CDA brokerages, stays an owner decision — so a THIRD caller, or a blocking ask at the close, is the defect.
    const SITE = /ensureClosingAttestationAsked\(/
    const roots = ["app", "lib"]
    const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${d}/${e.name}`)) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : [])
    const callers = roots.flatMap(walk).filter((p) => p !== "lib/commission/closing-verification.ts" && SITE.test(code(p))).sort()
    check("the attestation is ASKED on exactly two paths: the CDA submit door and the no-CDA gated close — no third caller", callers.join(",") === "app/actions/cda-portal.ts,lib/transactions/stage-progression.ts", callers.join(", "))
    const sp = code("lib/transactions/stage-progression.ts"), portal = code("app/actions/cda-portal.ts")
    const spCall = sp.slice(sp.indexOf("ensureClosingAttestationAsked(supabase"), sp.indexOf("ensureClosingAttestationAsked(supabase") + 220)
    const can = sp.slice(sp.indexOf("export async function canAdvanceStage"), sp.indexOf("export async function advanceStage"))
    check("the no-CDA close asks it BLOCKING before the close (canAdvanceStage's CLOSED target) and never informationally; the CDA door asks it with no informational flag", spCall.length > 0 && /ensureClosingAttestationAsked\(supabase/.test(can) && !/informational:\s*true/.test(sp) && !/informational/.test(portal))
    check("the writer makes EVERY ask a blocking row (no informational branch)", /is_blocking:\s*true/.test(code("lib/commission/closing-verification.ts")) && !/is_blocking:\s*!informational/.test(code("lib/commission/closing-verification.ts")))
    check("POSITIVE CONTROL: the census finder recognises a call", SITE.test(`await ensureClosingAttestationAsked(svc, { brokerageId, transactionId })`))
  }

  await sectionI()

  console.log("\nBLIND SPOTS: the consequence runner is driven with no transaction (impact only); its writes on a live deal are held by")
  console.log("  test:agreement-governance §F; the AI split COACH's model call is not driven (its filter and brief are — test:transaction-addenda §E);")
  console.log("  commission-off-agent-display is held by its own existing proofs, not re-scanned here; state rules are as sourced, not verified true.")
  console.log("  §I: RLS is not modelled (the doors' tenant predicates scope the reads; the service client runs after the gate); the session is a")
  console.log("  fixture caller; closing compliance is the fixture's verdict (its own proofs drive it); the approve / broker-sign / send-to-title doors")
  console.log("  are held by their pure gates + source here (test:cda-closing-flow drives them); the closing-orchestration runner is checked by")
  console.log("  source; the reaper, the finalizer and the config-snapshot apply are driven; a deal's opening time is transactions.created_at (UTC);")
  console.log("  the gate checks read the CDA-milestone blocker only (152G's settlement hold is test:settlement-reconciliation's); the statement")
  console.log("  bridge (cda-portal readStatementOnDocumentsRail) and the reconciliation hold on the review door are checked by source here.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(` FAILED: ${failures.join(" · ")}`); process.exit(1) }
}

// ═══ I · THE EFFECTIVE CDA POLICY (wave 152, lane 152H) ═══════════════════════════════════════════════════════════════
async function sectionI() {
  section("I · a brokerage that used no CDA opts in — effective policy, in-progress deals, permissions (wave 152, lane 152H)")
  const P = await import("../lib/transactions/cda-closing-policy")
  const noZ = (ms: number) => new Date(ms).toISOString().replace("Z", "") // transactions.created_at is timestamp WITHOUT time zone
  const fnBody = (src: string, name: string) => { const i = src.indexOf(`export async function ${name}(`); if (i < 0) return ""; const j = src.indexOf("\nexport async function ", i + 10); return src.slice(i, j < 0 ? undefined : j) }

  // ── I.1 the matrix, cell by cell through THE ONE READER (loadEffectiveCdaModes) on a fresh in-memory client per cell ──
  {
    const BX = "52000000-0000-4000-8000-0000000000c1", TX = "52000000-0000-4000-8000-0000000000c2"
    type Hist = { version: number; value: unknown; previous: unknown; created_at: string }
    const effOf = async (live: { offersCda: boolean | null; nonCdaPayoutDefault?: string | null }, history: Hist[], deal?: { openedAt: string; fieldValues?: unknown }) => {
      const c = memSupabase({
        brokerages: [{ id: BX, offers_cda: live.offersCda, non_cda_payout_default: live.nonCdaPayoutDefault ?? null }],
        tenant_policy_versions: history.map((h) => ({ brokerage_id: BX, policy_key: P.CDA_POLICY_KEY, changed_by: null, reason: "fixture", ...h })),
        transactions: deal ? [{ id: TX, brokerage_id: BX, created_at: deal.openedAt, status: "under_contract" }] : [],
        closing_disclosure_agreement: deal?.fieldValues ? [{ id: "cx", brokerage_id: BX, transaction_id: TX, field_values: deal.fieldValues }] : [],
      })
      const r = await P.loadEffectiveCdaModes(c, { brokerageId: BX, transactionIds: deal ? [TX] : [] })
      if (!r.ok) throw new Error(r.error)
      const v = deal ? r.deals[TX] : r.current
      if (!v) throw new Error("deal absent")
      return v
    }
    const T1 = "2026-11-01T15:00:00.000Z", T2 = "2026-11-20T15:00:00.000Z"
    const optIn = { version: 1, value: P.cdaPolicyValue({ offers_cda: true }, T1), previous: P.cdaPolicyValue({ offers_cda: false, non_cda_payout_default: "check" }, null), created_at: T1 }
    const optOut = { version: 2, value: P.cdaPolicyValue({ offers_cda: false, non_cda_payout_default: "direct_deposit" }, T2), previous: optIn.value, created_at: T2 }
    const live = { offersCda: true }
    const before = await effOf(live, [optIn], { openedAt: "2026-10-15T09:00:00" })
    const after = await effOf(live, [optIn], { openedAt: "2026-11-02T09:00:00" })
    const exact = await effOf(live, [optIn], { openedAt: "2026-11-01T15:00:00" })
    check("OPT IN: a deal opened BEFORE the change keeps no CDA (version 0 — the value before the first recorded change); one opened AFTER needs a CDA; a deal opened at the very instant (zone-less created_at read as UTC) takes the new policy",
      before.mode === "no_cda" && before.basis === "policy_when_opened" && before.policyVersion === 0 && before.differsFromCurrent && after.mode === "cda" && after.cdaRequired && after.policyVersion === 1 && exact.mode === "cda", JSON.stringify({ before: before.mode, after: after.mode, exact: exact.mode }))
    check("POSITIVE CONTROL — the naive reading (today's setting applied to every deal) WOULD require a CDA on the deal opened before the opt-in", P.resolveCdaMode(live).cdaRequired === true && before.cdaRequired === false)
    const mid = await effOf({ offersCda: false, nonCdaPayoutDefault: "direct_deposit" }, [optOut, optIn], { openedAt: "2026-11-10T00:00:00" })
    const late = await effOf({ offersCda: false, nonCdaPayoutDefault: "direct_deposit" }, [optIn, optOut], { openedAt: "2026-11-25T00:00:00" })
    check("OPT OUT: a deal opened while CDA was the policy keeps its CDA (version 1); a deal opened after the opt-out closes without one (version 2)", mid.mode === "cda" && mid.policyVersion === 1 && late.mode === "no_cda" && late.policyVersion === 2)
    const sw = await effOf(live, [optIn], { openedAt: "2026-10-15T09:00:00", fieldValues: { cda_mode_switch: { mode: "cda", by: "u-admin", at: "2026-11-05T00:00:00Z", reason: "seller asked for title disbursement", from: "no_cda" } } })
    const noReason = await effOf(live, [optIn], { openedAt: "2026-10-15T09:00:00", fieldValues: { cda_mode_switch: { mode: "cda", by: "u-admin", at: "2026-11-05T00:00:00Z", reason: "" } } })
    check("a finance admin's SWITCH of one deal governs it (basis deal_switch, the reason in the explanation); a switch with no reason (or no actor) governs nothing", sw.mode === "cda" && sw.basis === "deal_switch" && /seller asked/.test(sw.explanation) && noReason.mode === "no_cda" && noReason.dealSwitch === null)
    const none = await effOf({ offersCda: true }, [], { openedAt: "2026-01-01T00:00:00" })
    check("NO RECORDED CHANGE → today's behaviour exactly (the live setting governs every deal) — existing tenants and proofs are unchanged", none.mode === "cda" && none.basis === "current_policy" && none.policyVersion === 0 && !none.differsFromCurrent)
    const drift = await effOf({ offersCda: false }, [optIn])
    check("a setting changed OUTSIDE the audited door is flagged (unrecordedChange) and said in words — never silently treated as recorded", drift.unrecordedChange && /outside CDA settings/.test(drift.explanation))
    const refusedHistory = await P.loadEffectiveCdaModes(memSupabase({ brokerages: [{ id: BX, offers_cda: true }] }, { refuse: { tenant_policy_versions: "permission denied for table tenant_policy_versions" } }), { brokerageId: BX, transactionIds: [TX] })
    check("ADVERSE — FAIL CLOSED: an unreadable policy history returns not-ok with its reason (a caller never guesses a mode)", !refusedHistory.ok && /history could not be read/.test((refusedHistory as { error: string }).error))
    check("the explanation is plain words for the deal (when it opened, which policy, who can switch it) — no column, table or code names", /opened on 2026-10-15/.test(before.explanation) && /finance admin can switch/.test(before.explanation) && !/offers_cda|tenant_policy|closing_disclosure_agreement|cda_mode_switch/.test(before.explanation + after.explanation + sw.explanation))

    const first = P.decideCdaPolicyChange({ before: { offersCda: null }, next: { offersCda: true }, reason: "", openDeals: 0 })
    const firstWithDeals = P.decideCdaPolicyChange({ before: { offersCda: null }, next: { offersCda: true }, reason: " ", openDeals: 2 })
    const flip = P.decideCdaPolicyChange({ before: { offersCda: false, nonCdaPayoutDefault: "check" }, next: { offersCda: true }, reason: "", openDeals: 0 })
    const declareNo = P.decideCdaPolicyChange({ before: { offersCda: null }, next: { offersCda: false }, reason: "", openDeals: 5 })
    const payout = P.decideCdaPolicyChange({ before: { offersCda: false, nonCdaPayoutDefault: "check" }, next: { offersCda: false, nonCdaPayoutDefault: "direct_deposit" }, reason: "", openDeals: 5 })
    check("REASON RULE: a mode change needs a reason whenever deals or a declared policy are affected (first answer with no deals does not; declaring 'no CDA' from unanswered moves no deal; a payout-default change is not a mode change)",
      first.ok && first.modeChanged && !firstWithDeals.ok && !flip.ok && declareNo.ok && !declareNo.modeChanged && payout.ok && payout.changed && !payout.modeChanged)

    const sw1 = (o: Partial<Parameters<typeof P.decideDealCdaSwitch>[0]>) => P.decideDealCdaSwitch({ effective: { mode: "no_cda" }, target: "cda", dealStatus: "under_contract", cdaRow: null, reason: "brokerage asked for a CDA", ...o })
    check("DEAL SWITCH RULES: a closed / funded / lost deal is never switched (a CDA is never added afterward); same mode refused; reason required; an APPROVED / signed / title-delivered CDA is never dropped; a drafting CDA may be switched off",
      !sw1({ dealStatus: "closed" }).ok && (sw1({ dealStatus: "closed" }) as { error: string }).error === "deal_completed" && !sw1({ dealStatus: "funded" }).ok
      && (sw1({ target: "no_cda" }) as { error: string }).error === "already_in_mode" && (sw1({ reason: "" }) as { error: string }).error === "reason_required"
      && (sw1({ effective: { mode: "cda" }, target: "no_cda", cdaRow: { status: "approved", uses_cda: true } }) as { error: string }).error === "cda_already_authorized"
      && (sw1({ effective: { mode: "cda" }, target: "no_cda", cdaRow: { status: "drafting", sent_to_title_at: "2026-11-01T00:00:00Z", uses_cda: true } }) as { error: string }).error === "cda_already_authorized"
      && sw1({ effective: { mode: "cda" }, target: "no_cda", cdaRow: { status: "drafting", uses_cda: true } }).ok && sw1({}).ok)
  }

  // ── I.2 the owner's chain, through the REAL doors on the in-memory client ──
  const B = "52000000-0000-4000-8000-0000000000b1", M = "52000000-0000-4000-8000-0000000000b2", X = "52000000-0000-4000-8000-0000000000b3", U = "52000000-0000-4000-8000-0000000000b4"
  const UB = "52000000-0000-4000-8000-000000000101", UA = "52000000-0000-4000-8000-000000000102", UTL = "52000000-0000-4000-8000-000000000103", UCO = "52000000-0000-4000-8000-000000000104"
  const UMO = "52000000-0000-4000-8000-000000000105", UML = "52000000-0000-4000-8000-000000000106", UX = "52000000-0000-4000-8000-000000000107"
  const AG = "52000000-0000-4000-8000-000000000201", L1 = "52000000-0000-4000-8000-000000000301", L2 = "52000000-0000-4000-8000-000000000302"
  const D1 = "52000000-0000-4000-8000-000000000401", D2 = "52000000-0000-4000-8000-000000000402", D3 = "52000000-0000-4000-8000-000000000403", D4 = "52000000-0000-4000-8000-000000000404"
  const now = Date.now()
  const deal = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, agent_id: AG, contact_id: null, offer_id: null, contract_date: "2026-09-20", compliance_passed_at: "2026-10-20T00:00:00Z", stage: "CLOSING_PREP", status: "under_contract", property_address: `${id.slice(-3)} Policy Way`, close_date: noZ(now + 20 * 86_400_000).slice(0, 10), estimated_close_date: null, deleted_at: null, ...over })
  const svc = memSupabase({
    brokerages: [
      { id: B, name: "152H no-CDA brokerage", plan_tier: "brokerage", state: "FL", offers_cda: false, non_cda_payout_default: "check", cda_onboarding_at: "2026-07-01T00:00:00Z", commission_payout_timing: null },
      { id: M, name: "152H multi-office", plan_tier: "multi_location", state: "TX", offers_cda: false, non_cda_payout_default: "direct_deposit", cda_onboarding_at: "2026-07-01T00:00:00Z", commission_payout_timing: null },
      { id: X, name: "152H other brokerage", plan_tier: "brokerage", state: "GA", offers_cda: true, non_cda_payout_default: null, cda_onboarding_at: "2026-07-01T00:00:00Z", commission_payout_timing: null },
      { id: U, name: "152H unanswered", plan_tier: "brokerage", state: "AZ", offers_cda: null, non_cda_payout_default: null, cda_onboarding_at: null, commission_payout_timing: null },
    ],
    users: [
      { id: UB, brokerage_id: B, user_type: "broker", location_id: null, first_name: "Bea", last_name: "Broker", email: "bea@152h.test" },
      { id: UA, brokerage_id: B, user_type: "agent", location_id: null, first_name: "Al", last_name: "Agent", email: "al@152h.test" },
      { id: UTL, brokerage_id: B, user_type: "team_lead", location_id: null, first_name: "Tia", last_name: "Lead", email: "tia@152h.test" },
      { id: UCO, brokerage_id: B, user_type: "compliance_officer", location_id: null, first_name: "Cole", last_name: "Compliance", email: "cole@152h.test" },
      { id: UMO, brokerage_id: M, user_type: "broker_admin", location_id: L1, first_name: "Omar", last_name: "Office", email: "omar@152h.test" },
      { id: UML, brokerage_id: M, user_type: "broker", location_id: null, first_name: "Lena", last_name: "Leader", email: "lena@152h.test" },
      { id: UX, brokerage_id: X, user_type: "broker", location_id: null, first_name: "Xavi", last_name: "Other", email: "xavi@152h.test" },
    ],
    agents: [{ id: AG, user_id: UA, brokerage_id: B, first_name: "Al", last_name: "Agent", is_active: true }],
    teams: [
      { id: "52000000-0000-4000-8000-000000000501", brokerage_id: B, team_lead_id: UTL, location_id: null, deleted_at: null },
      { id: "52000000-0000-4000-8000-000000000502", brokerage_id: B, team_lead_id: UB, location_id: null, deleted_at: null },
    ],
    locations: [
      { id: L1, brokerage_id: M, status: "active", managing_broker_user_id: null },
      { id: L2, brokerage_id: M, status: "active", managing_broker_user_id: null },
    ],
    organization_members: [{ id: "52000000-0000-4000-8000-000000000601", brokerage_id: M, user_id: UML, scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null }],
    transactions: [
      deal(D1, { status: "closed", stage: "CLOSED", created_at: "2026-09-01T10:00:00.000000", actual_close_date: "2026-10-30" }),
      deal(D2, { created_at: "2026-10-01T10:00:00.000000" }),
    ],
    agent_commissions: [{ id: "52000000-0000-4000-8000-000000000701", transaction_id: D2, brokerage_id: B, status: "pending" }],
    transaction_milestones: [], closing_disclosure_agreement: [], tenant_policy_versions: [], agent_action_ledger: [], notifications: [], trid_timeline: [],
    policy_decisions: [], transaction_documents: [], documents: [],
  }, { stampCreatedAt: true, uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  H.__152H.svc = svc
  const as = (c: Caller | null) => { H.__152H.caller = c }
  const broker: Caller = { userId: UB, agentId: null, brokerageId: B, userType: "broker", isTenantPrincipal: false }
  const agent: Caller = { userId: UA, agentId: AG, brokerageId: B, userType: "agent", isTenantPrincipal: false }
  const rows = (t: string) => ((svc.tables[t] ?? []) as Array<Record<string, any>>) // eslint-disable-line @typescript-eslint/no-explicit-any
  const brk = (id: string) => rows("brokerages").find((r) => r.id === id) ?? {}
  const versions = (id: string) => rows("tenant_policy_versions").filter((r) => r.brokerage_id === id && r.policy_key === P.CDA_POLICY_KEY)
  const ledger = (action: string) => rows("agent_action_ledger").filter((r) => r.action === action)

  const setup = await quiet(() => import("../app/actions/brokerage-cda-setup"))
  const portal = await quiet(() => import("../app/actions/cda-portal"))
  const { canAdvanceStage } = await quiet(() => import("../lib/transactions/stage-progression"))
  const { finalizeCommissionAtClose } = await import("../lib/commission/reconcile-tracking")
  const { reapCdaDeadlines } = await import("../lib/transactions/cda-delivery-reaper")
  const gate = (tx: string) => quiet(() => canAdvanceStage(tx, "CLOSING_PREP", "CLOSED", B))
  // THE RULE THIS LANE OWNS at the closing gate: whether the delivered-CDA milestone is required. The settlement / CD hold and the closing
  // question (lane 152G, canAdvanceStage step 8b) are their own blockers, proved by test:settlement-reconciliation — so these checks read
  // the CDA milestone blocker, never `allowed` alone (an unrelated hold must not read as a CDA verdict either way).
  const needsCda = (r: { blockers: string[] }) => r.blockers.some((b) => /cda_delivered/.test(b))

  // 1 · the no-CDA policy: a valid close needs no CDA
  const preClose = await gate(D2)
  check("1 · NO-CDA POLICY: the gated close of an in-progress deal asks for no CDA milestone (no CDA row exists or is created)", !needsCda(preClose) && rows("closing_disclosure_agreement").length === 0, preClose.blockers.join("; "))

  // 2 · who may change it — refused seats change nothing
  const tries: Array<[string, Caller]> = [
    ["an AGENT", agent],
    ["a TEAM LEAD inside the brokerage", { userId: UTL, agentId: null, brokerageId: B, userType: "team_lead", isTenantPrincipal: false }],
    ["a COMPLIANCE OFFICER (reads the books, never keeps them)", { userId: UCO, agentId: null, brokerageId: B, userType: "compliance_officer", isTenantPrincipal: false }],
    ["an OFFICE ADMIN pinned to one office of a multi-office brokerage", { userId: UMO, agentId: null, brokerageId: M, userType: "broker_admin", isTenantPrincipal: false }],
  ]
  const refusedAll: string[] = []
  for (const [label, c] of tries) {
    as(c)
    const r = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: true, reason: "we now use CDAs at closing" }))
    if (!r.success) refusedAll.push(label)
  }
  check(`2 · AUTHORITY: ${refusedAll.length}/4 refused — agent, team lead, compliance officer and a single office's admin cannot change the brokerage-wide CDA policy; nothing was written`,
    refusedAll.length === 4 && brk(B).offers_cda === false && brk(M).offers_cda === false && versions(B).length === 0 && versions(M).length === 0 && ledger("finance.cda_policy.set").length === 0, refusedAll.join(", "))
  as({ userId: UML, agentId: null, brokerageId: M, userType: "broker", isTenantPrincipal: false })
  const mLead = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: true, reason: "the organization adopts CDAs" }))
  check("2 · CROSS-OFFICE: in the multi-office brokerage the ORGANIZATION'S leadership (tenant leadership grant) may change it", mLead.success === true && brk(M).offers_cda === true && versions(M).length === 1)
  as(broker)
  const noReason = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: true }))
  check("2 · REASON: flipping a declared no-CDA policy with no reason is refused in plain words (the in-progress deals are named) and writes nothing", !noReason.success && /why your CDA policy is changing/.test((noReason as { error: string }).error) && brk(B).offers_cda === false && versions(B).length === 0)

  // 3 · the opt-in — audited, versioned, effective now
  const optIn = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: true, reason: "our brokerage now disburses through title with a CDA" }))
  const v1 = versions(B)[0] as Record<string, any> | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
  const l1 = ledger("finance.cda_policy.set").find((r) => r.brokerage_id === B) as Record<string, any> | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
  check("3 · OPT IN through the EXISTING setting: brokerages.offers_cda true, the payout default cleared; cda_policy v1 records previous (no CDA, check) → value (CDA), the actor, the reason and the EFFECTIVE instant (= the row's cda_onboarding_at), scope brokerage",
    optIn.success === true && brk(B).offers_cda === true && brk(B).non_cda_payout_default === null && versions(B).length === 1 && v1?.previous?.offers_cda === false && v1?.previous?.non_cda_payout_default === "check" && v1?.value?.offers_cda === true && v1?.value?.effective_at === brk(B).cda_onboarding_at && v1?.value?.scope === "brokerage" && v1?.changed_by === UB && /disburses through title/.test(String(v1?.reason)),
    JSON.stringify({ optIn, v1 }))
  check("3 · LEDGERED (LAW 5): finance.cda_policy.set — the human actor, FINANCIAL, the policy it ran under, previous/value/effective_at and the count of in-progress deals that keep their policy; settled executed",
    !!l1 && l1.actor_user_id === UB && l1.risk_class === "FINANCIAL" && l1.status === "executed" && /^cda_policy@/.test(String(l1.policy_ref ?? l1.detail?.policy_ref ?? "")) && l1.detail?.effective_at === v1?.value?.effective_at && l1.detail?.open_deals_keep_prior_policy === 1, JSON.stringify(l1))
  check("3 · the tenant is told what happened to its deals (1 in progress keeps the policy it opened under)", optIn.success === true && (optIn as { dealsKeepingPriorPolicy?: number }).dealsKeepingPriorPolicy === 1)

  // 4 · after the opt-in: the next deal needs a CDA; the earlier ones keep their policy; nothing is invented
  const effAt = Date.parse(String(brk(B).cda_onboarding_at))
  rows("transactions").push(deal(D3, { created_at: noZ(effAt + 1) }))
  rows("agent_commissions").push({ id: "52000000-0000-4000-8000-000000000702", transaction_id: D3, brokerage_id: B, status: "pending" })
  const d2After = await gate(D2), d3Gate = await gate(D3)
  check("4 · NEXT APPLICABLE DEAL REQUIRES THE CDA: a deal opened after the opt-in cannot close without the delivered CDA milestone (named)", !d3Gate.allowed && needsCda(d3Gate), d3Gate.blockers.join("; "))
  check("4 · MID-DEAL CHANGE: the deal in progress (opened before) still closes without a CDA (no CDA milestone asked) — and no CDA form was created for it", !needsCda(d2After) && !rows("closing_disclosure_agreement").some((r) => r.transaction_id === D2), d2After.blockers.join("; "))
  const eff = await P.loadEffectiveCdaModes(svc, { brokerageId: B, transactionIds: [D1, D2, D3] })
  check("4 · THE EARLIER COMPLETED CLOSE STAYS COMPLETED: D1 is still closed, governed by the no-CDA policy it closed under, with no CDA row", eff.ok && eff.deals[D1]?.mode === "no_cda" && rows("transactions").find((r) => r.id === D1)?.status === "closed" && !rows("closing_disclosure_agreement").some((r) => r.transaction_id === D1))
  const fin2 = await quiet(() => finalizeCommissionAtClose(svc as never, { transactionId: D2, brokerageId: B, actorUserId: UB }))
  const fin3 = await quiet(() => finalizeCommissionAtClose(svc as never, { transactionId: D3, brokerageId: B, actorUserId: UB }))
  check("4 · MONEY AT CLOSE follows the deal's policy: D2 (no CDA) is authorized at its close; D3 (CDA) waits for the broker-signed CDA",
    fin2.offersCda === false && fin2.autoApproved === 1 && fin3.offersCda === true && fin3.autoApproved === 0 && rows("agent_commissions").find((r) => r.transaction_id === D3)?.status === "pending")
  const refusedSvc = memSupabase({ brokerages: [], agent_commissions: [{ id: "c-x", transaction_id: D2, brokerage_id: B, status: "pending" }] }, { refuse: { brokerages: "permission denied for table brokerages" } })
  const finRefused = await quiet(() => finalizeCommissionAtClose(refusedSvc as never, { transactionId: D2, brokerageId: B, actorUserId: UB }))
  check("4 · ADVERSE — FAIL CLOSED: an unreadable CDA setting approves NOTHING at close (it used to read as 'no CDA' and auto-approve)", finRefused.autoApproved === 0 && finRefused.offersCda === true && (refusedSvc.tables.agent_commissions as Array<{ status: string }>)[0].status === "pending")

  // 5 · the agent fills (never AI); the doors follow the deal's policy
  as(agent)
  const draftOld = await quiet(() => portal.draftOrUpdateCdaAction({ transactionId: D2, commissionBreakdown: { gross: 9000 }, grossCommission: 9000 }))
  const prefNew = await quiet(() => portal.recordNonCdaPayoutPreferenceAction({ transactionId: D3, method: "check" }))
  const draftNew = await quiet(() => portal.draftOrUpdateCdaAction({ transactionId: D3, commissionBreakdown: { gross: 12000 }, grossCommission: 12000, agentNet: 8400 }))
  const prefOld = await quiet(() => portal.recordNonCdaPayoutPreferenceAction({ transactionId: D2, method: "direct_deposit" }))
  const d3Row = rows("closing_disclosure_agreement").find((r) => r.transaction_id === D3)
  check("5 · THE AGENT FILLS the newly applicable deal's CDA (drafting, the agent's own figures); the no-CDA payout preference is refused there (the CDA authorizes the payout)",
    draftNew.success === true && d3Row?.status === "drafting" && d3Row?.gross_commission === 12000 && !prefNew.success && /^deal_uses_cda:/.test(String((prefNew as { error: string }).error)), JSON.stringify({ draftNew, prefNew }))
  check("5 · the in-progress no-CDA deal refuses a CDA draft (says why, in words) and records the payout preference instead (no fake CDA)",
    !draftOld.success && /^deal_closes_without_cda: This deal opened on/.test(String((draftOld as { error: string }).error)) && prefOld.success === true && rows("closing_disclosure_agreement").find((r) => r.transaction_id === D2)?.uses_cda === false, JSON.stringify({ draftOld, prefOld }))
  const portalSrc = code("app/actions/cda-portal.ts")
  check("5 · the submit and the compliance approval doors also ask the deal's policy before acting (fail closed when unreadable)",
    ["draftOrUpdateCdaAction", "submitCdaForApprovalAction", "approveCdaAction", "recordNonCdaPayoutPreferenceAction"].every((n) => /dealCdaMode\(/.test(fnBody(portalSrc, n)) && /CDA_MODE_UNREADABLE/.test(fnBody(portalSrc, n))))
  const MODEL = /from\s+["']@\/lib\/ai\/|anthropic|openai|generateText|generateObject|gatewayChat/i
  check("5 · AI NEVER FILLS: no model call in the policy, the setup doors or the CDA portal (CDA_FILL_RULE.aiFills false); POSITIVE CONTROL on a specimen",
    P.CDA_FILL_RULE.aiFills === false && ["lib/transactions/cda-closing-policy.ts", "app/actions/brokerage-cda-setup.ts", "app/actions/cda-portal.ts"].every((f) => !MODEL.test(code(f))) && MODEL.test(`await generateObject({ prompt: "fill the CDA" })`))

  // 6 · a finance admin switches ONE in-progress deal — ledgered, the agent told, nothing filled
  as(agent)
  const agentSwitch = await quiet(() => setup.switchDealCdaModeAction({ transactionId: D2, mode: "cda", reason: "the seller wants title to disburse" }))
  as({ userId: UX, agentId: null, brokerageId: X, userType: "broker", isTenantPrincipal: false })
  const foreignSwitch = await quiet(() => setup.switchDealCdaModeAction({ transactionId: D2, mode: "cda", reason: "the seller wants title to disburse" }))
  as(broker)
  const closedSwitch = await quiet(() => setup.switchDealCdaModeAction({ transactionId: D1, mode: "cda", reason: "retroactive CDA for the file" }))
  check("6 · ADVERSE: an agent cannot switch a deal; another brokerage's admin cannot reach it ('isn't in your brokerage'); a COMPLETED close is never given a CDA — no row created for D1",
    !agentSwitch.success && !foreignSwitch.success && /isn't in your brokerage/.test(String((foreignSwitch as { error: string }).error)) && !closedSwitch.success && (closedSwitch as { code?: string }).code === "deal_completed" && !rows("closing_disclosure_agreement").some((r) => r.transaction_id === D1))
  const sw2 = await quiet(() => setup.switchDealCdaModeAction({ transactionId: D2, mode: "cda", reason: "the seller wants title to disburse" }))
  const row2 = rows("closing_disclosure_agreement").find((r) => r.transaction_id === D2)
  const lsw = ledger("transaction.cda_mode.switch")
  check("6 · SWITCH: the deal's CDA row now says CDA with who / when / why / from-mode / policy version; ledgered transaction.cda_mode.switch (executed); the AGENT is told to fill it — no figure written",
    sw2.success === true && row2?.uses_cda === true && row2?.field_values?.cda_mode_switch?.by === UB && row2?.field_values?.cda_mode_switch?.from === "no_cda" && /seller wants title/.test(String(row2?.field_values?.cda_mode_switch?.reason)) && row2?.non_cda_payout_method === "direct_deposit" && row2?.gross_commission == null
      && lsw.length === 1 && lsw[0].status === "executed" && lsw[0].actor_user_id === UB && rows("notifications").some((n) => n.type === "cda_required" && n.user_id === UA && n.entity_id === D2), JSON.stringify({ sw2, fv: row2?.field_values }))
  const d2Switched = await gate(D2)
  check("6 · the switched deal now needs its delivered CDA at the closing gate", !d2Switched.allowed && needsCda(d2Switched))
  // Every writer of the CDA row's field_values MERGES (a wholesale replacement would erase the switch — and the statement review / e-sign evidence).
  const WHOLESALE = /field_values:\s*\{\s*(?!\.\.\.)[a-z_]+\s*:/
  const fvWriters = ["app/actions/cda-portal.ts", "app/actions/cda-template-field-actions.ts", "app/actions/brokerage-cda-setup.ts"]
  const wholesale = fvWriters.filter((f) => code(f).split("\n").some((l) => /\.update\(/.test(l) && WHOLESALE.test(l)))
  check("6 · NO WRITER ERASES THE SWITCH: every update of the CDA row's field_values spreads the prior values (cda-template-field-actions used to replace them); POSITIVE CONTROL on the old line",
    wholesale.length === 0 && WHOLESALE.test(`.update({ field_values: { resolved: valuesByKey, agent_inputs: ctx.agentInputs }, updated_at: now })`), wholesale.join(", "))

  // 7 · the new CDA path: approval → broker signature → title delivery → the gate opens
  const { canApproveCda, canBrokerSignCda, canSendCdaToTitle } = await import("../lib/transactions/cda-signing-policy")
  check("7 · SIGNATURE PATH (pure gates the doors call): compliance approves only a submitted, agent-signed CDA; only a broker signs an approved one; only an approved AND broker-signed CDA goes to title; delivery routes to the title portal or a verified email, never twice",
    canApproveCda({ status: "submitted", agentSignedOff: true, role: "compliance_officer" }).ok && !canApproveCda({ status: "drafting", agentSignedOff: true, role: "broker" }).ok
    && canBrokerSignCda({ status: "approved", brokerSigned: false, role: "broker" }).ok && !canSendCdaToTitle({ status: "approved", brokerSigned: false }).ok && canSendCdaToTitle({ status: "approved", brokerSigned: true }).ok
    && P.cdaDeliveryRoute({ titlePortalUserId: "t1" }).route === "portal" && P.cdaDeliveryRoute({ titleEmail: "close@title.test" }).route === "email" && P.deliveryIdempotency({ sentToTitleAt: "2026-11-01T00:00:00Z", recipient: "close@title.test" }).error === "already_delivered")
  rows("transaction_milestones").push({ id: "52000000-0000-4000-8000-000000000801", transaction_id: D3, brokerage_id: B, milestone_type: "cda_delivered", milestone_name: "CDA delivered to title", status: "completed", completed_at: new Date().toISOString(), target_date: null })
  const d3Delivered = await gate(D3)
  check("7 · TITLE DELIVERY CLOSES THE LOOP: once the signed CDA's delivery milestone is complete, the CDA requirement no longer holds the close", !needsCda(d3Delivered) && needsCda(d3Gate), d3Delivered.blockers.join("; "))

  // 8 · opt out — a signed CDA is never dropped; deals opened after close without one; holds stay
  as(broker)
  await new Promise((r) => setTimeout(r, 15)) // the opt-out is saved strictly after D3 opened (a deal never opens in the future)
  const optOut = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: false, nonCdaPayoutDefault: "direct_deposit", reason: "we are returning to paying agents after receipt" }))
  rows("transactions").push(deal(D4, { created_at: noZ(Date.parse(String(brk(B).cda_onboarding_at)) + 1) }))
  if (d3Row) Object.assign(d3Row, { status: "approved", broker_approved_at: new Date().toISOString() })
  const keepSigned = await quiet(() => setup.switchDealCdaModeAction({ transactionId: D3, mode: "no_cda", reason: "brokerage stopped using CDAs" }))
  const eff2 = await P.loadEffectiveCdaModes(svc, { brokerageId: B, transactionIds: [D2, D3, D4] })
  check("8 · OPT OUT: v2 recorded (CDA → no CDA); the deal opened under CDA keeps it (its approved CDA is never dropped — refused by name); the switched deal keeps its switch; a deal opened after the opt-out closes without one",
    optOut.success === true && versions(B).length === 2 && eff2.ok && eff2.deals[D3]?.mode === "cda" && !keepSigned.success && (keepSigned as { code?: string }).code === "cda_already_authorized" && eff2.deals[D2]?.basis === "deal_switch" && eff2.deals[D4]?.mode === "no_cda")
  H.__152H.closingGate = { allowed: false, blockers: ["Closing compliance: the settlement statement's seller credit ($10,000) does not match the executed addendum — correction requested from title"] }
  rows("trid_timeline").push({ id: "52000000-0000-4000-8000-000000000901", transaction_id: D4, closing_disclosure_delivered_date: null })
  const d4Gate = await gate(D4)
  H.__152H.closingGate = { allowed: true, blockers: [] }
  check("8 · DISABLING CDA BYPASSES NOTHING: the no-CDA deal is still held by the compliance discrepancy and by the TRID Closing Disclosure delivery rule",
    !d4Gate.allowed && d4Gate.blockers.some((b) => /seller credit/.test(b)) && d4Gate.blockers.some((b) => /TRID/.test(b)) && !needsCda(d4Gate), d4Gate.blockers.join("; "))
  const HOLD_FILES = ["lib/transactions/closing-compliance.ts", "app/actions/transaction-compliance.ts", "lib/compliance/trid-disclosure-clock.ts", "lib/transactions/final-compliance-check.ts"].filter((f) => existsSync(join(ROOT, f)))
  const CDA_READ = /resolveCdaMode\(|loadEffectiveCdaModes\(|\boffers_cda\b|\bcdaRequired\b/
  check(`8 · no compliance / settlement / Closing Disclosure gate reads the CDA mode (${HOLD_FILES.length} files), so no CDA setting can clear one; POSITIVE CONTROL on a specimen`,
    HOLD_FILES.length >= 3 && HOLD_FILES.every((f) => !CDA_READ.test(code(f))) && CDA_READ.test(`if (resolveCdaMode({ offersCda }).mode === "no_cda") return { allowed: true }`), HOLD_FILES.join(", "))

  // 9 · the deadline reaper follows each deal's policy
  const reaped = await quiet(() => reapCdaDeadlines(B, svc as never, { now: new Date() }))
  check("9 · REAPER after the opt-out: the brokerage is no-CDA today, yet the deal still governed by its CDA keeps its deadline sweep (not 'not applicable')", !reaped.notApplicable && reaped.scanned >= 1, JSON.stringify(reaped))
  const reapSvc = memSupabase({ brokerages: [{ id: U, offers_cda: false, non_cda_payout_default: "check", state: "AZ" }], closing_disclosure_agreement: [{ id: "cx", brokerage_id: U, transaction_id: "tx-u", agent_id: AG, status: "approved", uses_cda: true, sent_to_title_at: null }], transactions: [{ id: "tx-u", brokerage_id: U, created_at: "2026-01-01T00:00:00", status: "under_contract" }], tenant_policy_versions: [] })
  const notApp = await quiet(() => reapCdaDeadlines(U, reapSvc as never, { now: new Date() }))
  check("9 · CONTROL — a no-CDA brokerage with no recorded change stays NOT APPLICABLE (0 scanned) exactly as before", notApp.notApplicable && notApp.scanned === 0)

  // 10 · history failure rolls back; the second writer cannot flip a declared policy; registry + revert
  const rbSvc = memSupabase({
    brokerages: [{ id: B, plan_tier: "brokerage", offers_cda: false, non_cda_payout_default: "check", cda_onboarding_at: "2026-07-01T00:00:00Z", commission_payout_timing: null }],
    users: [{ id: UB, brokerage_id: B, user_type: "broker", location_id: null }], teams: [], locations: [], organization_members: [], transactions: [], agent_action_ledger: [],
  }, { refuse: { tenant_policy_versions: "permission denied for table tenant_policy_versions" }, uuidIds: true, stampCreatedAt: true })
  H.__152H.svc = rbSvc
  const rb = await quiet(() => setup.setBrokerageCdaSettingAction({ offersCda: true, reason: "we now use CDAs at closing" }))
  H.__152H.svc = svc
  const rbRow = (rbSvc.tables.brokerages as Array<Record<string, unknown>>)[0]
  check("10 · ADVERSE — the effective date cannot be recorded → the change is ROLLED BACK (offers_cda false, the old timestamp) and the tenant is told plainly; the ledger row says failed / rolled_back",
    !rb.success && /put back as it was/.test(String((rb as { error: string }).error)) && rbRow.offers_cda === false && rbRow.cda_onboarding_at === "2026-07-01T00:00:00Z" && ((rbSvc.tables.agent_action_ledger ?? []) as Array<Record<string, unknown>>).some((r) => r.status === "failed" && r.outcome === "rolled_back"), JSON.stringify(rb))
  const { applySnapshotPayload } = await quiet(() => import("../lib/platform/config-snapshots"))
  const snapSvc = memSupabase({ brokerages: [{ id: B, offers_cda: false, about_text: "old" }, { id: U, offers_cda: null, about_text: "old" }] })
  const sB = await quiet(() => applySnapshotPayload({ site: { offers_cda: true, about_text: "new" } } as never, B, UB, snapSvc as never, { mode: "replace" }))
  const sU = await quiet(() => applySnapshotPayload({ site: { offers_cda: true, about_text: "new" } } as never, U, UB, snapSvc as never, { mode: "replace" }))
  const sb = snapSvc.tables.brokerages as Array<Record<string, unknown>>
  check("10 · SECOND WRITER CLOSED: a config snapshot never flips a DECLARED CDA policy (preserved, the site fields still applied); an UNANSWERED one may still be seeded",
    sb[0].offers_cda === false && sb[0].about_text === "new" && (sB.preserved ?? []).includes("brokerages.offers_cda") && sb[1].offers_cda === true, JSON.stringify({ sB, sU }))
  const tp = await import("../lib/kernel/tenant-policy")
  const revert = code("app/actions/admin/tenant-policy.ts")
  check("10 · cda_policy is a registered COLUMN policy key; the revert door re-applies a version only through setBrokerageCdaSettingAction (its gate, reason rule and ledger) and refuses to un-answer the setting",
    tp.parsePolicyKey(P.CDA_POLICY_KEY)?.kind === "column" && /parsed\.key === "cda_policy"/.test(revert) && /setBrokerageCdaSettingAction\(/.test(revert) && /unanswered setting/.test(revert))
  const orch = code("lib/transactions/closing-orchestration.ts"), reaperSrc = code("lib/transactions/cda-delivery-reaper.ts"), page = code("app/dashboard/transactions/[id]/cda/page.tsx")
  check("10 · EVERY MILESTONE READER asks the deal's governing policy: the closing gate, the close-time finalizer, the closing-orchestration CDA detector, the deadline reaper, the CDA page and the CDA doors",
    [code("lib/transactions/stage-progression.ts"), code("lib/commission/reconcile-tracking.ts"), orch, reaperSrc, page, portalSrc].every((s) => /loadEffectiveCdaModes\(/.test(s)) && /cdaRequiredFor\(t\.brokerage_id, t\.id\)/.test(orch))

  // 11 · the settings door reads back what a finance admin needs; an agent sees the setting only
  as(broker)
  const view = await quiet(() => setup.getBrokerageCdaSettingAction())
  as(agent)
  const agentView = await quiet(() => setup.getBrokerageCdaSettingAction())
  const pol = view.success && view.policy && view.policy.readable ? view.policy : null
  check("11 · READBACK: the finance admin sees the current policy, its history (who, when, why) and the in-progress deals on a different treatment with the reason in words; an agent sees the setting only (no deals, no history)",
    !!pol && pol.current === "no_cda" && pol.history.length === 2 && pol.history[0].changedBy === "Bea Broker" && /returning to paying agents/.test(String(pol.history[0].reason)) && pol.deals.some((d) => d.transactionId === D3 && d.mode === "cda") && pol.deals.some((d) => d.transactionId === D2 && d.basis === "deal_switch")
      && agentView.success && agentView.policy === null && agentView.canEdit === false, JSON.stringify(view).slice(0, 400))

  // 12 · integrator requests from lane 152G: a "reviewed" statement never stands against a held reconciliation; an uploaded statement is READ
  as(broker)
  if (d3Row) d3Row.field_values = { ...(d3Row.field_values ?? {}), preliminary_statement: { status: "pending_review", version: 1, document_id: "td-1", received_at: new Date().toISOString(), items: [], history: [] } }
  rows("policy_decisions").push({ id: "52000000-0000-4000-8000-000000000b01", brokerage_id: B, transaction_id: D3, target_type: "settlement_reconciliation", decision: "amber", evidence_json: { state: "awaiting_revised_document" }, created_at: new Date(Date.now() - 1000).toISOString() })
  const heldReview = await quiet(() => portal.confirmPreliminaryCdReviewAction({ cdaId: String(d3Row?.id) }))
  rows("policy_decisions").push({ id: "52000000-0000-4000-8000-000000000b02", brokerage_id: B, transaction_id: D3, target_type: "settlement_reconciliation", decision: "green", evidence_json: { state: "ready" }, created_at: new Date().toISOString() })
  const greenReview = await quiet(() => portal.confirmPreliminaryCdReviewAction({ cdaId: String(d3Row?.id) }))
  const refusedRecon = memSupabase({ closing_disclosure_agreement: [{ ...(d3Row ?? {}) }], transactions: [{ id: D3, brokerage_id: B, coordinator_id: null }] }, { refuse: { policy_decisions: "permission denied for table policy_decisions" } })
  H.__152H.svc = refusedRecon
  const unreadable = await quiet(() => portal.confirmPreliminaryCdReviewAction({ cdaId: String(d3Row?.id) }))
  H.__152H.svc = svc
  check("12 · RECONCILIATION HOLD: marking the preliminary statement 'reviewed' is refused while the latest settlement snapshot is not green (by its state), allowed once the newest is green; a refused read refuses (never 'no snapshot')",
    !heldReview.success && (heldReview as { error: string }).error === "settlement_reconciliation_awaiting_revised_document" && greenReview.success === true && !unreadable.success && /^settlement_reconciliation_unreadable:/.test(String((unreadable as { error: string }).error)), JSON.stringify({ heldReview, greenReview, unreadable }))
  const scansBefore = H.__152H.scans.length
  const upload = await quiet(() => portal.uploadPreliminaryCdAction({ transactionId: D4, fileName: "Preliminary ALTA v1.pdf", fileUrl: "https://files.example.test/prelim-v1.pdf", uploadedByRole: "tc" }))
  const td = rows("transaction_documents").find((r) => r.transaction_id === D4 && r.doc_type === "preliminary_closing_disclosure")
  const bridged = rows("documents").filter((r) => r.metadata?.transaction_document_id === td?.id)
  const finalTd = { id: "52000000-0000-4000-8000-000000000c01", transaction_id: D3, brokerage_id: B, doc_type: "final_closing_disclosure", doc_label: "Final CD.pdf", storage_url: "https://files.example.test/final-cd.pdf", status: "uploaded" }
  rows("transaction_documents").push(finalTd)
  const fin1 = await quiet(() => portal.uploadFinalCdAction({ cdaId: String(d3Row?.id), documentId: finalTd.id }))
  const fin2b = await quiet(() => portal.uploadFinalCdAction({ cdaId: String(d3Row?.id), documentId: finalTd.id }))
  const finalBridged = rows("documents").filter((r) => r.metadata?.transaction_document_id === finalTd.id)
  check("12 · UPLOADED IS READ: a preliminary statement filed on the transaction_documents rail is also put on the documents rail (linked to its source row, on the deal) and handed to the universal scanner; the final CD likewise — and a retry files it ONCE",
    upload.success !== undefined && !!td && bridged.length === 1 && bridged[0].transaction_id === D4 && bridged[0].storage_url === td?.storage_url && fin1.success === true && fin2b.success === true && finalBridged.length === 1 && H.__152H.scans.length - scansBefore === 2,
    JSON.stringify({ upload, bridged: bridged.length, finalBridged: finalBridged.length, scans: H.__152H.scans.length - scansBefore }))
  as(null)
}

main().catch((e) => { console.error(e); process.exit(1) })
