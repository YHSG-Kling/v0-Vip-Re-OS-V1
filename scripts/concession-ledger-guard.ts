#!/usr/bin/env tsx
/**
 * scripts/concession-ledger-guard.ts   (npm run test:concession-ledger)
 * ─────────────────────────────────────────────────────────────────────────
 * Wave 144, lane 144D — THE ONE FINANCE RULE, ENCODED (owner rulings 4–8 and the finance table, 2026-10-25):
 *   Seller concession   → the seller's net proceeds / settlement — NEVER the commission
 *   Agent concession    → THAT agent's gross commission (+ the broker-approval policy, with evidence)
 *   Referral fee        → the authorized referring agent, inside the brokerage or an OUTSIDE Partner — one deal, one payment
 *   Brokerage royalty   → its own brokerage fee under the agreement (its own row, its own CDA line)
 *   Residual            → the downline survivor, never a referral
 *   Tax proration       → the settlement, under the deal's own convention — never one state's rule for all
 *   Payout timing       → a brokerage SETTING: at closing per the CDA, or after the brokerage receives the commission
 *   AI explains, the deterministic engine calculates — no second calculator, no model-computed money in this domain.
 *
 * Proved through the REAL engine / kernel commands over the in-memory client; every absence claim has a POSITIVE CONTROL and
 * every code-token scan reads STRIPPED source (CLAUDE.md §2). No migration is pinned by number.
 *
 * BLIND SPOTS (published beside the number): in-memory client (no RLS, triggers, CHECKs); m850's columns are seeded as applied
 * (pre-apply the concession writer refuses by name — asserted); notifications are counted as rows, not delivered; the
 * outside-partner payee is proved to the CDA authorization's payee line, not to a title company's disbursement; the AI-money
 * scan covers this lane's domain only — two money-adjusting AI paths OUTSIDE it are reported (not asserted) below.
 */
import "./canaries/_harness"
import { canaryClient, setSvc, uuid } from "./canaries/_harness"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
const cents = (n: unknown) => Math.round(Number(n) * 100)
type Rows = Record<string, Array<Record<string, any>>>
type Svc = ReturnType<typeof canaryClient>
const rows = (svc: Svc, t: string) => ((svc.tables as Rows)[t] ?? [])
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }

interface Deal { B: string; A: string; U: string; T: string; C: string; ADMIN: string }
const newDeal = (): Deal => ({ B: uuid(), A: uuid(), U: uuid(), T: uuid(), C: uuid(), ADMIN: uuid() })
function seed(d: Deal, o: { brokerage?: Record<string, unknown>; terms?: Record<string, unknown>; txn?: Record<string, unknown>; extra?: Rows } = {}): Rows {
  const terms = { split_percent: 70, is_active: true, ...(o.terms ?? {}) }
  return {
    brokerages: [{ id: d.B, name: "Rule Brokerage", revenue_share_enabled: false, created_at: "2018-01-01T00:00:00Z", ...(o.brokerage ?? {}) }],
    users: [{ id: d.U, brokerage_id: d.B, user_type: "agent", email: "agent@rule.test" }, { id: d.ADMIN, brokerage_id: d.B, user_type: "broker_owner", email: "broker@rule.test" }],
    agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null, created_at: "2019-09-01T00:00:00Z", anniversary_date: "2019-09-01" }],
    transactions: [{ id: d.T, brokerage_id: d.B, agent_id: d.A, purchase_price: 400_000, commission_percentage: 3, close_date: "2026-08-15", status: "closed", contact_id: d.C, ...(o.txn ?? {}) }],
    commission_structures: [{ id: uuid(), brokerage_id: d.B, is_default: true, is_active: true, base_percentage: 3 }],
    agent_commission_profiles: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_date: "2026-01-01", ...terms }],
    agent_commission_profile_versions: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: "2025-01-01", terms, recorded_at: "2025-01-01T00:00:00Z" }],
    agent_cap_tracking: [], commission_adjustments: [], referrals: [], referral_partners: [], contract_signatures: [],
    ...(o.extra ?? {}),
  }
}
async function engine(svc: Svc, d: Deal, mode: "final" | "preview" = "final") {
  setSvc(svc)
  const { calculateCommission } = await import("../lib/commission/engine")
  return quiet(() => calculateCommission({ transactionId: d.T, brokerageId: d.B, calculationMode: mode, triggeredBy: null }))
}
const agentActor = (d: Deal) => ({ userId: d.U, agentId: d.A, brokerageId: d.B, userType: "agent", isTenantPrincipal: false })
const brokerActor = (d: Deal) => ({ userId: d.ADMIN, agentId: null, brokerageId: d.B, userType: "broker_owner", isTenantPrincipal: false })

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel))
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}

async function main() {
  const conc = await import("../lib/commission/agent-concession")

  // ══ A · SELLER concession: the seller's net, never the commission ══════════════════════════════
  console.log("[A · a SELLER concession comes out of the seller's net — never the commission]")
  const a = newDeal()
  const sa = canaryClient(seed(a, { txn: { closing_cost_contribution: 5_000 } }) as never)
  const ra = await engine(sa, a)
  check("a $5,000 seller credit to the buyer on the deal: the commission is priced on the FULL price — gross $12,000, agent $8,400, brokerage $3,600",
    ra.success && cents(ra.gross_commission) === 1_200_000 && cents(ra.net_to_agent) === 840_000 && cents(ra.net_to_brokerage) === 360_000, JSON.stringify(ra).slice(0, 200))
  const { calcNetToSeller } = await import("../lib/offers/offer-math")
  const { estimateSellerClosingCosts } = await import("../lib/offers/seller-closing-costs")
  check("…and it reduces the SELLER's net: $400,000 − $24,000 commission (6 %) − $5,000 credit = $371,000 (the commission term is unchanged by the credit)",
    calcNetToSeller({ offer_price: 400_000, commission_rate: 0.06, closing_cost_contribution: 5_000 }) === 371_000 && calcNetToSeller({ offer_price: 400_000, commission_rate: 0.06, closing_cost_contribution: 0 }) - 371_000 === 5_000)
  const est = estimateSellerClosingCosts({ salePrice: 400_000, state: "TX", commission: { kind: "rate", rateDecimal: 0.06, sourceNote: "listing agreement" }, buyerClosingCredit: 5_000 })
  check("the seller net sheet shows the credit as its OWN seller cost line; the commission line stays $24,000", est.lines.find((l) => l.label === "Buyer closing-cost credit")?.high === 5_000 && est.lines.find((l) => l.label === "Real estate commission")?.high === 24_000)
  const commissionFiles = walk("lib/commission")
  const SELLER_CREDIT_TOKEN = /closing_cost_contribution|seller_concession|sellerConcession/
  const readers = commissionFiles.filter((f) => SELLER_CREDIT_TOKEN.test(code(f)))
  check("no module of the commission engine (lib/commission/**, stripped) reads a seller concession — POSITIVE CONTROL: the finder sees one in a specimen",
    readers.length === 0 && SELLER_CREDIT_TOKEN.test(`.select("closing_cost_contribution")`), readers.join(", "))
  check("a seller concession is no longer a SOURCE OF COMMISSION FUNDS: the distribution type admits brokerage | agent | buyer only",
    /source_of_funds:\s*'brokerage'\s*\|\s*'agent'\s*\|\s*'buyer'\s*\n/.test(code("lib/commission/types.ts")) && !/'seller_concession'/.test(code("lib/commission/types.ts")))

  // ══ B · AGENT concession: request → broker decision → applied off THAT agent's gross ══════════
  console.log("\n[B · an AGENT concession: request, broker approval, applied off that agent's gross commission]")
  const b = newDeal()
  const sb = canaryClient(seed(b) as never)
  setSvc(sb)
  const req = await quiet(() => conc.requestAgentConcession(sb as never, agentActor(b), { transactionId: b.T, beneficiary: "buyer", beneficiaryName: "Pat Buyer", amount: 1_000, valueType: "flat", reason: "credit toward the buyer's closing costs" }))
  const row = rows(sb, "commission_adjustments")[0]
  check("UNDECLARED policy is fail-closed: the request is recorded as 'requested' — THAT agent, the beneficiary, the amount, the reason, the settlement treatment, off the GROSS",
    req.ok && req.requiresApproval && row?.approval_status === "requested" && row.concession_agent_id === b.A && row.recipient_type === "buyer" && Number(row.value) === 1_000 && row.applies_to === "gross" && row.direction === "credit" && row.settlement_treatment === "closing_statement_credit" && /closing costs/.test(String(row.notes)), JSON.stringify(req).slice(0, 200))
  check("the broker is told (a notification per finance admin) and the request is ledgered (LAW 5)", rows(sb, "notifications").some((n) => n.type === "agent_concession_requested") && rows(sb, "agent_action_ledger").some((l) => l.action === "finance.agent_concession.requested"))
  const held = await engine(sb, b)
  check("BLOCK UNAUTHORIZED COMMITMENT: a FINAL calculation refuses by name while the concession awaits the broker — nothing posted", held.success === false && /awaiting broker approval/.test(held.error ?? "") && rows(sb, "commission_distributions").length === 0, held.error)
  const prev = await engine(sb, b, "preview")
  check("a PREVIEW still runs and shows the gross WITHOUT the unapproved credit ($12,000)", prev.success && cents(prev.gross_commission) === 1_200_000)
  const notAdmin = await conc.decideAgentConcession(sb as never, agentActor(b), { adjustmentId: row.id, decision: "approved" })
  check("only a finance admin decides (an agent approving their own concession is refused)", !notAdmin.ok && /finance admins/.test((notAdmin as { error: string }).error))
  const ok = await quiet(() => conc.decideAgentConcession(sb as never, brokerActor(b), { adjustmentId: row.id, decision: "approved", note: "approved for the inspection repair" }))
  const again = await quiet(() => conc.decideAgentConcession(sb as never, brokerActor(b), { adjustmentId: row.id, decision: "denied", note: "changed my mind" }))
  check("the broker APPROVES (who + when kept on the row, ledgered); a second decision is refused (compare-and-swap on 'requested')",
    ok.ok && row.approval_status === "approved" && row.approval_decided_by === b.ADMIN && !!row.approval_decided_at && !again.ok && rows(sb, "agent_action_ledger").some((l) => l.action === "finance.agent_concession.approved"))
  const applied = await engine(sb, b)
  check("the approved $1,000 credit comes off THAT agent's GROSS before the split: gross $11,000, agent $7,700, brokerage $3,300",
    applied.success && cents(applied.gross_commission) === 1_100_000 && cents(applied.net_to_agent) === 770_000 && cents(applied.net_to_brokerage) === 330_000, JSON.stringify(applied).slice(0, 220))
  const bd = rows(sb, "commission_calculations")[0]?.breakdown_json as Record<string, any> | undefined
  const ev = bd?.agent_concessions?.[0]
  check("the calculation records the concession: kind agent_concession, applied, agent, beneficiary, reason, approval, settlement treatment, ledger effect, −$1,000",
    ev?.kind === "agent_concession" && ev.verdict === "applied" && ev.concession_agent_id === b.A && ev.beneficiary === "buyer" && ev.beneficiary_name === "Pat Buyer" && ev.approval_status === "approved" && ev.settlement_treatment === "closing_statement_credit" && ev.ledger_effect === "reduces_gross_before_split" && ev.signed_amount === -1_000, JSON.stringify(ev))
  const after = await quiet(() => conc.requestAgentConcession(sb as never, agentActor(b), { transactionId: b.T, beneficiary: "buyer", amount: 50, valueType: "flat", reason: "one more after posting" }))
  check("once the commission is POSTED a new concession is refused (it is a correction by a finance admin, never a silent re-price)", !after.ok && /commission_posted/.test((after as { error: string }).error))

  const bd2 = newDeal()
  const sbd = canaryClient(seed(bd2) as never)
  const r2 = await quiet(() => conc.requestAgentConcession(sbd as never, agentActor(bd2), { transactionId: bd2.T, beneficiary: "seller", amount: 0.5, valueType: "percent", reason: "repeat client courtesy" }))
  const den = await quiet(() => conc.decideAgentConcession(sbd as never, brokerActor(bd2), { adjustmentId: (r2 as { record: { id: string } }).record.id, decision: "denied", note: "policy: no rebates on this listing" }))
  const denEngine = await engine(sbd, bd2)
  check("a DENIED concession is never applied (deactivated; the final posts the full $12,000)", den.ok && rows(sbd, "commission_adjustments")[0].is_active === false && denEngine.success && cents(denEngine.gross_commission) === 1_200_000)
  const noReason = await conc.decideAgentConcession(sbd as never, brokerActor(bd2), { adjustmentId: (r2 as { record: { id: string } }).record.id, decision: "denied" })
  check("a denial without a stated reason is refused", !noReason.ok)

  const bn = newDeal()
  const sbn = canaryClient(seed(bn, { brokerage: { agent_concession_approval: "no_approval_required" } }) as never)
  const rn = await quiet(() => conc.requestAgentConcession(sbn as never, agentActor(bn), { transactionId: bn.T, beneficiary: "buyer", amount: 600, valueType: "flat", reason: "home warranty credit" }))
  const nEngine = await engine(sbn, bn)
  check("where the brokerage requires NO approval the concession is recorded 'not_required' and applies at once (gross $11,400)", rn.ok && !rn.requiresApproval && rows(sbn, "commission_adjustments")[0].approval_status === "not_required" && nEngine.success && cents(nEngine.gross_commission) === 1_140_000)

  const bo = newDeal()
  const OTHER = uuid()
  const so = canaryClient(seed(bo, { extra: { commission_adjustments: [{ id: uuid(), brokerage_id: bo.B, transaction_id: bo.T, applies_to: "gross", direction: "credit", value_type: "flat", value: 700, is_active: true, recipient_type: "buyer", concession_agent_id: OTHER, approval_status: "approved" }] } }) as never)
  const oEngine = await engine(so, bo)
  check("a concession owed by ANOTHER agent is never charged to this agent's commission: the final refuses by name", oEngine.success === false && /not the producing agent/.test(oEngine.error ?? ""), oEngine.error)
  const notOnDeal = await conc.requestAgentConcession(so as never, { ...agentActor(bo), agentId: OTHER }, { transactionId: bo.T, beneficiary: "buyer", amount: 100, valueType: "flat", reason: "not my deal at all" })
  check("an agent who is not on the deal cannot record a concession on it", !notOnDeal.ok && /not_on_deal/.test((notOnDeal as { error: string }).error))
  const fin = newDeal()
  const sfin = canaryClient(seed(fin, { txn: { commission_finalized_at: "2026-08-16T00:00:00Z" } }) as never)
  const finR = await conc.requestAgentConcession(sfin as never, agentActor(fin), { transactionId: fin.T, beneficiary: "buyer", amount: 100, valueType: "flat", reason: "too late now" })
  check("a FINALIZED commission (CDA signed / final CD) refuses a new concession", !finR.ok && /commission_final/.test((finR as { error: string }).error))
  const bad = await conc.requestAgentConcession(sfin as never, agentActor(fin), { transactionId: fin.T, beneficiary: "lender", amount: 100, valueType: "flat", reason: "wrong party" })
  check("a concession is to the buyer or the seller only, with a stated reason and a positive amount", !bad.ok && /beneficiary_invalid/.test((bad as { error: string }).error))
  const wd = newDeal()
  const swd = canaryClient(seed(wd) as never)
  const wr = await quiet(() => conc.requestAgentConcession(swd as never, agentActor(wd), { transactionId: wd.T, beneficiary: "buyer", amount: 300, valueType: "flat", reason: "offer sweetener" }))
  const wdn = await conc.withdrawAgentConcession(swd as never, agentActor(wd), { adjustmentId: (wr as { record: { id: string } }).record.id })
  check("the requesting agent can WITHDRAW a pending request; it then never applies", wdn.ok && rows(swd, "commission_adjustments")[0].approval_status === "withdrawn" && rows(swd, "commission_adjustments")[0].is_active === false)
  const pre850 = newDeal()
  const sp = canaryClient(seed(pre850) as never, { missingColumns: { commission_adjustments: ["approval_status", "concession_agent_id"] } })
  const pr = await quiet(() => conc.requestAgentConcession(sp as never, agentActor(pre850), { transactionId: pre850.T, beneficiary: "buyer", amount: 100, valueType: "flat", reason: "before the migration" }))
  check("PRE-APPLY HONESTY: before m850 the writer refuses BY NAME (never a half-recorded concession)", !pr.ok && /m850/.test((pr as { error: string }).error), JSON.stringify(pr))
  const legacy = newDeal()
  const sl = canaryClient(seed(legacy, { extra: { commission_adjustments: [{ id: uuid(), brokerage_id: legacy.B, transaction_id: legacy.T, applies_to: "gross", direction: "credit", value_type: "flat", value: 500, is_active: true, recipient_type: "seller", adjustment_type: "discount", notes: "Military — listing agreement" }] } }) as never)
  const lr = await engine(sl, legacy)
  const lev = (rows(sl, "commission_calculations")[0]?.breakdown_json as any)?.agent_concessions?.[0]
  check("the LISTING-AGREEMENT concession (a row written before m850) still applies as the producing agent's, settled as a reduced commission rate",
    lr.success && cents(lr.gross_commission) === 1_150_000 && lev?.concession_agent_id === legacy.A && lev?.settlement_treatment === "reduced_commission_rate" && lev?.approval_status === "not_required")

  // ══ C · agent-/brokerage-side adjustments conserve ══════════════════════════════════════════════
  console.log("\n[C · stage 05/06 adjustments conserve (direction is load-bearing)]")
  const c = newDeal()
  const sc = canaryClient(seed(c, { extra: { commission_adjustments: [{ id: uuid(), brokerage_id: c.B, transaction_id: c.T, applies_to: "agent", direction: "credit", value_type: "flat", value: 400, is_active: true, recipient_type: "charity", notes: "agent's charity pledge" }] } }) as never)
  const rc = await engine(sc, c)
  check("an agent-side CREDIT leaves the agent's portion ($8,400 → $8,000) to its recipient and the ledger FOOTS ($12,000)", rc.success && cents(rc.net_to_agent) === 800_000 && rows(sc, "commission_distributions").reduce((s, r) => s + cents(r.calculated_amount), 0) === 1_200_000, JSON.stringify(rc).slice(0, 200))
  check("POSITIVE CONTROL: the HEAD math (portion += magnitude AND a +magnitude row) overshoots the gross by twice the row — why any row failed validation", 840_000 + 40_000 + 40_000 + 360_000 !== 1_200_000)
  const cs = newDeal()
  const scs = canaryClient(seed(cs, { extra: { commission_adjustments: [{ id: uuid(), brokerage_id: cs.B, transaction_id: cs.T, applies_to: "brokerage", direction: "surcharge", value_type: "flat", value: 100, is_active: true, recipient_type: "brokerage" }] } }) as never)
  const rcs = await engine(scs, cs)
  check("a brokerage-side SURCHARGE has no source of funds inside the deal and is refused by name (never conjured)", rcs.success === false && /no source of funds/.test(rcs.error ?? ""))

  // ══ D · referral to an OUTSIDE partner ═══════════════════════════════════════════════════════════
  console.log("\n[D · a referral to an OUTSIDE agent / brokerage (the PARTNER bucket)]")
  const d = newDeal()
  const P = uuid(), REF = uuid()
  const partner = { id: P, brokerage_id: d.B, agent_id: d.A, partner_name: "Riley Outside", partner_type: "real_estate_agent", company_name: "Outside Realty LLC", active: true, commission_split_percentage: null, referral_fee_flat: null }
  const sd = canaryClient(seed(d, { extra: { referral_partners: [partner], referrals: [{ id: REF, brokerage_id: d.B, agent_id: d.A, partner_id: P, referring_agent_id: null, referral_fee_pct: 25, status: "received", referred_contact_id: d.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }] } }) as never)
  const rd = await engine(sd, d)
  const refRow = rows(sd, "commission_distributions").filter((r) => r.distribution_type === "referral")
  check("the outside referral is a DEDUCTION off the top: $3,000 (25 %) payable to the partner (referral_partner_id, no agents row), the rest splits 70/30 — agent $6,300, brokerage $2,700",
    rd.success && refRow.length === 1 && refRow[0].referral_partner_id === P && !refRow[0].agent_id && cents(refRow[0].calculated_amount) === 300_000 && cents(rd.net_to_agent) === 630_000 && cents(rd.net_to_brokerage) === 270_000, JSON.stringify(rd).slice(0, 220))
  check("it FOOTS ($12,000) and the referral is LINKED to this one deal", rows(sd, "commission_distributions").reduce((s, r) => s + cents(r.calculated_amount), 0) === 1_200_000 && rows(sd, "referrals")[0].transaction_id === d.T)
  const T2 = uuid()
  sd.tables.transactions.push({ id: T2, brokerage_id: d.B, agent_id: d.A, purchase_price: 400_000, commission_percentage: 3, close_date: "2026-09-20", status: "closed", contact_id: d.C })
  setSvc(sd)
  const { calculateCommission } = await import("../lib/commission/engine")
  const second = await quiet(() => calculateCommission({ transactionId: T2, brokerageId: d.B, calculationMode: "final", triggeredBy: null }))
  check("NO DOUBLE PAYMENT: a second closing for the same contact pays no second fee", second.success && rows(sd, "commission_distributions").filter((r) => r.distribution_type === "referral").length === 1)
  const { pickReferralForDeal } = await import("../lib/commission/referral-payout")
  const base = { id: "r", agent_id: "A", partner_id: "P", referring_agent_id: null, referral_fee_pct: null, status: "received", transaction_id: null, created_at: "2026-07-01T00:00:00Z" }
  const pm = (p: Record<string, unknown>) => new Map([["P", { id: "P", partner_type: "real_estate_agent", partner_name: "Riley", company_name: "Outside Realty", active: true, ...p }]])
  const lender = pickReferralForDeal([base], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({ partner_type: "mortgage_broker", commission_split_percentage: 25 }) })
  check("a LENDER (any non-real-estate partner) is NEVER paid a referral fee — RESPA §8 — skipped with a finding", lender.referral === null && lender.findings.some((f) => /RESPA/.test(f)))
  const standing = pickReferralForDeal([base], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({ commission_split_percentage: 20 }) })
  const flat = pickReferralForDeal([base], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({ referral_fee_flat: 750 }) })
  check("the fee terms in order: the referral's own percent, else the partner's standing percent (20 %), else its flat fee ($750) — each said", standing.feePct === 20 && standing.payee?.kind === "partner" && flat.feePct === null && flat.feeFlatCents === 75_000)
  const none = pickReferralForDeal([base], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({}) })
  const ended = pickReferralForDeal([{ ...base, referral_fee_pct: 25 }], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({ agreement_end_date: "2026-06-30" }) })
  check("no agreed fee anywhere → no fee (never fabricated); an ENDED partner agreement → no fee", none.referral === null && ended.referral === null && ended.findings.some((f) => /ended/.test(f)))
  const noCo = pickReferralForDeal([{ ...base, referral_fee_pct: 25 }], { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15", partners: pm({ company_name: "" }) })
  check("an owed fee with NO brokerage of record is a HOLD (broker-to-broker payee not authorizable yet)", !!noCo.hold && /brokerage of record/.test(noCo.hold))
  const dh = newDeal()
  const sdh = canaryClient(seed(dh, { extra: { referral_partners: [{ ...partner, id: P, brokerage_id: dh.B, company_name: null }], referrals: [{ id: uuid(), brokerage_id: dh.B, agent_id: dh.A, partner_id: P, referral_fee_pct: 25, status: "received", referred_contact_id: dh.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }] } }) as never)
  const rdh = await engine(sdh, dh)
  const rdhp = await engine(sdh, dh, "preview")
  check("…the HOLD refuses a FINAL by name (nothing posted); a PREVIEW still runs", rdh.success === false && /brokerage of record/.test(rdh.error ?? "") && rows(sdh, "commission_distributions").length === 0 && rdhp.success)
  const inside = pickReferralForDeal([{ ...base, partner_id: null, referring_agent_id: "R", referral_fee_pct: 10 }], { transactionId: "T", producingAgentId: "A" })
  check("POSITIVE CONTROL: an INSIDE referral still pays the referring agent (payee kind agent)", inside.payee?.kind === "agent" && inside.feePct === 10)
  const { cdaPayeesFromDistributions } = await import("../lib/transactions/cda-payees")
  const payees = cdaPayeesFromDistributions([
    { distribution_type: "referral", calculated_amount: 3000, status: "pending", agent_id: null, referral_partner_id: "P1" },
    { distribution_type: "referral", calculated_amount: 1000, status: "pending", agent_id: "A1" },
  ], new Map([["A1", "Inside Agent"]]), new Map([["P1", "Outside Realty LLC (Riley Outside)"]]))
  check("the CDA authorization names the OUTSIDE payee by its brokerage (and agent) — kept apart from an inside agent", payees.referralPayouts.length === 2 && payees.referralPayouts.some((p) => p.payee === "Outside Realty LLC (Riley Outside)" && p.amount === 3000) && payees.referralPayouts.some((p) => p.payee === "Inside Agent"))
  check("sendCdaToTitleAction reads the partner payee names tenant-pinned and REFUSES to send an authorization with an unnamed outside payee",
    /from\("referral_partners"\)[\s\S]{0,200}\.eq\("brokerage_id", cda\.brokerage_id\)/.test(code("app/actions/cda-portal.ts")) && /cda_partner_payee_unnamed/.test(code("app/actions/cda-portal.ts")))

  // ══ E · residual ≠ referral ══════════════════════════════════════════════════════════════════════
  console.log("\n[E · a residual is the downline's revenue share — never a referral]")
  const s03b = code("lib/commission/waterfall/03b-referral-deduction.ts"), s09 = code("lib/commission/waterfall/09-revenue-share.ts")
  check("the referral stage never reads the downline graph (agent_relationships) and the revenue-share stage never reads referrals — two survivors, two vocabularies ('referral' vs 'residual'); POSITIVE CONTROL: the finder sees the table names where they belong",
    !/agent_relationships/.test(s03b) && !/from\(\s*['"]referrals['"]/.test(s09) && /from\(\s*['"]referrals['"]/.test(s03b) && /distribution_type:\s*['"]residual['"]/.test(code("lib/commission/revenue-share-model.ts") + s09) && /distribution_type:\s*['"]referral['"]/.test(s03b) && /from\(\s*['"]agent_relationships['"]/.test(s09))

  // ══ F · royalty on the CDA ═══════════════════════════════════════════════════════════════════════
  console.log("\n[F · the ROYALTY is its own CDA line]")
  const { cdaWaterfallContext, CDA_WATERFALL_KEYS } = await import("../lib/transactions/cda-template-fields")
  const ctx = cdaWaterfallContext({ gross_commission: 12_000, distributions: [{ distribution_type: "fee", calculated_amount: 100 }, { distribution_type: "royalty", calculated_amount: 600 }] })
  check("cdaWaterfallContext: royalty $600 on its own key, fees $100 without it; the key is in the one catalog", ctx.royalty === 600 && ctx.fees === 100 && "royalty" in CDA_WATERFALL_KEYS)
  const classifierSrc = code("lib/transactions/cda-field-classifier.ts")
  check("the field classifier maps a 'Royalty' field to the royalty line BEFORE the generic fee rule (source order)", classifierSrc.indexOf('source_key: "royalty"') > 0 && classifierSrc.indexOf('source_key: "royalty"') < classifierSrc.indexOf('source_key: "fees"'))

  // ══ G · the payout gate is a brokerage setting ══════════════════════════════════════════════════
  console.log("\n[G · payout timing: at closing per the CDA, or after the brokerage receives the commission]")
  const { resolvePayoutTiming } = await import("../lib/transactions/cda-closing-policy")
  check("resolvePayoutTiming: undeclared → after receipt (fail closed); at-closing needs a CDA brokerage (else the receipt gate, with a finding)",
    resolvePayoutTiming({ offersCda: true, payoutTiming: null }).timing === "after_brokerage_receipt" && resolvePayoutTiming({ offersCda: true, payoutTiming: "at_closing_per_cda" }).timing === "at_closing_per_cda"
    && (() => { const v = resolvePayoutTiming({ offersCda: false, payoutTiming: "at_closing_per_cda" }); return v.timing === "after_brokerage_receipt" && !!v.finding })())
  const fk = await import("../lib/kernel/financial")
  const payoutSvc = (o: { brokerage: Record<string, unknown>; cda?: Record<string, unknown> | null; txStatus?: string }) => {
    const B = uuid(), A = uuid(), ADM = uuid(), T = uuid(), CM = uuid()
    const s = canaryClient({
      brokerages: [{ id: B, name: "Gate", ...o.brokerage }],
      users: [{ id: ADM, email: "f@gate.test", user_type: "broker_owner", brokerage_id: B }],
      agents: [{ id: A, user_id: uuid(), brokerage_id: B, is_active: true }],
      transactions: [{ id: T, brokerage_id: B, agent_id: A, status: o.txStatus ?? "closed", stage: "CLOSED", close_date: "2026-08-15" }],
      agent_commissions: [{ id: CM, brokerage_id: B, agent_id: A, transaction_id: T, status: "approved", net_to_agent: 8_400, deposit_received_at: null, payment_initiated_at: null }],
      closing_disclosure_agreement: o.cda ? [{ id: uuid(), transaction_id: T, brokerage_id: B, ...o.cda }] : [],
    } as never)
    setSvc(s)
    return { s, B, ADM, CM, ctx: { userId: ADM, agentId: null, brokerageId: B, userType: "broker", platformRole: null, isTenantPrincipal: true } as never }
  }
  const g1 = payoutSvc({ brokerage: { offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, cda: { status: "approved", broker_approved_at: "2026-08-14T00:00:00Z", sent_to_title_at: "2026-08-14T01:00:00Z" } })
  const p1 = await quiet(() => fk.initiateCommissionPayout({ ctx: g1.ctx, commissionId: g1.CM, brokerageId: g1.B, method: "direct_deposit" }))
  check("AT CLOSING: with the CDA broker-signed AND delivered and the closing verified, the payout is released WITHOUT the brokerage's receipt (title disburses per the CDA)", p1.success, JSON.stringify(p1))
  const g2 = payoutSvc({ brokerage: { offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, cda: { status: "approved", broker_approved_at: "2026-08-14T00:00:00Z", sent_to_title_at: null } })
  const p2 = await quiet(() => fk.markCommissionPaid({ ctx: g2.ctx, commissionId: g2.CM, brokerageId: g2.B, method: "check" }))
  check("…a CDA not yet delivered to title refuses by name", !p2.success && /cda_not_delivered/.test(p2.error ?? ""), p2.error)
  const g3 = payoutSvc({ brokerage: { offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, cda: { status: "submitted", broker_approved_at: null, sent_to_title_at: null } })
  const p3 = await quiet(() => fk.markCommissionPaid({ ctx: g3.ctx, commissionId: g3.CM, brokerageId: g3.B, method: "check", advanceReason: "the agent needs it today" }))
  check("…an unsigned CDA refuses by name — and there is NO advance in closing-time mode", !p3.success && /cda_not_authorized/.test(p3.error ?? ""), p3.error)
  const g4 = payoutSvc({ brokerage: { offers_cda: true, commission_payout_timing: "at_closing_per_cda" }, cda: { status: "approved", broker_approved_at: "2026-08-14T00:00:00Z", sent_to_title_at: "2026-08-14T01:00:00Z" }, txStatus: "clear_to_close" })
  const tx4 = rows(g4.s, "transactions")[0]; tx4.stage = "CLOSING_PREP"
  const p4 = await quiet(() => fk.markCommissionPaid({ ctx: g4.ctx, commissionId: g4.CM, brokerageId: g4.B, method: "check" }))
  check("…before the VERIFIED closing it refuses by name", !p4.success && /closing_not_verified/.test(p4.error ?? ""), p4.error)
  const g5 = payoutSvc({ brokerage: { offers_cda: true, commission_payout_timing: "after_brokerage_receipt" }, cda: { status: "approved", broker_approved_at: "2026-08-14T00:00:00Z", sent_to_title_at: "2026-08-14T01:00:00Z" } })
  const p5 = await quiet(() => fk.markCommissionPaid({ ctx: g5.ctx, commissionId: g5.CM, brokerageId: g5.B, method: "check" }))
  check("AFTER RECEIPT (even a CDA brokerage that chose it): no recorded deposit → refused by name (funds_not_received)", !p5.success && /funds_not_received/.test(p5.error ?? ""))
  const g6 = payoutSvc({ brokerage: { offers_cda: null } })
  const p6 = await quiet(() => fk.initiateCommissionPayout({ ctx: g6.ctx, commissionId: g6.CM, brokerageId: g6.B, method: "check" }))
  check("POSITIVE CONTROL: an UNDECLARED brokerage runs the receipt gate exactly as before (refused without the deposit)", !p6.success && /funds_not_received/.test(p6.error ?? ""))
  const g7 = payoutSvc({ brokerage: { offers_cda: false, commission_payout_timing: "at_closing_per_cda" } })
  const p7 = await quiet(() => fk.markCommissionPaid({ ctx: g7.ctx, commissionId: g7.CM, brokerageId: g7.B, method: "check" }))
  check("a closing-time setting on a NO-CDA brokerage is not honoured (nothing authorizes it): the receipt gate applies", !p7.success && /funds_not_received/.test(p7.error ?? ""))

  // ══ H · tax proration ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[H · tax proration: the deal's own convention, never one state's rule for all]")
  const prorate = (tp: Record<string, unknown> | null, state: string | null = "TX") => estimateSellerClosingCosts({ salePrice: 400_000, state, commission: { kind: "rate", rateDecimal: 0.06, sourceNote: "listing agreement" }, taxProration: tp as never }).lines.find((l) => l.label === "Property-tax proration")!
  const arrears = prorate({ annualTax: 7_300, periodStart: "2026-01-01", timing: "arrears", closeDate: "2026-07-01", closingDayOwner: "buyer", dayBasis: "actual_365", source: "title's proration instruction (file 1234)" })
  check("ARREARS: the seller credits the buyer for Jan 1 – Jun 30 = 181 of 365 days of $7,300 = $3,620.00 — a deal-fact number, its source named", !arrears.pending && arrears.high === 3_620 && arrears.source === "deal_fact" && /181 of 365/.test(String(arrears.note)), JSON.stringify(arrears))
  const advance = prorate({ annualTax: 7_300, periodStart: "2026-07-01", timing: "advance", closeDate: "2026-10-01", closingDayOwner: "seller", dayBasis: "actual_365", source: "county fiscal year per escrow" })
  check("ADVANCE (a July fiscal year the seller prepaid): the buyer reimburses the seller 272 of 365 days = $5,440.00 — a NEGATIVE seller cost (it raises the net)", !advance.pending && advance.high === -5_440 && /272 of 365/.test(String(advance.note)), JSON.stringify(advance))
  const b360 = prorate({ annualTax: 3_600, periodStart: "2026-01-01", timing: "arrears", closeDate: "2026-03-16", closingDayOwner: "buyer", dayBasis: "banker_360", source: "attorney's closing instruction" })
  check("a 30/360 day count: Jan 1 – Mar 15 = 75 of 360 days of $3,600 = $750.00", b360.high === 750, JSON.stringify(b360))
  const sameDealOtherRule = prorate({ annualTax: 7_300, periodStart: "2026-01-01", timing: "advance", closeDate: "2026-07-01", closingDayOwner: "buyer", dayBasis: "actual_365", source: "another jurisdiction" })
  check("POSITIVE CONTROL: the SAME deal under another convention gives another answer (arrears $3,620 vs advance −$3,680) — the rule is the input, not the code", sameDealOtherRule.high === -3_680 && sameDealOtherRule.high !== arrears.high)
  const stateOnly = prorate(null, "TX")
  const partial = prorate({ annualTax: 7_300, closeDate: "2026-07-01" })
  check("a STATE alone never computes it (no convention is defaulted): the line stays pending; a partial convention names what is missing",
    stateOnly.pending === true && partial.pending === true && /arrears or in advance/.test(String(partial.note)) && /day-count/.test(String(partial.note)) && /source of the convention/.test(String(partial.note)))
  const outside = prorate({ annualTax: 7_300, periodStart: "2026-01-01", timing: "arrears", closeDate: "2027-02-01", closingDayOwner: "buyer", dayBasis: "actual_365", source: "x" })
  check("a closing date outside the stated tax period is refused (pending), never extrapolated", outside.pending === true)
  const { mapSellerAccuracyLines } = await import("../lib/offers/closing-cost-accuracy")
  const graded = mapSellerAccuracyLines(estimateSellerClosingCosts({ salePrice: 400_000, state: "TX", commission: null, taxProration: { annualTax: 7_300, periodStart: "2026-01-01", timing: "arrears", closeDate: "2026-07-01", closingDayOwner: "buyer", dayBasis: "actual_365", source: "title" } }).lines,
    { commission: null, mortgagePayoff: null, titleEscrow: null, transferTax: null, netToSeller: null, taxProration: 3_650 })
  const pl = graded.find((l) => l.key === "seller_tax_proration")
  check("the computed proration is GRADED against the final statement's figure ($3,650 vs $3,620: Δ +$30, outside the exact band)", !!pl && pl.actual === 3_650 && pl.deltaFromMid === 30 && pl.withinBand === false)

  // ══ I · one calculator ══════════════════════════════════════════════════════════════════════════
  console.log("\n[I · ONE calculator — the kernel recalculation runs the engine, never its own math]")
  const txk = code("lib/kernel/transactions.ts")
  const recalc = txk.slice(txk.indexOf("export async function recalculateCommissionStateCommand"), txk.indexOf("export async function emitClientFriendlyUpdateCommand"))
  const INVENTED = /split_percent\s*\?\?\s*80|\?\?\s*\(profile as any\)\?\.split_percent|royalty_percent/
  check("recalculateCommissionStateCommand calls the engine (calculateCommission, preview) and carries no invented split / gross-rate fallback or its own royalty math (POSITIVE CONTROL: the finder sees the retired shape)",
    /calculateCommission\(\{/.test(recalc) && /calculationMode:\s*"preview"/.test(recalc) && !INVENTED.test(recalc) && INVENTED.test(`const splitPercent = (profile as any)?.split_percent ?? 80`) && !/from\("commission_calculations"\)/.test(recalc))
  const k = newDeal()
  const COORD_U = uuid()
  const sk = canaryClient(seed(k, { extra: { transaction_commissions: [] } }) as never)
  ;(sk.tables as Rows).users.push({ id: COORD_U, brokerage_id: k.B, user_type: "tc", email: "tc@rule.test" })
  setSvc(sk)
  const { recalculateCommissionStateCommand } = await import("../lib/kernel/transactions")
  const kr = await quiet(() => recalculateCommissionStateCommand({ transactionId: k.T, brokerageId: k.B, agentId: COORD_U }))
  const stamp = rows(sk, "transaction_commissions").find((r) => r.recipient_type === "agent")
  check("the stamp carries the ENGINE's numbers ($8,400 to the agent) for the DEAL's agent — even when a coordinator ran it — and writes no second commission_calculations row",
    kr.success && (kr as any).data?.agentNet === 8_400 && stamp?.recipient_id === k.A && Number(stamp?.calculated_amount) === 8_400 && rows(sk, "commission_calculations").length === 0 && rows(sk, "commission_distributions").length === 0, JSON.stringify(kr).slice(0, 200))

  // ══ J · no model-computed money in this domain ══════════════════════════════════════════════════
  console.log("\n[J · AI explains; the deterministic engine calculates]")
  const DOMAIN = [...walk("lib/commission"), ...walk("lib/referrals"), "lib/kernel/financial.ts", "lib/transactions/closing-compliance-core.ts", "lib/transactions/cda-template-fields.ts", "lib/transactions/cda-payees.ts", "lib/transactions/cda-closing-policy.ts", "lib/offers/net-sheet-calc.ts", "lib/offers/seller-closing-costs.ts", "lib/offers/buyer-closing-costs.ts", "lib/offers/closing-cost-accuracy.ts", "lib/offers/commission-disclosure.ts", "app/actions/cda-portal.ts", ...walk("app/actions/commission-policy")]
  const MODEL_CALL = /\b(generateText|generateObject|streamText|generateTextRouted|generateObjectRouted|bookedGenerateObject|bookedGenerateText)\s*\(/
  const offenders = DOMAIN.filter((f) => MODEL_CALL.test(code(f)))
  check(`no file in this lane's money domain (${DOMAIN.length} files, stripped) calls a model — POSITIVE CONTROL: the finder sees a model call in a specimen`, offenders.length === 0 && MODEL_CALL.test(`const { text } = await generateTextRouted({`), offenders.join(", "))
  const outsideAi = ["lib/offers/regional-closing-costs.ts", "app/actions/buyer-closing-costs.ts", "app/actions/financials.ts"].filter((f) => { try { return /applyAiRefinements|generateTextRouted|generateObjectRouted/.test(code(f)) } catch { return false } })
  console.log(`  · REPORTED (outside this lane's domain, not asserted): model-adjusted money paths still live in ${outsideAi.join(", ")} — see the lane notes, Outside-lane`)

  // ══ K · the closing orchestration honours the CDA setting ═══════════════════════════════════════
  console.log("\n[K · the closing-orchestration cron raises a CDA alarm ONLY for a CDA brokerage]")
  const soonClose = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  const orch = (offersCda: boolean | null) => {
    const B = uuid(), T = uuid()
    return canaryClient({
      brokerages: [{ id: B, offers_cda: offersCda }],
      transactions: [{ id: T, brokerage_id: B, agent_id: uuid(), contract_date: "2026-09-01", close_date: soonClose, status: "under_contract", deal_type: "seller", property_address: "1 Rule St" }],
      transaction_inspections: [], transaction_lenders: [], transaction_title_escrow: [], transaction_vendor_services: [], transaction_pending_actions: [],
      transaction_milestones: [{ transaction_id: T, milestone_type: "cda_delivered", milestone_name: "cda_delivered", status: "pending", completed_at: null, target_date: soonClose }],
    } as never)
  }
  const { runClosingOrchestration } = await import("../lib/transactions/closing-orchestration")
  const oNo = orch(false); setSvc(oNo); await quiet(() => runClosingOrchestration())
  const oYes = orch(true); setSvc(oYes); await quiet(() => runClosingOrchestration())
  const cdaAlarm = (s: Svc) => rows(s, "transaction_pending_actions").filter((r) => r.action_type === "cda_missing").length
  check("a NO-CDA brokerage gets no 'CDA not delivered' alarm 3 days from close; a CDA brokerage does (POSITIVE CONTROL)", cdaAlarm(oNo) === 0 && cdaAlarm(oYes) === 1, `no-cda ${cdaAlarm(oNo)}, cda ${cdaAlarm(oYes)}`)

  // ══ L · the migration ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[L · the migration]")
  const dir = join(ROOT, "supabase/migrations")
  const mig = readdirSync(dir).filter((f) => /^m\d+-.*\.sql$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).find((s) => /commission_adjustments_approval_status_check/.test(s) && /referral_partner_id/.test(s)) ?? ""
  check("one migration states its apply status on line 1 (WRITTEN, NOT APPLIED or APPLIED LIVE) and adds the concession, cap-cycle, partner-payee and payout-policy columns with their CHECKs",
    /^-- (WRITTEN, NOT APPLIED|── APPLIED LIVE)/.test(mig) && /commission_adjustments_approval_status_check\s*\n\s*CHECK \(approval_status IN/.test(mig) && /cap_anniversary_date/.test(mig) && /cap_eligible_contributions/.test(mig) && /brokerages_commission_payout_timing_check/.test(mig) && /commission_distributions_partner_payee_check/.test(mig))
  check("it NARROWS commission_distributions.source_of_funds to brokerage | agent | buyer, refusing (not rewriting) if a seller_concession row exists", /source_of_funds IN \('brokerage', 'agent', 'buyer'\)/.test(mig) && /RAISE EXCEPTION 'm850: commission_distributions rows carry source_of_funds=seller_concession/.test(mig))

  console.log("\nBLIND SPOTS: in-memory client (no RLS / triggers / CHECKs); m850 columns seeded as applied; notifications counted, not delivered;")
  console.log("  the partner payee is proved to the CDA payee line, not a title disbursement; the AI-money scan is this lane's domain only.")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
