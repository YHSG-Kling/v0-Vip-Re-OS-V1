#!/usr/bin/env tsx
/**
 * scripts/agreement-governance-guard.ts   (npm run test:agreement-governance — tsx --conditions=react-server)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Wave 145, lane 145C — THE AGREEMENT DICTATES THE MONEY (owner rulings 3–10, 2026-10-27; contracts C6 and C7):
 *   A  agents.start_date comes ONLY from the executed brokerage agreement's effective date (C6) — never account creation,
 *      a team join or a seat stamp; the cap anniversary may be the agreement's own.
 *   B  executed agreements are effective-dated and amendment-versioned; the engine prices the agreement in force on the
 *      deal's date, holds a FINAL when the executed paper contradicts the stored terms, and never prices the brokerage
 *      default over an executed client agreement that states the rate.
 *   C  commission onboarding: the signed agreement PROPOSES structured settings, a human VERIFIES (AI never applies them).
 *   D  buyer / seller agreement fees: payer, receiver, establishing agreement, payable at closing, inside the commission or
 *      not, policy permission, amendments — never interchangeable with agent fees, never double-counted.
 *   E  a referral payout needs an EXECUTED referral agreement on record (inside agent or outside partner).
 *   F  a post-transaction executed addendum reaches its financial obligations: the transaction row, compliance re-review,
 *      the closing attestation, settlement reconciliation, the CDA correction, the deal team — on the versioned record (C7).
 *   G  closing verification: five layers + the agent's attestation; a conversational answer never overwrites anything.
 *   H  an agent concession promised on an OFFER (m861) is anchored there and follows the contract onto the transaction.
 *   I  the four migrations (m858–m861): lane stamp OR applied stamp on line 1, additive, the rules in SQL.
 *   J  no model call in the new money/agreement files; one agency-contract vocabulary.
 *
 * Proved through the REAL writers / engine over the in-memory client (scripts/in-memory-supabase.ts via the canary harness);
 * every absence claim has a POSITIVE CONTROL; every code-token scan reads STRIPPED source (CLAUDE.md §2).
 *
 * BLIND SPOTS (published beside the number): in-memory client — no RLS, no triggers, no CHECKs, no numeric types: the m858–m861
 * triggers / CHECKs are asserted from the migration TEXT, not executed; the new columns are seeded as if applied; notifications
 * are counted rows, not deliveries; runClosingCompliance is stubbed in F (its own proof is test:closing-compliance); the UI
 * cards are asserted through their actions, not rendered.
 */
import "./canaries/_harness"
import { canaryClient, setSvc, uuid } from "./canaries/_harness"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const cents = (n: unknown) => Math.round(Number(n) * 100)
type Rows = Record<string, Array<Record<string, any>>>
type Svc = ReturnType<typeof canaryClient>
const rows = (svc: Svc, t: string) => ((svc.tables as Rows)[t] ?? [])
const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }

interface Deal { B: string; A: string; U: string; T: string; C: string; ADMIN: string }
const newDeal = (): Deal => ({ B: uuid(), A: uuid(), U: uuid(), T: uuid(), C: uuid(), ADMIN: uuid() })
function seed(d: Deal, o: { terms?: Record<string, unknown>; txn?: Record<string, unknown>; extra?: Rows } = {}): Rows {
  const terms = { split_percent: 70, is_active: true, ...(o.terms ?? {}) }
  return {
    brokerages: [{ id: d.B, name: "Governance Brokerage", revenue_share_enabled: false, created_at: "2018-01-01T00:00:00Z" }],
    users: [{ id: d.U, brokerage_id: d.B, user_type: "agent", email: "agent@gov.test" }, { id: d.ADMIN, brokerage_id: d.B, user_type: "broker_owner", email: "broker@gov.test" }],
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
const broker = (d: Deal) => ({ userId: d.ADMIN, agentId: null, brokerageId: d.B, userType: "broker_owner", isTenantPrincipal: false })
const agentActor = (d: Deal) => ({ userId: d.U, agentId: d.A, brokerageId: d.B, userType: "agent", isTenantPrincipal: false })
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e)
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel))
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}
const sig = (o: Record<string, unknown>) => ({ id: uuid(), esign_status: "fully_signed", provider_name: "none", created_at: "2025-01-01T00:00:00Z", ...o })

async function main() {
  const AA = await import("../lib/agreements/agent-agreements")
  const ON = await import("../lib/commission/agreement-onboarding")
  const CF = await import("../lib/commission/client-agreement-fees")
  const RP = await import("../lib/commission/referral-payout")
  const RA = await import("../lib/agreements/referral-agreements")
  const CV = await import("../lib/commission/closing-verification")
  const CVC = await import("../lib/commission/closing-verification-core")
  const CONC = await import("../lib/commission/agent-concession")
  const { resolveAnniversaryWindow } = await import("../lib/commission/cap-resolver")

  // ══ A · the start date comes from the executed brokerage agreement only (C6) ═══════════════════════════════════
  console.log("\n[A · agents.start_date — from the executed agent agreement's effective date only]")
  {
    const A = "agent-1"
    const ic = { id: "ic", agent_id: A, brokerage_id: "B", contract_type: "independent_contractor", esign_status: "fully_signed", fully_signed_at: "2024-03-02T00:00:00Z", effective_date: "2024-03-01" }
    const ca = { id: "ca", agent_id: A, brokerage_id: "B", contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2023-01-05T00:00:00Z", effective_date: "2023-01-01" }
    const team = { id: "tm", agent_id: A, brokerage_id: "B", contract_type: "team_agreement", esign_status: "fully_signed", fully_signed_at: "2022-01-05T00:00:00Z", effective_date: "2022-01-01" }
    const amend = { id: "am", agent_id: A, brokerage_id: "B", contract_type: "independent_contractor", esign_status: "fully_signed", fully_signed_at: "2023-12-01T00:00:00Z", effective_date: "2023-06-01", amends_contract_signature_id: "ic" }
    const p = AA.proposeAgentStartDate(A, [team, ca, ic, amend])
    check("the PROPOSAL is the executed brokerage-join agreement's effective date (independent contractor first) — never the team join (earlier) nor an amendment",
      p.proposal?.contractSignatureId === "ic" && p.proposal.startDate === "2024-03-01")
    check("…a brokerage on ONE combined paper: the commission agreement proposes when no independent-contractor agreement exists", AA.proposeAgentStartDate(A, [team, ca]).proposal?.contractSignatureId === "ca")
    const undated = AA.proposeAgentStartDate(A, [{ ...ic, effective_date: null }])
    check("an executed agreement WITHOUT a recorded effective date proposes nothing and names what to record (never the signing timestamp, never created_at)", undated.proposal === null && undated.awaitingEffectiveDate.includes("ic"))
    check("POSITIVE CONTROL: only a team agreement on file → no start date at all (a team join is not a start date)", AA.proposeAgentStartDate(A, [team]).proposal === null)
    const agent = { id: A, brokerage_id: "B" }
    const v = (row: Record<string, unknown> | null) => AA.validateStartDateSource(agent, row as never)
    check("validateStartDateSource refuses by name: another agent, another brokerage, a team agreement, an unsigned agreement, no effective date — and admits the executed IC agreement",
      (v({ ...ic, agent_id: "x" }) as any).code === "other_agent" && (v({ ...ic, brokerage_id: "C" }) as any).code === "other_brokerage" && (v(team) as any).code === "not_brokerage_level"
      && (v({ ...ic, esign_status: "sent" }) as any).code === "not_executed" && (v({ ...ic, effective_date: null }) as any).code === "no_effective_date" && v(ic).ok && (v(ic) as any).startDate === "2024-03-01")

    const d = newDeal()
    const IC = uuid()
    const svc = canaryClient(seed(d, { extra: { contract_signatures: [sig({ id: IC, agent_id: d.A, brokerage_id: d.B, contract_type: "independent_contractor", fully_signed_at: "2024-03-02T00:00:00Z", effective_date: "2024-03-01" })] } }) as never)
    setSvc(svc)
    const byAgent = await quiet(() => AA.setAgentStartDateFromAgreement(svc as never, agentActor(d), { agentId: d.A, contractSignatureId: IC }))
    const set = await quiet(() => AA.setAgentStartDateFromAgreement(svc as never, broker(d), { agentId: d.A, contractSignatureId: IC }))
    const ag = rows(svc, "agents")[0]
    check("the ONLY writer: an agent cannot set their own start date; a finance admin sets it FROM the agreement (start_date + start_date_source)", !byAgent.ok && set.ok && ag.start_date === "2024-03-01" && ag.start_date_source === IC)
    check("…and it leaves LAW-5 evidence (finance.agent_agreement.start_date_set)", rows(svc, "agent_action_ledger").some((l) => l.action === "finance.agent_agreement.start_date_set"))
    const writers = walk("lib").concat(walk("app")).filter((f) => /start_date_source\s*:/.test(code(f)))
    check("no other module writes agents.start_date_source (stripped scan) — POSITIVE CONTROL: the finder sees the one writer", writers.length === 1 && writers[0] === "lib/agreements/agent-agreements.ts", writers.join(", "))
    check("the governance view offers each executed agreement as a start-date source by the WRITER's own rule (validateStartDateSource), never a second copy of it",
      /validateStartDateSource\(/.test(code("app/actions/commission-policy/agreements.ts")) && /startDateIfSource[\s\S]{0,400}setAgentStartDateAction/.test(code("app/dashboard/financials/agreements/agreement-governance-panel.tsx")))

    const win = (o: Record<string, unknown>) => resolveAnniversaryWindow({ basis: "agent_start_date", today: "2026-08-15", agentCreatedAt: "2019-01-10T00:00:00Z", agentAnniversaryDate: "2019-02-01", ...o } as never)
    const ws = win({ agentStartDate: "2024-03-01" }), wseat = win({}), wagr = win({ agentStartDate: "2024-03-01", agreementAnniversaryDate: "2025-07-01" })
    check("the cap cycle anchors on the agreement start date ABOVE the seat stamps; the agreement's own cap anniversary still outranks it; without a start date the seat stamp is used and SAID (anchorSource)",
      ws.ok && ws.window.start === "2026-03-01" && ws.window.anchorSource === "agreement_start_date"
      && wagr.ok && wagr.window.start === "2026-07-01" && wagr.window.anchorSource === "agreement_cap_anniversary"
      && wseat.ok && wseat.window.start === "2026-02-01" && wseat.window.anchorSource === "seat_anniversary_date")
  }

  // ══ B · effective-dated, amendment-versioned agreements; the engine prices the agreement in force ═══════════════
  console.log("\n[B · the executed agreement in force by its EFFECTIVE date; contradictions hold a final; no default over a signed rate]")
  {
    const rowsB = [
      { id: "base", agent_id: "A", brokerage_id: "B", contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2026-01-20T00:00:00Z", effective_date: "2026-01-01" },
      { id: "amd", agent_id: "A", brokerage_id: "B", contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2026-05-10T00:00:00Z", effective_date: "2026-07-01", amends_contract_signature_id: "base" },
      { id: "draft", agent_id: "A", brokerage_id: "B", contract_type: "commission_agreement", esign_status: "sent", fully_signed_at: null, effective_date: null },
    ]
    check("the agreement in force is chosen by its EFFECTIVE date: an amendment signed in May governs only from July; a June deal stays on the base; a draft never governs",
      AA.agreementInForce(rowsB, ["commission_agreement"], "2026-06-15")?.row.id === "base" && AA.agreementInForce(rowsB, ["commission_agreement"], "2026-07-02")?.row.id === "amd")
    const fb = AA.agreementInForce([{ ...rowsB[0], effective_date: null }], ["commission_agreement"], "2026-06-15")
    check("an executed agreement with no recorded effective date stands on its EXECUTION date — and says so (a finding names what to record)", fb?.basis === "execution_date" && fb.findings.length === 1)
    check("the amendment history is a chain, original first (nothing edited)", AA.amendmentChain(rowsB, "base").map((r) => r.id).join(">") === "base>amd")

    const d = newDeal()
    const BASE = uuid()
    const svc = canaryClient(seed(d, { extra: { contract_signatures: [sig({ id: BASE, agent_id: d.A, brokerage_id: d.B, contract_type: "commission_agreement", fully_signed_at: "2026-01-20T00:00:00Z", effective_date: null, field_values: { split_percent: "70" } })] } }) as never)
    setSvc(svc)
    const r1 = await quiet(() => AA.recordAgreementEffectiveDate(svc as never, broker(d), { contractSignatureId: BASE, effectiveDate: "2026-01-01" }))
    const r2 = await quiet(() => AA.recordAgreementEffectiveDate(svc as never, broker(d), { contractSignatureId: BASE, effectiveDate: "2026-02-01" }))
    const rA = await quiet(() => AA.recordAgreementEffectiveDate(svc as never, agentActor(d), { contractSignatureId: BASE, effectiveDate: "2026-01-01" }))
    check("the effective date is recorded ONCE by a finance admin; a second recording (a change) is refused — an executed change is an amendment; an agent cannot record it",
      r1.ok && !r2.ok && /already_recorded/.test((r2 as any).error) && !rA.ok && rows(svc, "contract_signatures")[0].effective_date === "2026-01-01")
    const am = await quiet(() => AA.recordAgentAgreementAmendment(svc as never, broker(d), { amendsContractSignatureId: BASE, executedOn: "2026-05-10", effectiveDate: "2026-07-01", documentUrl: "https://docs.example/amend.pdf", fieldValues: { split_percent: "80" } }))
    const cs = rows(svc, "contract_signatures")
    check("an EXECUTED AMENDMENT is a new row of the same family pointing at the original (the original untouched); the agent is told", am.ok && cs.length === 2 && cs[1].amends_contract_signature_id === BASE && cs[1].effective_date === "2026-07-01" && cs[0].effective_date === "2026-01-01" && rows(svc, "notifications").some((n) => n.type === "agent_agreement_changed"))
    const noDoc = await quiet(() => AA.recordAgentAgreementAmendment(svc as never, broker(d), { amendsContractSignatureId: BASE, executedOn: "2026-05-10", effectiveDate: "2026-07-01", documentUrl: "" }))
    check("POSITIVE CONTROL: an amendment without the executed document is refused", !noDoc.ok && /document_required/.test((noDoc as any).error))

    const { loadAgentAgreementAsOf } = await import("../lib/commission/agreement-terms")
    const june = await loadAgentAgreementAsOf(svc as never, { brokerageId: d.B, agentId: d.A, asOf: { date: "2026-06-15", source: "close_date" } })
    check("the engine's resolution cites the executed agreement IN FORCE by effective date (June → the base) and says the terms were never VERIFIED against it", june.signedAgreement?.id === BASE && june.governance === "unverified")
    // verify the terms against the base (the human step) — then the governance reads verified for a June deal, and unverified once the July amendment governs
    const prop = ON.proposeTermsFromAgreement(cs[0] as never)
    const ver = await quiet(() => ON.verifyAgreementTerms(svc as never, broker(d), { contractSignatureId: BASE, terms: { split_percent: 70 }, proposal: prop }))
    const prof = rows(svc, "agent_commission_profiles")[0]
    check("a finance admin VERIFIES the terms against the executed agreement: the profile carries agreement_signature_id + the agreement's effective date; the ledger names what the human changed from the proposal",
      ver.ok && prof.agreement_signature_id === BASE && prof.effective_date === "2026-01-01" && rows(svc, "agent_action_ledger").some((l) => l.action === "finance.agreement_terms.verified" && Array.isArray(l.detail?.changed_from_proposal)))
    // the m812 trigger is not modelled in memory: seed the version it writes (terms carry agreement_signature_id), as the trigger does
    rows(svc, "agent_commission_profile_versions").push({ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: "2026-01-01", terms: { split_percent: 70, is_active: true, agreement_signature_id: BASE }, recorded_at: "2026-02-01T00:00:00Z" })
    const juneV = await loadAgentAgreementAsOf(svc as never, { brokerageId: d.B, agentId: d.A, asOf: { date: "2026-06-15", source: "close_date" } })
    const augV = await loadAgentAgreementAsOf(svc as never, { brokerageId: d.B, agentId: d.A, asOf: { date: "2026-08-15", source: "close_date" } })
    check("verified for the June deal; for the August deal the AMENDMENT governs, so the same terms are 'unverified' until a human verifies them against it (an executed change applies from its effective date)",
      juneV.governance === "verified" && augV.signedAgreement?.id === cs[1].id && augV.governance === "unverified")
    const unverifiedNoDate = await quiet(() => ON.verifyAgreementTerms(svc as never, broker(d), { contractSignatureId: cs[1].id, terms: { split_percent: 80 } }))
    check("POSITIVE CONTROL: verification of a non-admin is refused; verification against an agreement with no effective date is refused", unverifiedNoDate.ok === true && !(await quiet(() => ON.verifyAgreementTerms(svc as never, agentActor(d), { contractSignatureId: BASE, terms: { split_percent: 70 } }))).ok)

    // the engine: a signed contradiction holds a FINAL; a preview prices the stored terms
    const dm = newDeal()
    const sm = canaryClient(seed(dm, { extra: { contract_signatures: [sig({ agent_id: dm.A, brokerage_id: dm.B, contract_type: "commission_agreement", fully_signed_at: "2026-01-05T00:00:00Z", effective_date: "2026-01-01", field_values: { split_percent: "75" } })] } }) as never)
    const fin = await engine(sm, dm)
    const prv = await engine(sm, dm, "preview")
    check("the executed agreement states 75 %, the stored terms say 70 %: the FINAL refuses by name and posts nothing; the PREVIEW prices the stored 70 %",
      fin.success === false && /states split_percent 75/.test(fin.error ?? "") && rows(sm, "commission_distributions").length === 0 && prv.success && cents(prv.net_to_agent) === 840_000)

    // the brokerage default never prices over an executed client agreement that states the rate
    const dr = newDeal()
    const LST = uuid(), LA = uuid()
    const sr = canaryClient(seed(dr, { txn: { commission_percentage: null, listing_id: LST }, extra: { listing_agreements: [{ id: LA, brokerage_id: dr.B, listing_id: LST, esign_status: "fully_executed", total_commission_rate: 2.5 }] } }) as never)
    const rf = await engine(sr, dr)
    const rp = await engine(sr, dr, "preview")
    check("a deal with NO rate of its own whose executed listing agreement STATES one: the FINAL refuses (the brokerage default is never applied over a signed agreement); the preview runs and names the agreement",
      rf.success === false && /states the commission/.test(rf.error ?? "") && rp.success)
    const dn = newDeal()
    const sn = canaryClient(seed(dn, { txn: { commission_percentage: null } }) as never)
    const rn = await engine(sn, dn)
    check("POSITIVE CONTROL: with no executed client agreement on the deal, the brokerage's own default prices it (3 % of $400,000)", rn.success && cents(rn.gross_commission) === 1_200_000, JSON.stringify(rn).slice(0, 160))

    const snapshot = raw("scripts/schema-snapshot.ts")
    const profileCols = (/  agent_commission_profiles: \[([^\]]*)\]/.exec(snapshot)?.[1] ?? "").split(",").map((x) => x.trim().replace(/"/g, ""))
    const live = ON.AGREEMENT_TERM_KEYS.filter((k) => profileCols.includes(k))
    check("every ruling-4 term (split, team-leader share, cap, cap contributions, cap anniversary, transaction / desk / technology / E&O fees, royalty, referral, residual) is an agreement column the verification writes — derived from the live schema cache",
      live.length === ON.AGREEMENT_TERM_KEYS.length && ["split_percent", "team_override_percent", "cap_amount", "cap_eligible_contributions", "cap_anniversary_date", "transaction_fee_value", "desk_fee_value", "technology_fee_value", "eo_fee_value", "royalty_value", "referral_value", "residual_value"].every((k) => (ON.AGREEMENT_TERM_KEYS as readonly string[]).includes(k)),
      ON.AGREEMENT_TERM_KEYS.filter((k) => !profileCols.includes(k)).join(", "))
  }

  // ══ C · onboarding: the paper proposes, a human verifies ═══════════════════════════════════════════════════════
  console.log("\n[C · commission onboarding — propose from the signed agreement, a human verifies]")
  {
    const ag = { id: "S", esign_status: "fully_signed", effective_date: "2026-01-01", field_values: { split_percent: "80%", cap_amount: "$18,000", transaction_fee_value: "395", "Agent Commission": "99" } }
    const p = ON.proposeTermsFromAgreement(ag as never, { documentId: "D", fields: { split_percent: 85, royalty_value: 6, royalty_type: "percent" }, confidence: "medium" })
    check("the proposal reads the signed form's CANONICAL keys (80 %, $18,000 cap) and never interprets a field the brokerage named differently ('Agent Commission')",
      p.terms.split_percent?.value === 80 && p.terms.split_percent.source === "signed_form_field" && p.terms.cap_amount?.value === 18000 && !Object.values(p.terms).some((t) => t?.value === 99))
    check("the scan's AI extraction proposes only where the form is silent (royalty) — where it DISAGREES with the signed form (85 vs 80) the form wins and the disagreement is a finding",
      p.terms.royalty_value?.source === "ai_extraction" && p.terms.royalty_value.value === 6 && p.findings.some((f) => /reads split_percent as 85/.test(f)))
    check("a value with no stated unit is half a term — a finding, never assumed flat or percent", p.findings.some((f) => /transaction fee value is stated without its unit/.test(f)))
    check("the owner's questions are all on the list (cap, contributions, reset, fees after cap, team leader, referral payer, revenue share, CDA, payout release, buyer/seller charges) and each names where it is answered",
      ["cap", "cap_contributions", "cap_reset", "fees_after_cap", "team_leader_split", "referral_fees", "revenue_share", "cda_used", "payout_release", "client_charges"].every((k) => ON.COMMISSION_SETUP_QUESTIONS.some((q) => q.key === k)))
    check("unanswered questions are reported, never defaulted", p.unanswered.includes("cap_reset") && !p.unanswered.includes("cap"))
    const panel = code("app/dashboard/financials/agreements/agreement-governance-panel.tsx")
    check("the DOOR (ruling 6 on the existing survivors): the onboarding commission item opens the agreements page, where the AI reading of a stored scan is proposed and the verification carries the scan it read",
      /proposeAgreementTermsAction\(\{[^}]*documentId/.test(panel) && /verifyAgreementTermsAction\(\{[^}]*documentId: readScan/.test(panel)
      && /key: "commission_structure"[\s\S]{0,800}href: "\/dashboard\/financials\/agreements"/.test(code("lib/onboarding/setup-readiness.ts"))
      && /agreement_signature_id/.test(code("lib/onboarding/setup-readiness.ts")))
    // through the ONE writer (validation runs before any read): an empty client means a valid shape reaches the agreement read
    const dv = newDeal()
    const vt = async (terms: Record<string, unknown>) => { const r = await quiet(() => ON.verifyAgreementTerms(canaryClient({ contract_signatures: [] }) as never, broker(dv), { contractSignatureId: uuid(), terms })); return r.ok ? "ok" : r.error }
    const [vFoo, vNeg, vPct, vUnit, vGood] = [await vt({ foo: 1 }), await vt({ split_percent: -1 }), await vt({ split_percent: 101 }), await vt({ desk_fee_value: 10 }), await vt({ desk_fee_value: 10, desk_fee_type: "flat" })]
    check("verifyAgreementTerms refuses non-terms, negatives, a percent above 100 and a value without its unit BEFORE reading anything — POSITIVE CONTROL: a well-formed term passes validation and reaches the agreement read",
      /not an agreement term: foo/.test(vFoo) && /never negative/.test(vNeg) && /at most 100/.test(vPct) && /state its unit/.test(vUnit) && vGood === "agreement_not_found", JSON.stringify([vFoo, vNeg, vPct, vUnit, vGood]))
  }

  // ══ D · client-agreement fees ══════════════════════════════════════════════════════════════════════════════════
  console.log("\n[D · transaction / admin fees the seller's and buyer's agreements establish]")
  {
    const base = { listing_agreement_id: "LA", buyer_broker_agreement_id: null, payer: "seller", receiver: "brokerage", value_type: "flat", payable_at_closing: true, included_in_commission: false, brokerage_policy_permits: true, status: "verified", effective_date: "2026-01-01" }
    // through the ONE loader: a deal closing 2026-08-15 at $400,000 whose listing agreement(s) and the buyer's active buyer-broker
    // agreement ("BBA") are found by listing_id / buyer_contact_id, tenant-pinned
    const res = async (feeRows: Array<Record<string, unknown>>, la: Array<Record<string, unknown>> = [{ id: "LA" }], price = 400_000) => {
      const dd = newDeal(), LSTD = uuid(), BUYER = uuid()
      const sv = canaryClient(seed(dd, { txn: { listing_id: LSTD, buyer_contact_id: BUYER, purchase_price: price }, extra: {
        listing_agreements: la.map((a) => ({ brokerage_id: dd.B, listing_id: LSTD, ...a })),
        buyer_broker_agreements: [{ id: "BBA", brokerage_id: dd.B, buyer_contact_id: BUYER, status: "active" }],
        client_agreement_fees: feeRows.map((r) => ({ brokerage_id: dd.B, ...r })),
      } }) as never)
      const r = await CF.loadClientAgreementFeesForTransaction(sv as never, dd.B, dd.T)
      if (!r.ok) throw new Error(`loader refused: ${r.error}`)
      return r.resolution
    }
    const ok = await res([{ ...base, id: "f1", fee_kind: "transaction_fee", value: 395 }, { ...base, id: "f2", fee_kind: "admin_fee", value: 0.1, value_type: "percent_of_price" }, { ...base, id: "f3", fee_kind: "admin_fee", value: 250, listing_agreement_id: null, buyer_broker_agreement_id: "BBA", payer: "buyer" }])
    check("a VERIFIED, payable-at-closing fee outside the commission settles on its PAYER's side: seller $395 transaction + $400 admin (0.1 % of $400,000, from the price), buyer $250 admin",
      ok.settlementTotals.seller.transaction_fee === 395 && ok.settlementTotals.seller.admin_fee === 400 && ok.settlementTotals.buyer.admin_fee === 250)
    const inside = await res([{ ...base, id: "f1", fee_kind: "transaction_fee", value: 395, included_in_commission: true }])
    check("NO DOUBLE COUNT: a fee the agreement includes in the commission is NOT a separate settlement line (and says so)", inside.settlementTotals.seller.transaction_fee === undefined && inside.findings.some((f) => /no double count/.test(f)))
    const entered = await res([{ ...base, id: "f1", fee_kind: "transaction_fee", value: 395, status: "entered", brokerage_policy_permits: null }])
    check("an AGENT-ENTERED fee does not settle until a human verifies it against the executed agreement", entered.settlementTotals.seller.transaction_fee === undefined && entered.findings.some((f) => /not yet verified/.test(f)))
    const legacy = await res([], [{ id: "LA", seller_transaction_fee: 295 }])
    const both = await res([{ ...base, id: "f1", fee_kind: "transaction_fee", value: 395 }], [{ id: "LA", seller_transaction_fee: 295 }])
    check("the listing intake's legacy seller_transaction_fee is read ONLY when no fee row exists (unverified, does not settle) — never counted beside a row (no double count)",
      legacy.fees.length === 1 && legacy.fees[0].status === "legacy_unverified" && !legacy.fees[0].settlesAsOwnLine && both.fees.length === 1 && both.settlementTotals.seller.transaction_fee === 395)
    check("POSITIVE CONTROL: a fee whose payer contradicts its agreement is a finding and never settles", !(await res([{ ...base, id: "f1", fee_kind: "transaction_fee", value: 395, payer: "buyer" }])).fees[0].settlesAsOwnLine)

    // writers
    const d = newDeal()
    const LST = uuid(), LA = uuid(), DOC = uuid(), OTHER = uuid()
    const svc = canaryClient(seed(d, { txn: { listing_id: LST }, extra: {
      listing_agreements: [{ id: LA, brokerage_id: d.B, listing_id: LST, agent_user_id: d.U, esign_status: "fully_executed" }],
      users: [{ id: d.U, brokerage_id: d.B, user_type: "agent" }, { id: d.ADMIN, brokerage_id: d.B, user_type: "broker_owner" }, { id: OTHER, brokerage_id: d.B, user_type: "agent" }],
      agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null, created_at: "2019-09-01T00:00:00Z" }, { id: "agent-other", brokerage_id: d.B, user_id: OTHER }],
      documents: [{ id: DOC, brokerage_id: d.B }], client_agreement_fees: [] } }) as never)
    setSvc(svc)
    const entry = { listingAgreementId: LA, kind: "transaction_fee" as const, receiver: "brokerage" as const, value: 395, valueType: "flat" as const, payableAtClosing: true, includedInCommission: false, effectiveDate: "2026-01-01" }
    const e1 = await quiet(() => CF.enterClientAgreementFee(svc as never, agentActor(d), entry))
    const eOther = await quiet(() => CF.enterClientAgreementFee(svc as never, { userId: OTHER, agentId: "agent-other", brokerageId: d.B, userType: "agent" }, entry))
    check("the agreement's OWN agent enters the fee (status entered, payer from the agreement: seller); another agent is refused", e1.ok && !eOther.ok && rows(svc, "client_agreement_fees")[0].status === "entered" && rows(svc, "client_agreement_fees")[0].payer === "seller")
    const vAgent = await quiet(() => CF.verifyClientAgreementFee(svc as never, agentActor(d), { feeId: (e1 as any).feeId, brokeragePolicyPermits: true, brokeragePolicyRef: "Policy §4.2" }))
    const vNo = await quiet(() => CF.verifyClientAgreementFee(svc as never, broker(d), { feeId: (e1 as any).feeId, brokeragePolicyPermits: false, brokeragePolicyRef: "Policy §4.2" }))
    check("an agent cannot verify a fee; a policy that does NOT permit it is recorded and the fee stays unverified (refused)", !vAgent.ok && !vNo.ok && rows(svc, "client_agreement_fees")[0].status === "entered" && rows(svc, "client_agreement_fees")[0].brokerage_policy_permits === false)
    const vOk = await quiet(() => CF.verifyClientAgreementFee(svc as never, broker(d), { feeId: (e1 as any).feeId, brokeragePolicyPermits: true, brokeragePolicyRef: "Policy §4.2" }))
    check("a finance admin verifies it against the EXECUTED listing agreement with the policy reference", vOk.ok && rows(svc, "client_agreement_fees")[0].status === "verified" && rows(svc, "client_agreement_fees")[0].brokerage_policy_ref === "Policy §4.2")
    const amd = await quiet(() => CF.amendClientAgreementFee(svc as never, broker(d), { supersedesFeeId: (e1 as any).feeId, amendmentDocumentId: DOC, entry: { receiver: "brokerage", value: 495, valueType: "flat", payableAtClosing: true, includedInCommission: false, effectiveDate: "2026-06-01" } }))
    const fees = rows(svc, "client_agreement_fees")
    check("an EXECUTED AMENDMENT supersedes (the prior row kept as 'superseded'), the new fee cites the amendment document and awaits verification", amd.ok && fees.length === 2 && fees[0].status === "superseded" && fees[1].supersedes_fee_id === fees[0].id && fees[1].amendment_document_id === DOC && fees[1].status === "entered")
    const loaded = await CF.loadClientAgreementFeesForTransaction(svc as never, d.B, d.T)
    check("the loader resolves the deal's fees through its listing agreement (the amended fee is pending verification, so nothing settles yet)", loaded.ok && loaded.available && loaded.resolution.fees.length === 1 && loaded.resolution.fees[0].value === 495 && !loaded.resolution.fees[0].settlesAsOwnLine)
    const missing = await CF.loadClientAgreementFeesForTransaction(canaryClient(seed(d, { txn: { listing_id: LST }, extra: { listing_agreements: [{ id: LA, brokerage_id: d.B, listing_id: LST }] } }) as never, { missingTables: ["client_agreement_fees"] }) as never, d.B, d.T)
    check("m859 not applied → `available: false`, said — never a refused read mistaken for 'no fees', never a guess", missing.ok && missing.available === false && missing.resolution.findings.some((f) => /m859/.test(f)))

    // never interchangeable with agent-agreement fees
    const engineFiles = walk("lib/commission/waterfall").concat(["lib/commission/engine.ts", "lib/brokerage/get-default-commission-structure.ts"])
    const READS = /client_agreement_fees|client-agreement-fees/
    const offenders = engineFiles.filter((f) => READS.test(code(f)))
    check("NOT INTERCHANGEABLE: no commission-engine file reads the client-agreement fees, and the client-fee module never writes commission_distributions (stripped) — POSITIVE CONTROL: the finder sees a specimen",
      offenders.length === 0 && !/from\(\s*["']commission_distributions["']\s*\)/.test(code("lib/commission/client-agreement-fees.ts")) && READS.test(`import { x } from "../client-agreement-fees"`), offenders.join(", "))
    const core = await import("../lib/transactions/closing-compliance-core")
    check("the settlement compares each payer's fee on ITS side: the four fee terms are blocking closing terms the scanner is asked for",
      ["seller_transaction_fee", "seller_admin_fee", "buyer_transaction_fee", "buyer_admin_fee", "agent_credit_seller"].every((t) => core.BLOCKING_TERMS.has(t as never) && Object.values(core.SETTLEMENT_FIELD_TO_TERM).some((m) => m.term === t))
      && ["seller_transaction_fee", "buyer_admin_fee", "agent_credit_to_seller"].every((k) => raw("lib/documents/scan-uploaded-document.ts").includes(k)))
  }

  // ══ E · a referral payout needs an executed referral agreement ═════════════════════════════════════════════════
  console.log("\n[E · referral payouts — only on an executed referral agreement on record]")
  {
    const AGR = { referral_agreement_document_id: "doc-ra", referral_agreement_executed_on: "2026-06-30" }
    const base = { id: "r", agent_id: "A", referring_agent_id: "R", partner_id: null, referral_fee_pct: 25, status: "received", transaction_id: null, created_at: "2026-07-01T00:00:00Z" }
    const ctx = { transactionId: "T", producingAgentId: "A", asOf: "2026-08-15" }
    const noPaper = RP.pickReferralForDeal([base], ctx)
    const paper = RP.pickReferralForDeal([{ ...base, ...AGR }], ctx)
    const late = RP.pickReferralForDeal([{ ...base, ...AGR, referral_agreement_executed_on: "2026-09-01" }], ctx)
    check("an INSIDE referral with an agreed 25 % but NO executed agreement HOLDS (owed, not payable on a guess); with the executed agreement it pays the referring agent; an agreement executed AFTER the deal's date holds",
      !!noPaper.hold && /executed referral agreement/.test(noPaper.hold) && paper.hold === null && paper.payee?.kind === "agent" && paper.feePct === 25 && !!late.hold)
    const pbase = { ...base, referring_agent_id: null, partner_id: "P" }
    const partner = (o: Record<string, unknown>) => new Map([["P", { id: "P", partner_type: "real_estate_agent", partner_name: "Riley", company_name: "Outside Realty", active: true, ...o }]])
    const standing = RP.pickReferralForDeal([pbase], { ...ctx, partners: partner({ agreement_document_id: "doc-p", agreement_date: "2026-01-01" }) })
    const informal = RP.pickReferralForDeal([pbase], { ...ctx, partners: partner({ agreement_type: "informal" }) })
    const expired = RP.pickReferralForDeal([pbase], { ...ctx, partners: partner({ agreement_document_id: "doc-p", agreement_date: "2027-01-01" }) })
    check("an OUTSIDE partner pays on its STANDING executed agreement covering the deal's date; an informal arrangement (no paper) or an agreement not yet in force HOLDS",
      standing.hold === null && standing.payee?.kind === "partner" && !!informal.hold && !!expired.hold)
    const d = newDeal()
    const REFERRER = uuid()
    const svc = canaryClient(seed(d, { extra: {
      agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null, created_at: "2019-09-01T00:00:00Z" }, { id: REFERRER, brokerage_id: d.B, user_id: uuid(), team_id: null }],
      referrals: [{ id: uuid(), brokerage_id: d.B, agent_id: d.A, referring_agent_id: REFERRER, referral_fee_pct: 25, status: "received", referred_contact_id: d.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }],
      documents: [],
    } }) as never)
    const fin = await engine(svc, d)
    check("the REAL engine: the FINAL holds by name with no executed referral agreement on record, and posts nothing", fin.success === false && /referral agreement/.test(fin.error ?? "") && rows(svc, "commission_distributions").length === 0)
    const DOC = uuid()
    rows(svc, "documents").push({ id: DOC, brokerage_id: d.B })
    const ref = rows(svc, "referrals")[0]
    const recA = await quiet(() => RA.recordReferralAgreement(svc as never, agentActor(d), { referralId: ref.id, documentId: DOC, executedOn: "2026-06-30" }))
    const rec = await quiet(() => RA.recordReferralAgreement(svc as never, broker(d), { referralId: ref.id, documentId: DOC, executedOn: "2026-06-30" }))
    const rec2 = await quiet(() => RA.recordReferralAgreement(svc as never, broker(d), { referralId: ref.id, documentId: DOC, executedOn: "2026-06-30" }))
    const fin2 = await engine(svc, d)
    check("a finance admin records the executed agreement ONCE (an agent cannot; a second recording is refused) — then the same FINAL pays $3,000 to the referring agent",
      !recA.ok && rec.ok && !rec2.ok && fin2.success && rows(svc, "commission_distributions").some((r) => r.distribution_type === "referral" && r.agent_id === REFERRER && cents(r.calculated_amount) === 300_000),
      JSON.stringify({ recA, rec, rec2, fin2 }).slice(0, 400))
    const foreignDoc = await quiet(() => RA.recordPartnerReferralAgreement(svc as never, broker(d), { partnerId: uuid(), documentId: uuid(), agreementDate: "2026-01-01" }))
    check("POSITIVE CONTROL: a document that is not this brokerage's is refused", !foreignDoc.ok && /document_not_found/.test((foreignDoc as any).error))
  }

  // ══ F · a post-transaction executed addendum reaches its obligations (C7) ═══════════════════════════════════════
  console.log("\n[F · executed addendum → transaction row, compliance re-review, attestation, settlement, CDA, deal team]")
  {
    // the impact is read through the ONE consequence runner (it returns it as `impact`); no transaction yet = nothing else runs
    const { afterExecutedContractChange } = await import("../lib/offers/governing-terms-consequences")
    const impactOf = async (changedTerms: Record<string, unknown>) => (await quiet(() => afterExecutedContractChange(canaryClient({}) as never, { brokerageId: uuid(), transactionId: null, rootOfferId: uuid(), versionNo: 2, source: "addendum", changedTerms, documentId: uuid(), executedOn: "2026-08-10", recordedBy: null }))).impact
    const price = await impactOf({ offer_price: 395_000 })
    const days = await impactOf({ inspection_period_days: 12 })
    check("an executed change's IMPACT: a price change reaches the gross commission, seller net, CDA, cap and referral; a contingency-days change moves no money", price.moneyMoved && ["gross_commission", "cda", "cap_contribution", "referral_fee", "seller_net"].every((o) => price.obligations.includes(o as never)) && !days.moneyMoved && days.nonFinancialTerms.includes("inspection_period_days"))

    const d = newDeal()
    const ROOT_OFFER = uuid(), DOC = uuid(), CDA = uuid(), TC = uuid(), TCU = uuid(), ATT = uuid()
    const svc = canaryClient(seed(d, { txn: { coordinator_id: TC, offer_id: ROOT_OFFER, purchase_price: 400_000 }, extra: {
      offers: [{ id: ROOT_OFFER, brokerage_id: d.B, parent_offer_id: null, offer_type: "purchase", current_round: 1, status: "accepted", buyer_signed_at: "2026-06-01T00:00:00Z", seller_signed_at: "2026-06-02T00:00:00Z", seller_response_type: "accept", offer_price: 400_000, transaction_id: d.T, created_at: "2026-06-01T00:00:00Z" }],
      contract_term_versions: [],
      documents: [{ id: DOC, brokerage_id: d.B, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } }],
      closing_disclosure_agreement: [{ id: CDA, brokerage_id: d.B, transaction_id: d.T, agent_id: d.A, status: "approved", revision_number: 2, sent_to_title_at: "2026-08-01T00:00:00Z", closed_at: null, updated_at: "2026-08-01T00:00:00Z" }],
      closing_disclosure_agreement_revisions: [],
      commission_distributions: [{ id: uuid(), brokerage_id: d.B, transaction_id: d.T, distribution_type: "agent", calculated_amount: 8400, status: "pending" }],
      transaction_coordinators: [{ id: TC, brokerage_id: d.B, user_id: TCU }],
      transaction_compliance_log: [{ id: ATT, brokerage_id: d.B, transaction_id: d.T, check_type: CV.CLOSING_ATTESTATION_CHECK_TYPE, check_label: "x", status: "pass", is_blocking: true, created_at: "2026-08-01T00:00:00Z" }],
      notifications: [],
    } }) as never)
    setSvc(svc)
    const ran: string[] = []
    const { recordContractTermsVersion } = await import("../lib/offers/governing-terms")
    const rec = await quiet(() => recordContractTermsVersion(svc as never, {
      brokerageId: d.B, rootOfferId: ROOT_OFFER, transactionId: d.T, source: "addendum", status: "executed", terms: { offer_price: 395_000 }, documentId: DOC,
      executedAt: "2026-08-10T23:59:59.999Z", recordedBy: d.ADMIN, evidence: { effective_on: "2026-08-12" },
    }, { consequenceDeps: { runClosingCompliance: async (_s, i) => { ran.push(i.trigger); return { ran: true, openBlocking: 1, reason: null } } } }))
    const c = rec.ok ? rec.consequences : undefined
    check("the executed addendum is RECORDED on the versioned terms (C7) and its consequences run after it", rec.ok && rows(svc, "contract_term_versions").length === 1 && rows(svc, "contract_term_versions")[0].status === "executed" && !!c)
    check("the operational transaction row now states the governing price ($395,000) — counted, the signed document untouched", rows(svc, "transactions")[0].purchase_price === 395_000 && c?.transactionMirror.updated.includes("purchase_price") === true)
    check("compliance RE-REVIEW runs (trigger contract_addendum) and the closing attestation the agent gave earlier is RE-OPENED (pending)", ran.includes("contract_addendum") && c?.closingAttestationReopened === true && rows(svc, "transaction_compliance_log").find((r) => r.id === ATT)?.status === "pending")
    check("SETTLEMENT RECONCILIATION: the posted commission is not re-written — a ledger correction is required, by name", c?.settlement.status === "ledger_correction_required" && rows(svc, "commission_distributions").length === 1 && rows(svc, "commission_distributions")[0].calculated_amount === 8400)
    const cda = rows(svc, "closing_disclosure_agreement")[0]
    check("CDA CORRECTION: the APPROVED CDA (already sent to title) is re-opened — changes_requested, revision +1, agent sign-off cleared, a revision row, flagged for RE-SEND",
      c?.cda?.outcome === "reopened" && c.cda.resendToTitle && cda.status === "changes_requested" && cda.revision_number === 3 && cda.agent_signed_off_at === null && rows(svc, "closing_disclosure_agreement_revisions").length === 1 && /re-sent/.test(cda.changes_requested_notes))
    const notes = rows(svc, "notifications")
    check("BROKER / TC / AGENT are told (the admins, the deal's transaction coordinator, the deal's agent)", notes.some((n) => n.user_id === d.ADMIN && n.type === "contract_change_executed") && notes.some((n) => n.user_id === TCU) && notes.some((n) => n.user_id === d.U && n.type === "contract_change_executed"))
    check("LAW 5: one ledger row names the version, document, changed terms and every consequence", rows(svc, "agent_action_ledger").some((l) => l.action === "contract.executed_change.consequences" && l.detail?.document_id === DOC && l.detail?.effective_on === "2026-08-12"))

    const d2 = newDeal()
    const RO2 = uuid(), DOC2 = uuid(), CDA2 = uuid()
    const svc2 = canaryClient(seed(d2, { txn: { offer_id: RO2 }, extra: {
      offers: [{ id: RO2, brokerage_id: d2.B, parent_offer_id: null, offer_type: "purchase", current_round: 1, status: "accepted", buyer_signed_at: "2026-06-01T00:00:00Z", seller_signed_at: "2026-06-02T00:00:00Z", seller_response_type: "accept", offer_price: 400_000, transaction_id: d2.T, created_at: "2026-06-01T00:00:00Z" }],
      contract_term_versions: [], documents: [{ id: DOC2, brokerage_id: d2.B, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } }],
      closing_disclosure_agreement: [{ id: CDA2, brokerage_id: d2.B, transaction_id: d2.T, agent_id: d2.A, status: "approved", revision_number: 1, closed_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z" }],
    } }) as never)
    setSvc(svc2)
    const recOff = await quiet(() => recordContractTermsVersion(svc2 as never, { brokerageId: d2.B, rootOfferId: RO2, transactionId: d2.T, source: "addendum", status: "executed", terms: { offer_price: 390_000 }, documentId: DOC2, executedAt: "2026-08-21T23:59:59.999Z", recordedBy: d2.ADMIN }, { consequences: false }))
    check("POSITIVE CONTROL: `consequences: false` records the version only — nothing else moves", recOff.ok && !(recOff as any).consequences && rows(svc2, "transactions")[0].purchase_price === 400_000)
    const { reopenCdaForCorrection } = await import("../lib/commission/cda-correction")
    const closed = await quiet(() => reopenCdaForCorrection(svc2 as never, { brokerageId: d2.B, transactionId: d2.T, reason: "price amended by an executed addendum", actedBy: d2.ADMIN, source: "contract_addendum" }))
    check("a CLOSED CDA file is never re-opened — the money may have moved; a ledger correction is named instead", closed.ok && closed.result.outcome === "closed_needs_ledger_correction" && rows(svc2, "closing_disclosure_agreement")[0].status === "approved")
    const portal = code("app/actions/cda-portal.ts")
    check("the human CDA-correction door exists, is compliance-gated and runs the same core", /export async function requestCdaCorrectionAction/.test(portal) && /COMPLIANCE_ROLES\.has\(auth\.userType\)[\s\S]{0,600}reopenCdaForCorrection/.test(portal))
  }

  // ══ G · closing verification + the agent's attestation ═════════════════════════════════════════════════════════
  console.log("\n[G · ask at closing — five layers, one attestation, nothing overwritten]")
  {
    const facts = {
      agentAgreement: { readable: true, signedAgreementId: "S", effectiveDate: "2026-01-01", governance: "verified", versionId: "v1", effectiveFrom: "2026-01-01", mismatches: 0, findings: [] },
      clientAgreements: { readable: true, listing: [{ id: "LA", executed: true }], buyer: [], dealType: "seller" },
      referral: { readable: true, applies: false, agreementOnRecord: false, detail: null },
      clientFees: { readable: true, available: true, findings: [], settling: 1 },
      contract: { readable: true, governingVersion: "addendum v1", superseded: 1, latestExecutedAt: "2026-08-10T23:59:59.999Z", addenda: 1, reason: null },
      settlement: { readable: true, openFail: 0, openReview: 0, checked: 5 },
      waterfall: { readable: true, calculatedAt: "2026-08-12T00:00:00Z", versionId: "v1", asOf: "2026-08-15", governance: "verified" },
    }
    const clean = CVC.evaluateClosingVerification(facts as never)
    const stale = CVC.evaluateClosingVerification({ ...facts, waterfall: { ...facts.waterfall, calculatedAt: "2026-08-01T00:00:00Z" }, agentAgreement: { ...facts.agentAgreement, governance: "unverified" } } as never)
    check("the FIVE layers in order (signed agreements → effective terms → contract instruments → settlement → waterfall); a consistent deal reads consistent everywhere",
      clean.layers.map((l) => l.key).join(",") === CVC.VERIFICATION_LAYERS.join(",") && clean.layers.every((l) => l.status === "consistent"))
    check("a calculation older than the latest executed change, and terms not verified against the executed agreement, are FINDINGS on their layers (the digest moves)",
      stale.layers.find((l) => l.key === "waterfall")?.status === "finding" && stale.layers.find((l) => l.key === "effective_terms")?.status === "finding" && stale.digest !== clean.digest)
    check("POSITIVE CONTROL: an unreadable input is 'unreadable', never 'consistent'", CVC.evaluateClosingVerification({ ...facts, settlement: { ...facts.settlement, readable: false } } as never).layers.find((l) => l.key === "settlement")?.status === "unreadable")

    const d = newDeal()
    const TC = uuid(), TCU = uuid(), STRANGER = uuid()
    const svc = canaryClient(seed(d, { txn: { coordinator_id: TC }, extra: { transaction_coordinators: [{ id: TC, brokerage_id: d.B, user_id: TCU }], transaction_compliance_log: [], contract_term_versions: [], offers: [], commission_calculations: [], notifications: [] } }) as never)
    setSvc(svc)
    const asked = await CV.ensureClosingAttestationAsked(svc as never, { brokerageId: d.B, transactionId: d.T })
    const asked2 = await CV.ensureClosingAttestationAsked(svc as never, { brokerageId: d.B, transactionId: d.T })
    const log = () => rows(svc, "transaction_compliance_log").filter((r) => r.check_type === CV.CLOSING_ATTESTATION_CHECK_TYPE)
    check("ASKED once: a pending, BLOCKING compliance-log row (the survivor every closing gate already reads); asking again is idempotent", asked.ok && asked.asked && asked2.ok && !asked2.asked && log().length === 1 && log()[0].status === "pending" && log()[0].is_blocking === true)
    const stranger = await quiet(() => CV.recordClosingAttestation(svc as never, { userId: STRANGER, agentId: "someone", brokerageId: d.B, userType: "agent" }, { transactionId: d.T, answer: "no_unrecorded_change" }))
    const noDesc = await quiet(() => CV.recordClosingAttestation(svc as never, agentActor(d), { transactionId: d.T, answer: "unrecorded_change_reported", description: "x" }))
    check("an agent who is not on the deal cannot answer; a 'yes' without saying what changed is refused", !stranger.ok && !noDesc.ok)
    const before = JSON.stringify([rows(svc, "agent_commission_profiles"), rows(svc, "agent_commission_profile_versions"), rows(svc, "contract_signatures"), rows(svc, "contract_term_versions"), rows(svc, "commission_distributions"), rows(svc, "transactions")])
    const yes = await quiet(() => CV.recordClosingAttestation(svc as never, agentActor(d), { transactionId: d.T, answer: "unrecorded_change_reported", description: "The seller signed a repair-credit addendum yesterday; it is in my email." }))
    const after = JSON.stringify([rows(svc, "agent_commission_profiles"), rows(svc, "agent_commission_profile_versions"), rows(svc, "contract_signatures"), rows(svc, "contract_term_versions"), rows(svc, "commission_distributions"), rows(svc, "transactions")])
    check("'YES — something executed is unrecorded': the row FAILS, BLOCKING, with the instruction to record the executed evidence; the admins are told; NOTHING else changed (no term, agreement, version, ledger entry or deal field)",
      yes.ok && yes.status === "fail" && log()[0].status === "fail" && /record the executed evidence/.test(log()[0].failure_reason) && rows(svc, "notifications").some((n) => n.type === "closing_unrecorded_change") && before === after)
    const tcNo = await quiet(() => CV.recordClosingAttestation(svc as never, { userId: TCU, agentId: null, brokerageId: d.B, userType: "agent" }, { transactionId: d.T, answer: "no_unrecorded_change" }))
    check("the deal's TRANSACTION COORDINATOR may answer; 'no' passes the row with who / when / the five-layer digest it was given on", tcNo.ok && log()[0].status === "pass" && log()[0].checked_by === TCU && new RegExp(tcNo.ok ? tcNo.digest : "zzz").test(log()[0].resolution_notes))
    const portal = code("app/actions/cda-portal.ts")
    const submit = portal.slice(portal.indexOf("export async function submitCdaForApprovalAction"), portal.indexOf("export async function submitCdaForApprovalAction") + 6000)
    check("the CDA SUBMIT asks it: after the file check, ensureClosingAttestationAsked, and a non-pass refuses with closing_attestation_required", /runFinalComplianceCheck[\s\S]*ensureClosingAttestationAsked[\s\S]*closing_attestation_required/.test(submit))
  }

  // ══ H · an agent concession promised on an OFFER (m861) ═════════════════════════════════════════════════════════
  console.log("\n[H · offer-anchored agent concessions follow the contract onto the transaction]")
  {
    const d = newDeal()
    const OFFER = uuid(), COUNTER = uuid()
    const svc = canaryClient(seed(d, { extra: {
      brokerages: [{ id: d.B, agent_concession_approval: "broker_approval_required", created_at: "2018-01-01T00:00:00Z" }],
      transactions: [],
      offers: [{ id: OFFER, brokerage_id: d.B, agent_id: d.A, parent_offer_id: null, transaction_id: null, status: "draft" }, { id: COUNTER, brokerage_id: d.B, agent_id: d.A, parent_offer_id: OFFER, transaction_id: null, status: "countered", current_round: 2 }],
    } }) as never)
    setSvc(svc)
    const both = await quiet(() => CONC.requestAgentConcession(svc as never, agentActor(d), { transactionId: uuid(), offerId: OFFER, beneficiary: "buyer", amount: 1000, valueType: "flat", reason: "closing-cost help" }))
    const notMine = await quiet(() => CONC.requestAgentConcession(svc as never, { ...agentActor(d), agentId: "someone-else" }, { offerId: OFFER, beneficiary: "buyer", amount: 1000, valueType: "flat", reason: "closing-cost help" }))
    const ok = await quiet(() => CONC.requestAgentConcession(svc as never, agentActor(d), { offerId: OFFER, beneficiary: "buyer", amount: 1000, valueType: "flat", reason: "closing-cost help" }))
    const row = rows(svc, "commission_adjustments")[0]
    check("the agent asks on the OFFER before any contract (offer_id set, no transaction); naming both anchors, or another agent's offer, is refused",
      !both.ok && !notMine.ok && ok.ok && row.offer_id === OFFER && (row.transaction_id ?? null) === null && row.approval_status === "requested")
    const copy = canaryClient({ ...JSON.parse(JSON.stringify(svc.tables)), notifications: [] } as never)
    const pre = await quiet(() => CONC.anchorOfferConcessionsToTransaction(copy as never, { brokerageId: d.B, offerIds: [OFFER, COUNTER], transactionId: d.T }))
    check("a contract that executes while its offer's concession is still REQUESTED is an unauthorized commitment: named in the re-anchor's result and the brokerage's admins are told",
      pre.ok && pre.moved === 1 && pre.unauthorized.length === 1 && rows(copy, "notifications").some((n) => n.type === "agent_concession_unauthorized_commitment" && n.user_id === d.ADMIN), JSON.stringify(pre).slice(0, 300))
    rows(svc, "transactions").push({ id: d.T, brokerage_id: d.B, agent_id: d.A, purchase_price: 400_000 })
    const { freezeExecutedTermsAfterPromotion } = await import("../lib/offers/governing-terms")
    await quiet(() => freezeExecutedTermsAfterPromotion({ brokerageId: d.B, offerId: COUNTER, transactionId: d.T, client: svc as never }))
    const moved = rows(svc, "commission_adjustments")[0]
    check("AT PROMOTION the chain's offer-anchored concession follows the contract onto the new transaction (offer_id kept as provenance)", moved.transaction_id === d.T && moved.offer_id === OFFER)
    const again = await CONC.anchorOfferConcessionsToTransaction(svc as never, { brokerageId: d.B, offerIds: [OFFER, COUNTER], transactionId: d.T })
    check("POSITIVE CONTROL: re-anchoring is idempotent — a row that already has its transaction is not moved twice", again.ok && again.moved === 0)
    const noCol = await CONC.anchorOfferConcessionsToTransaction(canaryClient({ commission_adjustments: [] }, { missingColumns: { commission_adjustments: ["offer_id"] } }) as never, { brokerageId: d.B, offerIds: [OFFER], transactionId: d.T })
    check("before m861 is applied the re-anchor reports `unavailable` (nothing could be offer-anchored) — never an error that undoes a promotion", noCol.ok && noCol.unavailable === true)
  }

  // ══ I · the four migrations ═════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[I · m858–m861: stamped, additive, the rules in SQL]")
  {
    const dir = join(ROOT, "supabase/migrations")
    const files = readdirSync(dir).filter((f) => /^m(858|859|860|861)-/.test(f))
    const STAMP = /^(-- WRITTEN, NOT APPLIED \(wave 145, lane 145C\)|-- ── APPLIED LIVE )/
    check("four migrations in the lane's numbers, each stamped on line 1 (the lane stamp OR the applied stamp — the rule, not the waypoint)", files.length === 4 && files.every((f) => STAMP.test(readFileSync(join(dir, f), "utf8").split("\n")[0])), files.join(", "))
    // SQL comments stripped by THE SQL scanner (the line-1 stamp itself names "DROP INDEX / DROP COLUMN")
    const sqlOf = (n: string) => stripSqlComments(readFileSync(join(dir, files.find((f) => f.startsWith(`m${n}-`)) as string), "utf8"))
    check("additive: no DROP COLUMN / DROP INDEX / DROP TABLE in any of them (POSITIVE CONTROL: the finder sees one in a specimen)", files.every((f) => !/DROP\s+(COLUMN|INDEX|TABLE)\b/i.test(sqlOf(f.slice(1, 4)))) && /DROP\s+(COLUMN|INDEX|TABLE)\b/i.test("ALTER TABLE x DROP COLUMN y"))
    const m858 = sqlOf("858")
    check("m858: start_date both-or-neither with its source; the trigger admits ONLY a fully signed brokerage-level agreement of this agent whose effective date IS the start date; an effective date is immutable once recorded",
      /\(start_date IS NULL\) = \(start_date_source IS NULL\)/.test(m858) && /contract_type NOT IN \('independent_contractor', 'commission_agreement'\)/.test(m858) && /v_src\.effective_date IS DISTINCT FROM NEW\.start_date/.test(m858) && /OLD\.effective_date IS NOT NULL AND NEW\.effective_date IS DISTINCT FROM OLD\.effective_date/.test(m858))
    check("m858: a verified profile is dated by its agreement (the m812 version writer gains the agreement branch)", /NEW\.agreement_signature_id IS NOT NULL AND NEW\.effective_date IS NOT NULL THEN\s*v_from := NEW\.effective_date/.test(m858))
    const m859 = sqlOf("859")
    check("m859: exactly one establishing agreement; the payer FOLLOWS the agreement; a verified fee needs its verifier AND the policy's permission; a verified fee's money is changed only by a superseding row",
      /\(listing_agreement_id IS NULL\) <> \(buyer_broker_agreement_id IS NULL\)/.test(m859) && /listing_agreement_id IS NOT NULL AND payer = 'seller'/.test(m859) && /brokerage_policy_permits IS TRUE/.test(m859) && /a verified fee is changed only by an executed amendment/.test(m859))
    const m860 = sqlOf("860")
    check("m860: the referral's executed agreement is a stored document of THIS brokerage, recorded with its execution date (both or neither)", /\(referral_agreement_document_id IS NULL\) = \(referral_agreement_executed_on IS NULL\)/.test(m860) && /v_doc_brokerage IS DISTINCT FROM NEW\.brokerage_id/.test(m860))
    const m861 = sqlOf("861")
    check("m861: a concession names a transaction OR an offer (the offer kept in the row's tenant); it creates NO column without a writer and a reader (the financing subtype is deferred to the lane that owns its writer — POSITIVE CONTROL: the finder sees the column in a specimen)",
      /CHECK \(transaction_id IS NOT NULL OR offer_id IS NOT NULL\)/.test(m861) && /ALTER COLUMN transaction_id DROP NOT NULL/.test(m861) && /v_brokerage IS DISTINCT FROM NEW\.brokerage_id/.test(m861)
      && !/financing_subtype/.test(m861) && /financing_subtype/.test("ALTER TABLE public.offers ADD COLUMN financing_subtype text"))
  }

  // ══ J · AI explains, the engine calculates; one agency-contract vocabulary ═══════════════════════════════════════
  console.log("\n[J · no model call in the new files; one vocabulary]")
  {
    const NEW = ["lib/agreements/agent-agreements.ts", "lib/agreements/referral-agreements.ts", "lib/agreements/session-actor.ts", "lib/commission/agreement-onboarding.ts", "lib/commission/client-agreement-fees.ts", "lib/commission/closing-verification.ts", "lib/commission/cda-correction.ts", "lib/offers/governing-terms-consequences.ts", ...walk("app/actions/commission-policy")]
    const MODEL_CALL = /\b(generateText|generateObject|streamText|generateTextRouted|generateObjectRouted|bookedGenerateObject|bookedGenerateText)\s*\(/
    const offenders = NEW.filter((f) => MODEL_CALL.test(code(f)))
    check(`no model call in the ${NEW.length} new agreement / fee / closing files (stripped) — POSITIVE CONTROL: the finder sees one in a specimen`, offenders.length === 0 && MODEL_CALL.test("await generateObjectRouted({"), offenders.join(", "))
    const admin = code("app/actions/admin/commission-agreement.ts")
    const listed = /AGENCY_CONTRACT_TYPES[^=]*=\s*\[([^\]]*)\]/.exec(admin)?.[1]?.match(/"([a-z_]+)"/g)?.map((x) => x.replace(/"/g, "")) ?? []
    check("ONE agency-contract vocabulary: lib/agreements AGENT_AGREEMENT_TYPES equals the send door's AGENCY_CONTRACT_TYPES (derived from its source, not retyped)", listed.length === 3 && [...listed].sort().join() === [...AA.AGENT_AGREEMENT_TYPES].sort().join(), listed.join(","))
    const vocab = (await import("./check-vocabularies")).CHECK_VOCABULARIES as Record<string, Record<string, string[]>>
    check("every contract type the agreement rules use is a member of the LIVE contract_signatures CHECK", [...AA.AGENT_AGREEMENT_TYPES].every((t) => vocab.contract_signatures.contract_type.includes(t)))
  }

  console.log(`\n${failed === 0 ? "RESULT: PASS" : "RESULT: FAIL"} — ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of failures) console.log(`  · ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); console.log(`\nRESULT: FAIL — ${passed} passed, ${failed + 1} failed (threw)`); process.exit(1) })
