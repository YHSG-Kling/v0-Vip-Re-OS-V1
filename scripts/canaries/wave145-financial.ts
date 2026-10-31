/**
 * scripts/canaries/wave145-financial.ts — FINANCIAL ONBOARDING canary (wave 145, lane 145J; owner rulings 3–9, contracts C6 + C7):
 *   RULING 3 / C6 — agents.start_date (+ start_date_source = the agreement) comes from the EXECUTED agent agreement, never account
 *     creation, first login, subscription or team join; nobody else writes it.
 *   RULING 4 — the signed, versioned agreement in force on the deal's date decides every compensation term; no platform default
 *     when an agreement governs; AI never chooses a percentage.
 *   RULING 5 — a transaction / admin fee the BUYER or SELLER agreement establishes is its own obligation (payer, receiver,
 *     establishing agreement, payable at closing), never interchangeable with an agent-agreement fee, never double-counted.
 *   RULING 6 — commission onboarding: AI reads the signed agreements and PROPOSES structured settings; a human verifies.
 *   RULING 7 — closing verification compares SIGNED AGREEMENTS → CURRENT TERMS → OFFER/COUNTER/ADDENDA → SETTLEMENT → WATERFALL;
 *     a conversational answer never overwrites an executed agreement or an immutable ledger entry.
 *   RULING 8 / C7 — an executed addendum after the transaction exists is a NEW governing-terms version with notification,
 *     compliance re-review, settlement reconciliation and CDA correction — never a silent mutation, never a freeze.
 *   RULING 9 — a referral payout requires an EXECUTED referral agreement on record (inside agent or outside partner).
 *
 * Through the survivors at b364eb4b, all in memory: lib/commission/engine.ts calculateCommission (the eleven waterfall stages, via the
 * 144 fixture scripts/canaries/_commission-deal.ts), lib/commission/referral-payout.ts pickReferralForDeal (pure),
 * lib/offers/governing-terms.ts recordContractTermsVersion + governingContractTerms (the C7 survivor). Lane 145C's names bind at
 * the `WAVE145 BIND` lines. Domain vocabulary (split / cap / fee; RESPA §8 — why a referral fee needs an agreement between
 * licensees) comes from the 144 fixture and lane 145C's published requirements; the real-estate skills were NOT opened by this lane.
 *
 * MEASURED AT b364eb4b: agents has no start_date (scripts/schema-snapshot.ts — anniversary_date only); pickReferralForDeal pays an
 * INSIDE referral on the referral row's agreed percent with no executed referral agreement on record; nothing models a buyer/seller-
 * agreement fee beside listing_agreements.seller_transaction_fee; a deal with no rate of its own is priced on the brokerage default
 * even when its executed listing agreement states the commission.
 */
import { CANARY_TAG, LIVE, canaryClient, cleanupCanary, uuid } from "./_harness"
import { listFiles, strippedRepo } from "./_registry"
import { cents, newDeal, rowsOf, runEngine, seedDeal } from "./_commission-deal"
import { memSupabase } from "../in-memory-supabase"
import { bindContract, canary145, quiet, sqlCode, wave145Migrations, type Contract } from "./wave145-harness"

// ── WAVE145 BIND (lane 145C notes, "## Canary requirements", published 16:42Z) ──────────────────────────────────────────────────
const AGREEMENTS: Contract = { id: "145C agent agreements (C6)", lane: "145C", file: "lib/agreements/agent-agreements.ts", exports: ["setAgentStartDateFromAgreement", "proposeAgentStartDate", "agreementInForce"] }
const REFERRAL_AGREEMENTS: Contract = { id: "145C referral agreements", lane: "145C", file: "lib/agreements/referral-agreements.ts", exports: ["recordReferralAgreement"] }
const CLIENT_FEES: Contract = { id: "145C client-agreement fees", lane: "145C", file: "lib/commission/client-agreement-fees.ts", exports: ["loadClientAgreementFeesForTransaction"] }
const ONBOARDING: Contract = { id: "145C agreement onboarding", lane: "145C", file: "lib/commission/agreement-onboarding.ts", exports: ["verifyAgreementTerms", "proposeTermsFromAgreement"] }
const CLOSING: Contract = { id: "145C closing verification", lane: "145C", file: "lib/commission/closing-verification.ts", exports: ["ensureClosingAttestationAsked", "recordClosingAttestation", "CLOSING_ATTESTATION_CHECK_TYPE"] }
const CONCESSION_ANCHOR: Contract = { id: "145C offer-anchored concessions (m861)", lane: "145C", file: "lib/commission/agent-concession.ts", exports: ["anchorOfferConcessionsToTransaction"] }
/** The ONE writer of agents.start_date (C6) — every other literal-payload writer is a defect. */
const START_DATE_WRITERS = ["lib/agreements/agent-agreements.ts"]

/** PURE — how many `.from("agents").update|insert|upsert(<literal payload>)` calls in STRIPPED source name start_date in the payload. */
export function agentsStartDateWrites(src: string): number {
  let n = 0
  for (const m of src.matchAll(/\.from\(\s*["']agents["']\s*\)\s*\.\s*(?:update|insert|upsert)\s*\(/g)) {
    let depth = 1, i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < src.length && depth > 0) { const ch = src[i++]; if (ch === "(") depth++; else if (ch === ")") depth-- }
    if (/\bstart_date\s*:/.test(src.slice(start, i))) n++
  }
  return n
}

type Actor = { userId: string; agentId: string | null; brokerageId: string; userType: string; isTenantPrincipal: boolean }
const snap = (s: { tables: Record<string, Array<Record<string, unknown>>> }, ts: readonly string[]) => JSON.stringify(ts.map((t) => s.tables[t] ?? []))

export async function run() {
  const c = canary145("Financial onboarding: agent start date from the executed agreement · the agreement in force prices every term · client-agreement fees on their own side · AI proposes, a human verifies · five-layer closing verification · versioned addenda · executed referral agreement")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — a commission calculation posts a ledger")
  const tenants: string[] = []
  const svcs: Array<Awaited<ReturnType<typeof runEngine>>["svc"]> = []
  const B = "00000000-0000-4000-8000-0000000c0b01", B2 = "00000000-0000-4000-8000-0000000c0b02", A = "00000000-0000-4000-8000-0000000c0a01", U = "00000000-0000-4000-8000-0000000c0u01", UA = "00000000-0000-4000-8000-0000000c0u02"
  const agentActor: Actor = { userId: U, agentId: A, brokerageId: B, userType: "agent", isTenantPrincipal: false }
  const financeAdmin: Actor = { userId: UA, agentId: null, brokerageId: B, userType: "broker_owner", isTenantPrincipal: true }

  // ── 1 · C6: agents.start_date + start_date_source, from the executed agent agreement, ONE writer ──
  const c6Mig = wave145Migrations().filter((m) => m.lane === "145C").find((m) => /ALTER\s+TABLE\s+(?:public\.)?agents\b[\s\S]*?\bstart_date\b/i.test(sqlCode(m.sql)) && /\bstart_date_source\b/.test(sqlCode(m.sql)))
  const trigger = !!c6Mig && /CREATE\s+TRIGGER\s+agents_start_date_from_agreement\b/i.test(sqlCode(c6Mig.sql))
  const writers = [...listFiles("lib", (f) => /\.tsx?$/.test(f)), ...listFiles("app", (f) => /\.tsx?$/.test(f))].filter((f) => agentsStartDateWrites(strippedRepo(f) ?? "") > 0)
  // POSITIVE CONTROL: the finder sees a literal payload write and ignores a start_date written to another table.
  const finderControl = agentsStartDateWrites(`await svc.from("agents").update({ start_date: d, start_date_source: id }).eq("id", a)`) === 1 && agentsStartDateWrites(`await svc.from("ad_campaigns").insert({ start_date: d })`) === 0
  const strays = writers.filter((f) => !START_DATE_WRITERS.includes(f))
  c.rule("145C", "C6 · THE AGENT START DATE COMES FROM THE EXECUTED AGENT AGREEMENT (ruling 3: 'There has to be an agents.start date which comes from the agents agreement'): a lane-145C migration adds agents.start_date AND agents.start_date_source (the agreement id) with the database rule that admits only an executed brokerage-level agreement (trigger agents_start_date_from_agreement); the ONE code writer is the agreement path — account creation, first login, subscription and team join never write it (every stripped literal-payload write of agents.start_date is in lib/agreements/agent-agreements.ts; finder positive control included)", finderControl && !!c6Mig && trigger && writers.length > 0 && strays.length === 0, `migration ${c6Mig?.file.split("/").pop() ?? "none (m858–m861)"}; trigger ${trigger}; writers of agents.start_date: ${writers.join(", ") || "none"}; outside the agreement path: ${strays.join(", ") || "none"}; finder control ${finderControl}`)

  const ag = await bindContract(AGREEMENTS)
  await c.check("145C", "C6 · ONLY A FINANCE ADMIN SETS THE START DATE, ONLY FROM AN EXECUTED BROKERAGE-LEVEL AGREEMENT, AND IT IS THAT AGREEMENT'S EFFECTIVE DATE (ruling 3: 'never account creation, first login, subscription date or team-join timestamp'): the agent's own request is refused; a finance admin naming the executed independent-contractor agreement writes start_date = its effective date and start_date_source = the agreement; a TEAM agreement is refused (a team join is not a start date) and leaves the date as it was; the proposal never offers a team agreement, an amendment or an undated agreement", async () => {
    if (!ag.mod) return { ok: false, evidence: ag.evidence }
    const sig = (id: string, over: Record<string, unknown>) => ({ id, agent_id: A, brokerage_id: B, contract_type: "independent_contractor", esign_status: "fully_signed", fully_signed_at: "2026-03-01T12:00:00Z", effective_date: "2026-03-15", amends_contract_signature_id: null, team_id: null, ...over })
    const S1 = "00000000-0000-4000-8000-0000000c5001", ST = "00000000-0000-4000-8000-0000000c5002"
    const rows = [sig(S1, {}), sig(ST, { contract_type: "team_agreement", effective_date: "2025-05-01", fully_signed_at: "2025-05-01T12:00:00Z" })]
    const s = memSupabase({ agents: [{ id: A, brokerage_id: B, user_id: U, start_date: null, start_date_source: null, anniversary_date: "2024-01-02", created_at: "2024-01-02T00:00:00Z" }], contract_signatures: rows.map((r) => ({ ...r })), agent_action_ledger: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const agentRow = () => (s.tables.agents ?? [])[0] ?? {}
    const byAgent = await quiet(async () => ag.mod!.setAgentStartDateFromAgreement(s, agentActor, { agentId: A, contractSignatureId: S1 })) as Record<string, any>
    const afterAgent = agentRow().start_date ?? null
    const byAdmin = await quiet(async () => ag.mod!.setAgentStartDateFromAgreement(s, financeAdmin, { agentId: A, contractSignatureId: S1 })) as Record<string, any>
    const set = { d: agentRow().start_date, src: agentRow().start_date_source }
    const team = await quiet(async () => ag.mod!.setAgentStartDateFromAgreement(s, financeAdmin, { agentId: A, contractSignatureId: ST })) as Record<string, any>
    const proposalAll = ag.mod.proposeAgentStartDate(A, [...rows, sig("amend", { amends_contract_signature_id: S1, effective_date: "2025-01-01" }), sig("undated", { effective_date: null, fully_signed_at: "2024-06-01T12:00:00Z" })]) as Record<string, any>
    const proposalNone = ag.mod.proposeAgentStartDate(A, [rows[1], sig("amend", { amends_contract_signature_id: S1, effective_date: "2025-01-01" }), sig("undated", { effective_date: null })]) as Record<string, any>
    return { ok: !byAgent.ok && afterAgent === null && byAdmin.ok && set.d === "2026-03-15" && set.src === S1 && !team.ok && agentRow().start_date === "2026-03-15" && proposalAll.proposal?.contractSignatureId === S1 && proposalNone.proposal === null, evidence: `agent asks → ${byAgent.ok ? "WRITTEN" : "refused"}; finance admin → ${set.d ?? "∅"} from ${set.src === S1 ? "the IC agreement" : String(set.src)}; team agreement → ${team.ok ? "ACCEPTED" : String(team.error).split(":")[0]}; proposal → ${proposalAll.proposal?.contractSignatureId === S1 ? "the IC agreement" : JSON.stringify(proposalAll.proposal)}; team/amendment/undated only → ${proposalNone.proposal === null ? "no proposal" : JSON.stringify(proposalNone.proposal)}` }
  })

  // ── 2 · RULING 4: the agreement IN FORCE ON THE DEAL'S DATE prices the deal — not the live profile, not a platform default ──
  const early = newDeal({ close: "2026-06-01", split: 70 }); tenants.push(early.B)
  const late = newDeal({ close: "2026-10-01", split: 70 }); tenants.push(late.B)
  for (const d of [early, late]) {
    const s = seedDeal(d)
    // the amendment: 80 % effective 1 Sept 2026 (recorded after the June closing); the LIVE profile already reads 80; a stale
    // agents.commission_split (50) and the brokerage default structure are platform values that must never price a governed deal.
    s.agent_commission_profile_versions.push({ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: "2026-09-01", terms: { split_percent: 80, is_active: true }, recorded_at: "2026-09-02T00:00:00Z" })
    s.agent_commission_profiles[0].split_percent = 80
    s.agents[0].commission_split = 50
    s.brokerages[0].name = `${CANARY_TAG} Agreement Brokerage`
    d.extra = undefined
    const r = await runEngine(d, { svc: canaryClient(s as never) }); svcs.push(r.svc)
    ;(d as unknown as { result: typeof r }).result = r
  }
  const er = (early as unknown as { result: Awaited<ReturnType<typeof runEngine>> }).result
  const lr = (late as unknown as { result: Awaited<ReturnType<typeof runEngine>> }).result
  const llmInMoney = listFiles("lib/commission", (f) => /\.ts$/.test(f)).filter((f) => /\b(generateText|generateObject|generateTextRouted|generateObjectRouted|gatewayChat|streamText)\b/.test(strippedRepo(f) ?? ""))
  c.rule("145C", "THE AGREEMENT IN FORCE ON THE DEAL'S DATE DECIDES THE SPLIT — NO PLATFORM DEFAULT WHEN AN AGREEMENT GOVERNS (ruling 4; green, preserve): the agent's 70 % agreement prices a June closing ($12,000 gross → agent $8,400) even though an 80 % amendment (effective 1 Sept) is now the live profile and agents.commission_split reads 50; an October closing is priced at the amendment's 80 % ($9,600); no model call anywhere under lib/commission (AI never chooses a percentage)", er.r.success && cents(er.r.gross_commission) === 1_200_000 && cents(er.r.net_to_agent) === 840_000 && lr.r.success && cents(lr.r.net_to_agent) === 960_000 && llmInMoney.length === 0, `June: ${er.r.error ?? ""} gross ${er.r.gross_commission} agent ${er.r.net_to_agent}; October: ${lr.r.error ?? ""} agent ${lr.r.net_to_agent}${llmInMoney.length ? `; LLM in ${llmInMoney.join(",")}` : ""}`)

  await c.check("145C", "AN AGREEMENT GOVERNS FROM ITS EFFECTIVE DATE, AND THE AGENT'S OWN ANNIVERSARY ANCHORS ON THE AGREEMENT'S START DATE (rulings 3 + 4: 'an executed change applies from its effective date'; 'never account creation'): of two executed commission agreements, the one signed in January but effective 1 March does NOT govern a 15 February deal (the earlier agreement does) and DOES govern a 15 March deal; with both the agreement's start date and the seat's anniversary stamp present, the agent's own cap anniversary anchors on the agreement's start date", async () => {
    if (!ag.mod) return { ok: false, evidence: ag.evidence }
    const row = (id: string, signed: string, eff: string) => ({ id, agent_id: A, brokerage_id: B, contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: `${signed}T12:00:00Z`, effective_date: eff })
    const rows = [row("A0", "2025-01-01", "2025-01-01"), row("A1", "2026-01-10", "2026-03-01")]
    const feb = ag.mod.agreementInForce(rows, ["commission_agreement"], "2026-02-15") as Record<string, any> | null, mar = ag.mod.agreementInForce(rows, ["commission_agreement"], "2026-03-15") as Record<string, any> | null
    const cap = await quiet(async () => import("../../lib/commission/cap-resolver")) as unknown as Record<string, any>
    const w = cap.resolveAnniversaryWindow({ basis: "agent_start_date", today: "2026-10-27", agentStartDate: "2026-03-15", agentAnniversaryDate: "2024-01-02", agentCreatedAt: "2024-01-02T00:00:00Z" }) as Record<string, any>
    return { ok: feb?.row?.id === "A0" && mar?.row?.id === "A1" && w.ok !== false && w.window?.anchorSource === "agreement_start_date", evidence: `15 Feb → ${feb?.row?.id ?? "none"}; 15 Mar → ${mar?.row?.id ?? "none"}; anniversary anchors on ${w.window?.anchorSource ?? w.error ?? "?"}` }
  })

  const governed = newDeal({ close: "2026-09-15", ratePct: 3, transaction: { commission_percentage: null, listing_id: "00000000-0000-4000-8000-0000000c1001" } }); tenants.push(governed.B)
  governed.extra = { listing_agreements: [{ id: uuid(), brokerage_id: governed.B, listing_id: "00000000-0000-4000-8000-0000000c1001", esign_status: "fully_signed", fully_executed_at: "2026-07-01T00:00:00Z", total_commission_rate: 2.5 }] }
  const ungoverned = newDeal({ close: "2026-09-15", ratePct: 3, transaction: { commission_percentage: null } }); tenants.push(ungoverned.B)
  const gr = await runEngine(governed); svcs.push(gr.svc)
  const ur = await runEngine(ungoverned); svcs.push(ur.svc)
  const said = `${gr.r.error ?? ""} ${gr.warnings.join(" ")}`
  c.rule("145C", "NO PLATFORM DEFAULT OVER A SIGNED AGREEMENT (ruling 4: 'No platform-default percentages when a signed agreement governs'): a deal with no rate of its own whose EXECUTED listing agreement states the commission is REFUSED a final calculation (the brokerage default is never applied over it — the refusal says the agreement states the commission); positive control: a brokerage with NO executed client agreement still prices on its default", !gr.r.success && /agreement/i.test(said) && ur.r.success && cents(ur.r.gross_commission) === 1_200_000, `governed deal → ${gr.r.success ? `PRICED on the default (gross ${gr.r.gross_commission})` : `refused (${String(gr.r.error ?? "").slice(0, 110)})`}; no agreement → ${ur.r.success ? `prices on the default (gross ${ur.r.gross_commission})` : `refused (${ur.r.error})`}`)

  // ── 3 · RULING 9: a referral payout needs an EXECUTED referral agreement on record ──
  const rp = await import("../../lib/commission/referral-payout")
  const ref = { id: "00000000-0000-4000-8000-0000000c7001", brokerage_id: B, agent_id: "AGENT", referring_agent_id: "REFERRER", partner_id: null, referral_fee_pct: 25, status: "received", transaction_id: null, created_at: "2026-07-01T00:00:00Z", referral_agreement_document_id: null as string | null, referral_agreement_executed_on: null as string | null }
  const ctx = { transactionId: "T1", producingAgentId: "AGENT", asOf: "2026-10-01" }
  const pays = (p: { referral: unknown; feePct: number | null; feeFlatCents?: number | null; hold?: string | null } | null) => !!p && !!p.referral && !p.hold && ((p.feePct ?? 0) > 0 || (p.feeFlatCents ?? 0) > 0)
  const noAgreement = rp.pickReferralForDeal([ref] as never, ctx)
  const ra = await bindContract(REFERRAL_AGREEMENTS)
  await c.check("145C", "A REFERRAL PAYOUT REQUIRES AN EXECUTED REFERRAL AGREEMENT ON RECORD (ruling 9: 'There will be agreed and executed referral agreements if a brokerage needs to pay the referral'): an inside-agent referral carrying an agreed 25 % but NO executed referral agreement is HELD with the reason (never paid on the row's say-so); a finance admin records the executed agreement (a document stored in THIS brokerage — another brokerage's document is refused) and the same referral then pays", async () => {
    const heldFirst = !pays(noAgreement) && !!(noAgreement as { hold?: string | null }).hold
    if (!ra.mod) return { ok: false, evidence: `no agreement → ${pays(noAgreement) ? `PAYS ${noAgreement.feePct}%` : `held (${String((noAgreement as { hold?: string | null }).hold ?? noAgreement.findings[0] ?? "").slice(0, 80)})`}; ${ra.evidence}` }
    const DOC = "00000000-0000-4000-8000-0000000c7d01", FOREIGN = "00000000-0000-4000-8000-0000000c7d02"
    const s = memSupabase({ referrals: [{ ...ref }], documents: [{ id: DOC, brokerage_id: B }, { id: FOREIGN, brokerage_id: B2 }], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true })
    const foreign = await quiet(async () => ra.mod!.recordReferralAgreement(s, financeAdmin, { referralId: ref.id, documentId: FOREIGN, executedOn: "2026-06-30" })) as Record<string, any>
    const byAgent = await quiet(async () => ra.mod!.recordReferralAgreement(s, agentActor, { referralId: ref.id, documentId: DOC, executedOn: "2026-06-30" })) as Record<string, any>
    const rec = await quiet(async () => ra.mod!.recordReferralAgreement(s, financeAdmin, { referralId: ref.id, documentId: DOC, executedOn: "2026-06-30" })) as Record<string, any>
    const after = rp.pickReferralForDeal((s.tables.referrals ?? []) as never, ctx)
    return { ok: heldFirst && !foreign.ok && !byAgent.ok && rec.ok && pays(after), evidence: `no agreement → ${heldFirst ? "held" : "PAYS"}; another brokerage's document → ${foreign.ok ? "ACCEPTED" : "refused"}; agent records it → ${byAgent.ok ? "ACCEPTED" : "refused"}; finance admin → ${rec.ok ? "recorded" : rec.error}; then → ${pays(after) ? `pays ${after.feePct}%` : `still held (${String(after.hold ?? "").slice(0, 60)})`}` }
  })

  // ── 4 · C7 / RULING 8: an executed addendum after the transaction is a NEW governing version; nothing is mutated ──
  const BA = uuid(), T = uuid(), D1 = uuid(), D2 = uuid(), V1 = uuid()
  tenants.push(BA)
  const both = { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] }
  const svc = canaryClient({
    brokerages: [{ id: BA, name: `${CANARY_TAG} Addendum Brokerage` }],
    transactions: [{ id: T, brokerage_id: BA, purchase_price: 400_000, status: "active", stage: "UNDER_CONTRACT" }],
    documents: [{ id: D1, brokerage_id: BA, signature_completeness: both }, { id: D2, brokerage_id: BA, signature_completeness: { signatures: [{ signer_role: "seller", signed: true }] } }],
    contract_term_versions: [{ id: V1, brokerage_id: BA, transaction_id: T, root_offer_id: null, offer_id: null, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { offer_price: 400_000, closing_date: "2026-11-20" }, executed_at: "2026-09-01T00:00:00Z", recorded_by: null, evidence: {} }],
    offers: [],
  })
  svcs.push(svc)
  const gt = await import("../../lib/offers/governing-terms")
  const oneSided = await quiet(() => gt.recordContractTermsVersion(svc as never, { brokerageId: BA, transactionId: T, source: "addendum", status: "executed", terms: { offer_price: 392_000 }, documentId: D2 }))
  const spoken = await quiet(() => gt.recordContractTermsVersion(svc as never, { brokerageId: BA, transactionId: T, source: "addendum", status: "executed", terms: { offer_price: 392_000 } }))
  const executed = await quiet(() => gt.recordContractTermsVersion(svc as never, { brokerageId: BA, transactionId: T, source: "addendum", status: "executed", terms: { offer_price: 392_000 }, documentId: D1, executedAt: "2026-10-15T00:00:00Z" }))
  const gov = await quiet(() => gt.governingContractTerms(svc as never, BA, { transactionId: T }))
  const g = gov.ok ? gov.governing : null
  const original = rowsOf(svc, "contract_term_versions").find((r) => r.id === V1)
  c.rule("145C", "C7 · AN EXECUTED ADDENDUM AFTER THE TRANSACTION EXISTS IS A NEW GOVERNING VERSION, NEVER A MUTATION (ruling 8 — green, preserve): a both-signed price addendum ($392,000) recorded against the transaction becomes the governing term from its execution, the original $400,000 stays in the record as superseded (row untouched); a one-signature paper and a spoken/typed change with no executed document are REFUSED — a conversational statement never overwrites executed terms (ruling 7)", !oneSided.ok && !spoken.ok && executed.ok && !!g && g.values.offer_price === 392_000 && g.conflicts.some((x) => x.key === "offer_price" && x.superseded.value === 400_000) && original?.terms?.offer_price === 400_000, `one-signature → ${oneSided.ok ? "ACCEPTED" : "refused"}; no document → ${spoken.ok ? "ACCEPTED" : "refused"}; executed → ${executed.ok ? `v${executed.versionNo}` : (executed as { reason: string }).reason}; governing price ${g?.values.offer_price ?? "?"} (${g?.governingVersion?.source ?? "?"}); superseded kept ${!!g?.conflicts.length}`)

  await c.check("145C", "THE ADDENDUM REACHES THE PEOPLE AND THE MONEY (ruling 8: 'broker/TC notification · compliance re-review · settlement reconciliation · CDA correction'): recording an executed post-transaction price addendum makes the transaction's price follow the governing terms, re-runs the compliance review, re-opens an APPROVED CDA for correction as a new revision (never edits it in place), and notifies the brokerage's admins, the deal's TC and its agent; positive control: the same recording with consequences off moves nothing", async () => {
    const TX = "00000000-0000-4000-8000-0000000c8001", CDA = "00000000-0000-4000-8000-0000000c8002", TC = "00000000-0000-4000-8000-0000000c8003", UTC = "00000000-0000-4000-8000-0000000c8004", DOC = "00000000-0000-4000-8000-0000000c8005"
    const world = () => memSupabase({
      transactions: [{ id: TX, brokerage_id: B, agent_id: A, coordinator_id: TC, purchase_price: 400_000, commission_finalized_at: null, status: "active" }],
      documents: [{ id: DOC, brokerage_id: B, signature_completeness: both }],
      contract_term_versions: [{ id: uuid(), brokerage_id: B, transaction_id: TX, root_offer_id: null, offer_id: null, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { offer_price: 400_000 }, executed_at: "2026-09-01T00:00:00Z", recorded_by: null, evidence: {} }],
      closing_disclosure_agreement: [{ id: CDA, brokerage_id: B, transaction_id: TX, status: "approved", revision_number: 1, agent_id: A, sent_to_title_at: null, closed_at: null }],
      transaction_coordinators: [{ id: TC, brokerage_id: B, user_id: UTC }], agents: [{ id: A, brokerage_id: B, user_id: U }],
      users: [{ id: UA, brokerage_id: B, user_type: "broker_owner" }], notifications: [], commission_distributions: [], transaction_compliance_log: [], agent_action_ledger: [], offers: [],
    }, { uuidIds: true, stampCreatedAt: true })
    let reReviewed = 0
    const deps = { runClosingCompliance: async () => { reReviewed++; return { ran: true, openBlocking: 0, reason: null } } }
    const input = { brokerageId: B, transactionId: TX, source: "addendum", status: "executed", terms: { offer_price: 392_000 }, documentId: DOC, executedAt: "2026-10-15T00:00:00Z", recordedBy: UA }
    const s = world()
    const r = await quiet(async () => (gt.recordContractTermsVersion as (...a: unknown[]) => Promise<Record<string, any>>)(s, input, { consequenceDeps: deps }))
    const cda = (s.tables.closing_disclosure_agreement ?? [])[0] ?? {}
    const recipients = new Set((s.tables.notifications ?? []).map((n) => String(n.user_id)))
    const ctl = world()
    const rc = await quiet(async () => (gt.recordContractTermsVersion as (...a: unknown[]) => Promise<Record<string, any>>)(ctl, input, { consequences: false, consequenceDeps: deps }))
    const quiet0 = (ctl.tables.transactions ?? [])[0]?.purchase_price === 400_000 && (ctl.tables.closing_disclosure_agreement ?? [])[0]?.status === "approved" && (ctl.tables.notifications ?? []).length === 0
    const price = (s.tables.transactions ?? [])[0]?.purchase_price
    return { ok: r.ok && !!r.consequences && price === 392_000 && reReviewed >= 1 && cda.status !== "approved" && Number(cda.revision_number) === 2 && [UA, UTC, U].every((u) => recipients.has(u)) && rc.ok && quiet0, evidence: `recorded ${r.ok ? `v${r.versionNo}` : r.reason}; consequences ${r.consequences ? "returned" : "NONE"}; price → ${price}; compliance re-review ${reReviewed}×; CDA → ${cda.status} rev ${cda.revision_number}; notified admin ${recipients.has(UA)}, TC ${recipients.has(UTC)}, agent ${recipients.has(U)}; consequences off → nothing moved ${quiet0}` }
  })

  // ── 5 · RULING 5: buyer/seller-agreement fees are their own obligations ──
  const fees = await bindContract(CLIENT_FEES)
  await c.check("145C", "CLIENT-AGREEMENT FEES ARE THEIR OWN OBLIGATIONS ON THE CLIENT'S SIDE, NEVER DOUBLE-COUNTED (ruling 5: 'a transaction fee or an admin fee … dictated from the seller and buyer agreements'): a verified seller transaction fee from the listing agreement settles under the SELLER, a verified buyer admin fee from the buyer-broker agreement under the BUYER; a fee the agreement already folds INTO the commission produces no separate line (no double count); a fee an agent entered and nobody verified does not settle", async () => {
    if (!fees.mod) return { ok: false, evidence: `${fees.evidence}; HEAD carries listing_agreements.seller_transaction_fee and agent_commission_profiles.transaction_fee* — two fees, no rule between them` }
    const T5 = "00000000-0000-4000-8000-0000000c9001", L5 = "00000000-0000-4000-8000-0000000c9002", K5 = "00000000-0000-4000-8000-0000000c9003", LA = "00000000-0000-4000-8000-0000000c9004", BB = "00000000-0000-4000-8000-0000000c9005"
    const fee = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, listing_agreement_id: null, buyer_broker_agreement_id: null, receiver: "brokerage", value_type: "flat", payable_at_closing: true, included_in_commission: false, brokerage_policy_permits: true, status: "verified", effective_date: "2026-01-01", ...over })
    const s = memSupabase({
      transactions: [{ id: T5, brokerage_id: B, listing_id: L5, buyer_contact_id: K5, purchase_price: 500_000, close_date: "2026-10-01" }],
      listing_agreements: [{ id: LA, brokerage_id: B, listing_id: L5, seller_transaction_fee: null }],
      buyer_broker_agreements: [{ id: BB, brokerage_id: B, buyer_contact_id: K5, status: "active" }],
      client_agreement_fees: [
        fee("f-seller-txn", { listing_agreement_id: LA, fee_kind: "transaction_fee", payer: "seller", value: 395 }),
        fee("f-buyer-admin", { buyer_broker_agreement_id: BB, fee_kind: "admin_fee", payer: "buyer", value: 295 }),
        fee("f-in-commission", { listing_agreement_id: LA, fee_kind: "admin_fee", payer: "seller", value: 500, included_in_commission: true }),
        fee("f-entered", { buyer_broker_agreement_id: BB, fee_kind: "transaction_fee", payer: "buyer", value: 150, status: "entered" }),
      ],
    }, { uuidIds: true })
    const r = await quiet(async () => fees.mod!.loadClientAgreementFeesForTransaction(s, B, T5)) as Record<string, any>
    const t = (r.resolution?.settlementTotals ?? {}) as Record<string, Record<string, number>>
    return { ok: r.ok && r.available !== false && t.seller?.transaction_fee === 395 && t.buyer?.admin_fee === 295 && !t.seller?.admin_fee && !t.buyer?.transaction_fee, evidence: r.ok ? `settles: seller ${JSON.stringify(t.seller ?? {})}, buyer ${JSON.stringify(t.buyer ?? {})} (in-commission seller admin fee and the unverified buyer fee must not appear)` : String(r.error) }
  })

  // ── 6 · RULING 6: AI extracts and PROPOSES; a human verifies; the executed agreement stays the authority ──
  const ob = await bindContract(ONBOARDING)
  await c.check("145C", "COMMISSION ONBOARDING: THE SIGNED AGREEMENT PROPOSES, A HUMAN VERIFIES (ruling 6: 'AI extracts terms and PROPOSES … a human verifies; the executed agreement stays the authority'): where the AI's reading of a scan disagrees with what the signed form states, the SIGNED FORM is proposed and the disagreement is a finding; an agent cannot verify terms, and terms are never verified against an agreement whose effective date is not recorded; a finance admin's verification writes the profile anchored to that agreement and its effective date", async () => {
    if (!ob.mod) return { ok: false, evidence: ob.evidence }
    const S = "00000000-0000-4000-8000-0000000ca001", SU = "00000000-0000-4000-8000-0000000ca002"
    const agreement = { id: S, agent_id: A, brokerage_id: B, contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2026-02-01T12:00:00Z", effective_date: "2026-02-15", field_values: { split_percent: 70 } }
    const prop = ob.mod.proposeTermsFromAgreement(agreement, { documentId: "doc-scan", fields: { split_percent: 80 }, confidence: "high" }) as Record<string, any>
    const s = memSupabase({ contract_signatures: [agreement, { ...agreement, id: SU, effective_date: null }], agent_commission_profiles: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true })
    const byAgent = await quiet(async () => ob.mod!.verifyAgreementTerms(s, agentActor, { contractSignatureId: S, terms: { split_percent: 70 } })) as Record<string, any>
    const undated = await quiet(async () => ob.mod!.verifyAgreementTerms(s, financeAdmin, { contractSignatureId: SU, terms: { split_percent: 70 } })) as Record<string, any>
    const ok = await quiet(async () => ob.mod!.verifyAgreementTerms(s, financeAdmin, { contractSignatureId: S, terms: { split_percent: 70 }, proposal: prop })) as Record<string, any>
    const profile = (s.tables.agent_commission_profiles ?? [])[0] ?? {}
    const proposed = prop.terms?.split_percent
    return { ok: proposed?.value === 70 && (prop.findings ?? []).some((f: string) => /signed form/i.test(f)) && !byAgent.ok && !undated.ok && ok.ok && profile.agreement_signature_id === S && String(profile.effective_date).slice(0, 10) === "2026-02-15" && Number(profile.split_percent) === 70, evidence: `form 70 vs scan 80 → proposed ${proposed?.value ?? "∅"} (${proposed?.source ?? "?"}), disagreement a finding ${(prop.findings ?? []).some((f: string) => /signed form/i.test(f))}; agent verifies → ${byAgent.ok ? "WRITTEN" : "refused"}; undated agreement → ${undated.ok ? "WRITTEN" : "refused"}; admin → ${ok.ok ? `profile on ${profile.agreement_signature_id === S ? "the agreement" : String(profile.agreement_signature_id)} from ${profile.effective_date}` : ok.error}` }
  })

  // ── 7 · RULING 7: the closing question is asked, blocks, and an answer overwrites nothing ──
  const cl = await bindContract(CLOSING)
  await c.check("145C", "CLOSING VERIFICATION ASKS, BLOCKS, AND AN ANSWER OVERWRITES NOTHING (ruling 7: 'ask the agent/authorized parties whether any executed change is unrecorded … A conversational statement never overwrites an executed agreement or an immutable ledger entry'): the closing question is ONE pending, blocking row (asking twice adds nothing); the deal's agent reporting an unrecorded change turns it to a failure that still blocks — and the agreements, profile, governing terms, posted distributions and transaction are byte-identical; the CDA submission door refuses until the answer passes", async () => {
    if (!cl.mod) return { ok: false, evidence: cl.evidence }
    const TX = "00000000-0000-4000-8000-0000000cb001"
    const s = memSupabase({
      transactions: [{ id: TX, brokerage_id: B, agent_id: A, buyer_agent_id: null, seller_agent_id: null, coordinator_id: null, purchase_price: 400_000, close_date: "2026-10-30", status: "active" }],
      agent_commission_profiles: [{ id: uuid(), agent_id: A, brokerage_id: B, split_percent: 70, is_active: true }],
      contract_signatures: [{ id: uuid(), agent_id: A, brokerage_id: B, contract_type: "commission_agreement", esign_status: "fully_signed", effective_date: "2026-01-01" }],
      contract_term_versions: [{ id: uuid(), brokerage_id: B, transaction_id: TX, version_no: 1, source: "offer", status: "executed", terms: { offer_price: 400_000 } }],
      commission_distributions: [{ id: uuid(), brokerage_id: B, transaction_id: TX, status: "posted", amount: 8400 }],
      transaction_compliance_log: [], agent_action_ledger: [], notifications: [], users: [{ id: UA, brokerage_id: B, user_type: "broker_owner" }],
    }, { uuidIds: true, stampCreatedAt: true })
    const KEEP = ["agent_commission_profiles", "contract_signatures", "contract_term_versions", "commission_distributions", "transactions"] as const
    const asked1 = await quiet(async () => cl.mod!.ensureClosingAttestationAsked(s, { brokerageId: B, transactionId: TX })) as Record<string, any>
    const asked2 = await quiet(async () => cl.mod!.ensureClosingAttestationAsked(s, { brokerageId: B, transactionId: TX })) as Record<string, any>
    const TYPE = String(cl.mod.CLOSING_ATTESTATION_CHECK_TYPE)
    // SNAPSHOT the asked row (copied) — the answer below updates the same row in place (measured 16:57Z: read afterwards it said
    // 'fail', the state after the answer, not the question as asked).
    const rowsAsked = (s.tables.transaction_compliance_log ?? []).filter((r) => r.check_type === TYPE && r.transaction_id === TX).map((r) => ({ ...r }))
    const before = snap(s, KEEP)
    const ans = await quiet(async () => cl.mod!.recordClosingAttestation(s, agentActor, { transactionId: TX, answer: "unrecorded_change_reported", description: "The seller signed a $5,000 repair credit addendum yesterday." })) as Record<string, any>
    const row = (s.tables.transaction_compliance_log ?? []).find((r) => r.check_type === TYPE) ?? {}
    const identical = snap(s, KEEP) === before
    const gate = listFiles("app/actions", (f) => /\.ts$/.test(f)).filter((f) => { const src = strippedRepo(f) ?? ""; return /\bsubmitCdaForApprovalAction\b/.test(src) && /closing_attestation_required/.test(src) })
    return { ok: asked1.ok && asked2.ok && rowsAsked.length === 1 && rowsAsked[0].status === "pending" && rowsAsked[0].is_blocking === true && ans.ok && row.status === "fail" && row.is_blocking === true && identical && gate.length > 0, evidence: `asked ${rowsAsked.length} row (${rowsAsked[0]?.status ?? "?"}, blocking ${rowsAsked[0]?.is_blocking}); 'yes, something changed' → ${ans.ok ? `${row.status}, blocking ${row.is_blocking}` : ans.error}; five money tables byte-identical ${identical}; CDA submit gated ${gate.join(", ") || "nowhere"}` }
  })

  // ── 8 · brief item 7 (the 144 gap): a concession promised on the OFFER follows it into the transaction ──
  const conc = await bindContract(CONCESSION_ANCHOR)
  await c.check("145C", "A CONCESSION PROMISED ON THE OFFER FOLLOWS IT INTO THE TRANSACTION (ruling 8's 'never silently mutate' + lane 145C brief item 7, m861): at promotion the offer-anchored concessions are re-pointed to the new transaction with the offer kept as provenance; one still awaiting approval is SURFACED as unauthorized, never silently honoured; another brokerage's concession on the same offer id is untouched", async () => {
    if (!conc.mod) return { ok: false, evidence: conc.evidence }
    const O = "00000000-0000-4000-8000-0000000cc001", TX = "00000000-0000-4000-8000-0000000cc002"
    const adj = (id: string, brokerage: string, approval: string) => ({ id, brokerage_id: brokerage, offer_id: O, transaction_id: null, is_active: true, applies_to: "gross", direction: "credit", approval_status: approval, value: 2000, value_type: "flat", recipient_type: "buyer" })
    const s = memSupabase({ commission_adjustments: [adj("c-approved", B, "approved"), adj("c-requested", B, "requested"), adj("c-foreign", B2, "approved")] }, { uuidIds: true })
    const r = await quiet(async () => conc.mod!.anchorOfferConcessionsToTransaction(s, { brokerageId: B, offerIds: [O], transactionId: TX })) as Record<string, any>
    const rows = s.tables.commission_adjustments ?? []
    const mine = rows.filter((x) => x.brokerage_id === B), foreign = rows.find((x) => x.id === "c-foreign") ?? {}
    return { ok: r.ok && r.unavailable !== true && mine.every((x) => x.transaction_id === TX && x.offer_id === O) && foreign.transaction_id === null && JSON.stringify(r.unauthorized ?? []).includes("c-requested") && !JSON.stringify(r.unauthorized ?? []).includes("c-approved"), evidence: r.ok ? `moved ${r.moved}; offer kept ${mine.every((x) => x.offer_id === O)}; unauthorized ${JSON.stringify((r.unauthorized ?? []).map((u: { id: string }) => u.id))}; other brokerage untouched ${foreign.transaction_id === null}` : String(r.error) }
  })

  // ── 9 · files are not the database (CLAUDE.md §3): lane 145C's migrations are applied by the integrator, never by a lane ──
  const cMigs = wave145Migrations().filter((m) => m.lane === "145C")
  if (cMigs.length) {
    const { claimOf } = await import("../migration-status")
    const states = cMigs.map((m) => `${m.file.split("/").pop()}: ${claimOf(m.sql)}`)
    c.pendingOwner("145C", "THE AGREEMENT RECORDS ARE LIVE (rulings 3–9): every lane-145C migration (agents.start_date + its trigger, client_agreement_fees, referral agreements, offer-anchored concessions) reads 'applied'", cMigs.every((m) => claimOf(m.sql) === "applied"), "Integrator: apply lane 145C's m858–m861 through the MCP in order, regenerate the schema caches and the vocabulary cache (new CHECKs), then stamp line 1 applied — until then the doors refuse live with the migration named (lane 145C requirement: 'm858 … is not applied')", states.join(", "))
  }

  c.blind("In memory: the engine's eleven stages run for real on the 144 fixture shape; the m812 version trigger (which writes agent_commission_profile_versions in production) is modelled by seeding the versions, and the m858 database rules (the start-date and profile triggers) are NOT modelled — the code door's refusals are what is driven. Documents' signature_completeness is seeded — no e-sign provider is reached. The addendum's compliance re-review is a recorder seam (lane 145C's published consequenceDeps); the closing comparison of the five layers is driven only through the attestation door. Ruling 5's 'never also deducted from the agent's commission' half is not driven here (lane 145C's test:agreement-waterfall). Steps whose door lane 145C has not published stay red-awaiting-lane-145C; their evidence names what HEAD carries.")
  let deleted: Array<{ table: string; deleted: number }> = [], residual = 0, mismatches: string[] = []
  for (const s of svcs) {
    const bid = tenants.find((t) => (s.tables.brokerages ?? []).some((b) => b.id === t)) ?? null
    const cl2 = await cleanupCanary(s, bid)
    deleted = [...deleted, ...cl2.cleanup]; residual += cl2.residual; mismatches = [...mismatches, ...cl2.mismatches]
  }
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, `${deleted.reduce((n, x) => n + Math.max(0, x.deleted), 0)} rows${mismatches.length ? `; ${mismatches.join("; ")}` : ""}`)
  return c.report(deleted, residual)
}
