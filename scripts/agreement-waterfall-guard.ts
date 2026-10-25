#!/usr/bin/env tsx
/**
 * scripts/agreement-waterfall-guard.ts   (npm run test:agreement-waterfall)
 * ─────────────────────────────────────────────────────────────────────────
 * Wave 143, lane 143C — EFFECTIVE-DATED AGREEMENTS · THE DETERMINISTIC WATERFALL · REFERRAL PAYOUTS · THE CDA'S PAYEES ·
 * THE FUNDS-RECEIVED GATE. Owner rulings (2026-10-23), proved as RULES (no migration is pinned by number, no chain position
 * is asserted, every absence has a POSITIVE CONTROL and every code-token scan reads STRIPPED source — CLAUDE.md §2):
 *
 *   A. THE AGREEMENT IN FORCE ON THE DEAL'S DATE — "calculations use the agreement applicable to the transaction's period,
 *      never today's percentage on a historic deal". The REAL engine (lib/commission/engine.ts calculateCommission, all
 *      eleven stages) runs in memory: an August deal keeps the August split after the split was changed in September;
 *      the legacy live read is shown to price it wrongly (the control). The agreement used — version, date, source, the
 *      signed record of the period — is frozen in commission_calculations.engine_inputs and one ledger row.
 *   B. THE TEAM'S TERMS AND MEMBERS FOR THE PERIOD — judged on the deal's date, not the wall clock.
 *   C. THE WATERFALL CONSERVES — an AGENT concession (a gross adjustment: the listing agreement's agreed commission credit to
 *      the seller — owner ruling 4, wave 144; a SELLER concession never touches commission) no longer breaks the identity or persists a
 *      refused row; the gross of record foots to the distributions.
 *   D. REFERRAL PAYOUTS ARE DEDUCTIONS — the agreed fee comes off the top before the split, conserved, linked to ONE
 *      deal (compare-and-swap), idempotent on a re-run; the free-standing post-close booking is gone.
 *   E. THE CDA NAMES EVERY PAYEE — cdaWaterfallContext speaks the LIVE distribution_type vocabulary (the old spellings
 *      "team" / "revenue_share" are refused by the database), a referral line exists, a voided row carries no money.
 *   F. PAYOUT ONLY FROM RECEIVED FUNDS — fail closed, an advance needs a stated reason kept as evidence; recording a
 *      payout never touches the cap ledger (the second, wrong writer is gone).
 *   G. PRE-APPLY HONESTY — with m812 not applied the engine degrades to the live rows and SAYS so.
 *   H. THE MIGRATION AND THE REGISTRY.
 *
 * BLIND SPOTS (published beside the number): the engine runs against scripts/in-memory-supabase.ts, which models the
 * query grammar and update().select() counts but NOT RLS, triggers or CHECK constraints (the CHECK that refuses a
 * negative `entry` row is emulated by an explicit assertion); m812's SQL was proved on a scratch PostgreSQL 16 against
 * stub tables by the lane, not by this script; QuickBooks / Stripe / bank events are not exercised (no credentials).
 *
 * MAINTENANCE: domain `agreement_effective_dating` (finance_manager) — registry entry + package.json key are the
 * integrator's (lane notes).
 */
import "./canaries/_harness" // FIRST: registers the "@/lib/supabase/service" stub before any module that imports it
import { canaryClient, setSvc, uuid } from "./canaries/_harness"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))
/** From `function name(` to the next top-level `export` (or EOF) in stripped source — enough to ask "does THIS function name X". */
function fnBody(src: string, name: string): string {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (at < 0) return ""
  const next = src.indexOf("\nexport ", at + 1)
  return next < 0 ? src.slice(at) : src.slice(at, next)
}
const cents = (n: unknown) => Math.round(Number(n) * 100)

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
interface Deal {
  B: string; A: string; U: string; T: string; C: string
  close: string
  versions?: Array<{ effective_from: string; split: number; id?: string }>
  liveSplit: number
  adjustments?: Array<Record<string, unknown>>
  referrals?: Array<Record<string, unknown>>
  signed?: Array<Record<string, unknown>>
  extra?: Record<string, Array<Record<string, unknown>>>
  price?: number
}
function seedDeal(d: Deal) {
  return {
    brokerages: [{ id: d.B, revenue_share_enabled: false }],
    agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null }],
    transactions: [{ id: d.T, brokerage_id: d.B, agent_id: d.A, purchase_price: d.price ?? 400_000, commission_percentage: 3, close_date: d.close, status: "closed", contact_id: d.C }],
    commission_structures: [{ id: uuid(), brokerage_id: d.B, is_default: true, is_active: true, base_percentage: 3 }],
    agent_commission_profiles: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, is_active: true, split_percent: d.liveSplit, effective_date: "2026-01-01" }],
    agent_commission_profile_versions: (d.versions ?? []).map((v) => ({ id: v.id ?? uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: v.effective_from, terms: { split_percent: v.split, is_active: true }, recorded_at: `${v.effective_from}T00:00:00Z` })),
    commission_adjustments: (d.adjustments ?? []).map((a) => ({ id: uuid(), transaction_id: d.T, is_active: true, ...a })),
    referrals: d.referrals ?? [],
    contract_signatures: d.signed ?? [],
    ...(d.extra ?? {}),
  }
}
async function runEngine(seed: Record<string, Array<Record<string, unknown>>>, d: Deal, opts: Parameters<typeof canaryClient>[1] = {}, mode: "final" | "preview" = "final") {
  const svc = canaryClient(seed as never, opts)
  setSvc(svc)
  const { calculateCommission } = await import("../lib/commission/engine")
  const origWarn = console.warn
  console.warn = () => {}
  try {
    const r = await calculateCommission({ transactionId: d.T, brokerageId: d.B, calculationMode: mode, triggeredBy: null })
    return { r, svc }
  } finally { console.warn = origWarn }
}
const newDeal = (over: Partial<Deal> = {}): Deal => ({ B: uuid(), A: uuid(), U: uuid(), T: uuid(), C: uuid(), close: "2026-08-15", liveSplit: 85, ...over })
const rows = (svc: ReturnType<typeof canaryClient>, t: string) => (svc.tables[t] ?? []) as Array<Record<string, any>>

async function main() {
  // Library modules are imported AFTER the harness has registered its resolve hooks (a static import would link them first).
  const { agreementAsOf, memberInEffectOn, loadAgentAgreementAsOf, loadTeamTermsAsOf } = await import("../lib/commission/agreement-terms")
  const { agreedReferralPct, referralFeeCents, pickReferralForDeal } = await import("../lib/commission/referral-payout")
  const { payoutFundsGate } = await import("../lib/commission/ledger-sync")
  const { cdaWaterfallContext } = await import("../lib/transactions/cda-template-fields")
  const { CDA_WATERFALL_KEYS } = await import("../lib/transactions/cda-field-classifier")
  const { cdaPayeesFromDistributions } = await import("../lib/transactions/cda-payees")
  const { composeCdaDisbursementLines } = await import("../lib/transactions/deal-vendor-notify")
  // ══ A · the agreement in force on the deal's date ═══════════════════════════════════════════════
  console.log("[A · the agreement in force on the DEAL'S date — the rules, through the loader the engine calls]")
  check("the deal's date is its close date; an unclosed deal falls to the estimated close, then the contract date, then today — and the SOURCE says which",
    agreementAsOf({ close_date: "2026-08-15", estimated_close_date: "2026-09-01" }, "2026-10-23").source === "close_date"
    && agreementAsOf({ estimated_close_date: "2026-09-01T00:00:00Z", contract_date: "2026-07-01" }, "2026-10-23").date === "2026-09-01"
    && agreementAsOf({ contract_date: "2026-07-01" }, "2026-10-23").source === "contract_date"
    && agreementAsOf(null, "2026-10-23").source === "today_fallback")
  // The rules are module-private (no export exists only for a proof - scripts/orphan-export-guard.ts counts those): they are
  // exercised exactly as the engine reaches them, through loadAgentAgreementAsOf over the in-memory client.
  const { memSupabase } = await import("./in-memory-supabase")
  const AX = "agent-x", BX = "brk-x"
  interface VerSeed { id: string; effective_from: string; terms: Record<string, unknown>; recorded_at: string }
  const agentAt = async (o: { versions?: VerSeed[]; live?: Record<string, unknown> | null; signed?: Array<Record<string, unknown>>; noTable?: boolean }, date: string) => {
    const mem = memSupabase({
      agent_commission_profile_versions: (o.versions ?? []).map((v) => ({ agent_id: AX, brokerage_id: BX, ...v })),
      agent_commission_profiles: o.live ? [{ agent_id: AX, brokerage_id: BX, ...o.live }] : [],
      contract_signatures: (o.signed ?? []).map((r) => ({ agent_id: AX, brokerage_id: BX, contract_type: "commission_agreement", ...r })),
    }, o.noTable ? { missingTables: ["agent_commission_profile_versions"] } : {})
    return loadAgentAgreementAsOf(mem as never, { brokerageId: BX, agentId: AX, asOf: { date, source: "close_date" } })
  }
  const V: VerSeed[] = [
    { id: "v1", effective_from: "2026-01-01", terms: { split_percent: 70, is_active: true }, recorded_at: "2026-01-01T00:00:00Z" },
    { id: "v2", effective_from: "2026-09-01", terms: { split_percent: 85, is_active: true }, recorded_at: "2026-09-01T00:00:00Z" },
    { id: "v2b", effective_from: "2026-09-01", terms: { split_percent: 87, is_active: true }, recorded_at: "2026-09-01T09:00:00Z" },
  ]
  check("the latest effective_from <= the deal's date wins; a same-day tie goes to the later recording", (await agentAt({ versions: V }, "2026-08-31")).versionId === "v1" && (await agentAt({ versions: V }, "2026-09-01")).versionId === "v2b")
  const before = await agentAt({ versions: V }, "2025-12-01")
  check("a deal that predates ALL history gets the EARLIEST version (said so), never the newest", before.versionId === "v1" && before.source === "version_before_history" && before.findings.some((f) => /earliest recorded/.test(f)))
  const rv = await agentAt({ versions: V, live: { split_percent: 87 } }, "2026-08-15")
  check("the AUGUST deal prices on the 70 % version although the live profile says 87", rv.source === "version" && rv.terms?.split_percent === 70 && rv.versionId === "v1" && rv.asOf === "2026-08-15" && rv.asOfSource === "close_date")
  const noTable = await agentAt({ noTable: true, live: { split_percent: 87, effective_date: "2026-01-01" } }, "2026-08-15")
  check("history table unavailable (m812 not applied) -> the live profile, SAID; identity columns are not terms", noTable.source === "live_profile" && noTable.terms?.split_percent === 87 && !("agent_id" in (noTable.terms ?? {})) && !("effective_date" in (noTable.terms ?? {})) && noTable.findings.some((f) => /m812 not applied/.test(f)))
  check("history table present but empty for this agent -> the live profile, said differently", (await agentAt({ live: { split_percent: 60 } }, "2026-08-15")).findings.some((f) => /no agreement history is recorded/.test(f)))
  check("no terms anywhere -> none (null terms, a finding)", await (async () => { const r = await agentAt({}, "2026-08-15"); return r.source === "none" && r.terms === null && r.findings.length > 0 })())
  check("an INACTIVE agreement in force prices as no agreement (the is_active=true read it replaces)", (await agentAt({ versions: [{ id: "vi", effective_from: "2026-01-01", terms: { split_percent: 70, is_active: false }, recorded_at: "2026-01-01T00:00:00Z" }] }, "2026-08-15")).terms === null)
  const signedRows = [
    { id: "s0", esign_status: "pending", fully_signed_at: null, field_values: {} },
    { id: "s1", esign_status: "fully_signed", fully_signed_at: "2026-01-05T10:00:00Z", document_url: "u1", field_values: { split_percent: "70%" } },
    { id: "s2", esign_status: "fully_signed", fully_signed_at: "2026-09-02T10:00:00Z", document_url: "u2", field_values: { split_percent: "85" } },
  ]
  const sOk = await agentAt({ versions: V, signed: signedRows }, "2026-08-15")
  check("the SIGNED agreement of record is the latest FULLY SIGNED one executed on/before the deal's date (a pending one and a later one do not count; none before the first signing)",
    sOk.signedAgreement?.id === "s1" && sOk.signedAgreement.documentUrl === "u1" && (await agentAt({ versions: V, signed: signedRows }, "2025-01-01")).signedAgreement === null)
  const sBad = await agentAt({ versions: V, signed: [{ ...signedRows[1], field_values: { split_percent: "75" } }] }, "2026-08-15")
  check("a signed form that states a term under its canonical key AND disagrees with the applied term is surfaced as a finding, never silently overridden",
    sOk.signedFieldMismatches.length === 0 && sBad.signedFieldMismatches.length === 1 && sBad.terms?.split_percent === 70 && sBad.findings.some((f) => /reconcile the profile/.test(f)))
  check("POSITIVE CONTROL: keys the brokerage named differently are NOT interpreted (no false accusation from a tenant-defined field)",
    (await agentAt({ versions: V, signed: [{ ...signedRows[1], field_values: { "Agent Commission": "99" } }] }, "2026-08-15")).signedFieldMismatches.length === 0
    && (await agentAt({ versions: V, signed: [{ ...signedRows[1], field_values: { split_percent: "99" } }] }, "2026-08-15")).signedFieldMismatches.length === 1)
  const refusedLoad = await (async () => { try { await loadAgentAgreementAsOf(memSupabase({}, { refuse: { agent_commission_profile_versions: "permission denied" } }) as never, { brokerageId: BX, agentId: AX, asOf: { date: "2026-08-15", source: "close_date" } }); return "no throw" } catch (e) { return String(e) } })()
  check("a REAL refusal of the history read throws (never silently the live percentage)", /history read refused/.test(refusedLoad))

  console.log("\n[A · the REAL engine, in memory — an August deal after a September split change]")
  const hist = newDeal({ close: "2026-08-15", liveSplit: 85, versions: [{ effective_from: "2026-01-01", split: 70, id: "ver-jan" }, { effective_from: "2026-09-01", split: 85, id: "ver-sep" }], signed: [] })
  hist.signed = [{ id: "sig-1", brokerage_id: hist.B, agent_id: hist.A, contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2026-01-05T10:00:00Z", document_url: "https://doc.example/ica.pdf", field_values: { split_percent: "70" } }]
  const old = await runEngine(seedDeal(hist), hist)
  check("the August deal (gross $12,000) pays the agent 70 % = $8,400.00 — the split IN FORCE on 2026-08-15", old.r.success && cents(old.r.net_to_agent) === 840_000 && cents(old.r.net_to_brokerage) === 360_000, JSON.stringify(old.r).slice(0, 200))
  const nu = newDeal({ close: "2026-09-15", liveSplit: 85, versions: [{ effective_from: "2026-01-01", split: 70 }, { effective_from: "2026-09-01", split: 85 }] })
  const newer = await runEngine(seedDeal(nu), nu)
  check("the SEPTEMBER deal (same price) pays 85 % = $10,200.00 — the new split applies from its date", newer.r.success && cents(newer.r.net_to_agent) === 1_020_000, JSON.stringify(newer.r).slice(0, 200))
  const { getDefaultCommissionStructure } = await import("../lib/brokerage/get-default-commission-structure")
  setSvc(canaryClient(seedDeal(hist) as never))
  const legacy = await getDefaultCommissionStructure(hist.B, hist.A, 3)
  check("POSITIVE CONTROL: the legacy live read (what the engine did at HEAD) prices the SAME August deal at 85 % — today's percentage on a historic deal — which is exactly the defect the version lookup removes", Math.round(legacy.splitDecimal * 100) === 85)
  const calc = rows(old.svc, "commission_calculations")[0]
  const ei = calc?.engine_inputs as Record<string, any> | undefined
  check("the agreement used is FROZEN on the calculation: version id, effective_from, the as-of date and WHICH column decided it, the signed agreement of record, the applied split",
    !!ei && ei.agreement?.source === "version" && ei.agreement?.version_id === "ver-jan" && ei.agreement?.effective_from === "2026-01-01" && ei.agreement?.as_of === "2026-08-15" && ei.agreement?.as_of_source === "close_date"
    && ei.agreement?.signed_agreement?.id === "sig-1" && ei.applied?.agent_split_percent === 70 && Number(calc.total_commission) === 12_000, JSON.stringify(ei).slice(0, 300))
  const ledger = rows(old.svc, "agent_action_ledger").filter((l) => l.action === "finance.commission.calculated")
  check("LAW 5: exactly one agent_action_ledger row for the calculation (who/why/evidence), idempotent on the commission", ledger.length === 1 && /commission-calc:/.test(String(ledger[0].idempotency_key)))
  const again = await (async () => { setSvc(old.svc); const { calculateCommission } = await import("../lib/commission/engine"); return calculateCommission({ transactionId: hist.T, brokerageId: hist.B, calculationMode: "final", triggeredBy: null }) })()
  check("IDEMPOTENT: a second final run returns the posted ledger — no second summary, distribution set, snapshot or ledger row",
    again.success && rows(old.svc, "agent_commissions").length === 1 && rows(old.svc, "commission_calculations").length === 1 && rows(old.svc, "commission_distributions").length === 2)
  const mism = newDeal({ close: "2026-08-15", liveSplit: 85, versions: [{ effective_from: "2026-01-01", split: 70 }], signed: [{ id: "sig-x", agent_id: "", contract_type: "commission_agreement", esign_status: "fully_signed", fully_signed_at: "2026-01-05T10:00:00Z", field_values: { split_percent: "75" } }] })
  ;(mism.signed![0] as Record<string, unknown>).agent_id = mism.A; (mism.signed![0] as Record<string, unknown>).brokerage_id = mism.B
  const mis = await runEngine(seedDeal(mism), mism)
  const mei = rows(mis.svc, "commission_calculations")[0]?.engine_inputs as Record<string, any>
  check("a signed form that disagrees with the stored term: the engine still applies the STORED 70 % (never silently the document's 75 %) and the mismatch is on the record for a human", mis.r.success && cents(mis.r.net_to_agent) === 840_000 && mei?.agreement?.signed_field_mismatches?.length === 1)

  // ══ B · team terms + members for the period ══════════════════════════════════════════════════
  console.log("\n[B · the team's terms and members are judged on the deal's date]")
  const TV = [
    { effective_date: "2026-02-01", team_split_type: "percent", team_split_value: 25, cap_amount: null, is_active: true },
    { effective_date: "2026-09-01", team_split_type: "percent", team_split_value: 30, cap_amount: null, is_active: true },
  ]
  const teamAt = async (versions: Array<Record<string, unknown>>, liveTeam: Record<string, unknown> | null, date: string, signed: Array<Record<string, unknown>> = []) => {
    const mem = memSupabase({
      team_commission_profiles: versions.map((v) => ({ team_id: "team-x", brokerage_id: BX, ...v })),
      contract_signatures: signed.map((r) => ({ team_id: "team-x", agent_id: AX, brokerage_id: BX, contract_type: "team_agreement", ...r })),
    })
    return loadTeamTermsAsOf(mem as never, { brokerageId: BX, teamId: "team-x", agentId: AX, asOf: date, liveTeam: liveTeam as never })
  }
  check("the August deal gets the 25 % team terms; the October deal 30 %", (await teamAt(TV, null, "2026-08-15"))?.splitValue === 25 && (await teamAt(TV, null, "2026-10-01"))?.splitValue === 30)
  check("team terms stay INERT before their first effective date (the standing isAgreementEffective rule), and an inactive version is skipped",
    (await teamAt(TV, null, "2026-01-15")) === null && (await teamAt([{ ...TV[0], is_active: false }], null, "2026-08-15")) === null)
  check("no history -> the live team row judged on the DEAL'S date (a live row effective 2026-09-01 is inert for an August deal; a flat split reads team_split_value)",
    (await teamAt([], { team_split_type: "percent", team_split_percent: 30, terms_effective_date: "2026-09-01" }, "2026-08-15")) === null
    && (await teamAt([], { team_split_type: "flat", team_split_value: 500, team_split_percent: 9, terms_effective_date: "2026-01-01" }, "2026-08-15"))?.splitValue === 500)
  const tSigned = await teamAt(TV, null, "2026-08-15", [{ id: "t-s1", esign_status: "fully_signed", fully_signed_at: "2026-02-02T10:00:00Z", document_url: "tu1", field_values: {} }])
  check("the agent's SIGNED team agreement of record is cited beside the team terms (cited, never parsed into money)", tSigned?.signedAgreement?.id === "t-s1" && tSigned.source === "version")
  check("memberInEffectOn: a dated member who has since LEFT still counts on a deal from their period; one who has not started does not; an undated row keeps its is_active reading",
    memberInEffectOn({ effective_from: "2026-01-01", effective_to: "2026-06-30", is_active: false }, "2026-03-01") && !memberInEffectOn({ effective_from: "2026-01-01", effective_to: "2026-06-30", is_active: false }, "2026-08-15")
    && !memberInEffectOn({ effective_from: "2026-09-01", is_active: true }, "2026-08-15") && memberInEffectOn({ is_active: true }, "2026-08-15") && !memberInEffectOn({ is_active: false }, "2026-08-15"))

  console.log("\n[B · the real engine: the team lead's cut follows the version in force]")
  const mkTeam = (close: string) => {
    const d = newDeal({ close, liveSplit: 70, versions: [{ effective_from: "2026-01-01", split: 70 }] })
    const TEAM = uuid(), LEAD_U = uuid(), LEAD_A = uuid()
    d.extra = {
      agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: TEAM }, { id: LEAD_A, brokerage_id: d.B, user_id: LEAD_U, team_id: TEAM }],
      teams: [{ id: TEAM, brokerage_id: d.B, team_lead_id: LEAD_U, team_split_type: "percent", team_split_percent: 30, team_split_value: null, terms_effective_date: "2026-09-01", cap_amount: null }],
      team_commission_profiles: TV.map((v) => ({ id: uuid(), team_id: TEAM, brokerage_id: d.B, ...v })),
    }
    return { d, LEAD_A }
  }
  const t1 = mkTeam("2026-08-15"); const r1 = await runEngine(seedDeal(t1.d), t1.d)
  const t2 = mkTeam("2026-10-05"); const r2 = await runEngine(seedDeal(t2.d), t2.d)
  const leadCut = (x: Awaited<ReturnType<typeof runEngine>>, lead: string) => rows(x.svc, "commission_distributions").filter((r) => r.distribution_type === "team_member" && r.agent_id === lead).reduce((s, r) => s + cents(r.calculated_amount), 0)
  check("the AUGUST deal: the lead takes 25 % of the agent's $8,400 = $2,100.00 (the version in force), not today's 30 %", r1.r.success && leadCut(r1, t1.LEAD_A) === 210_000 && cents(r1.r.net_to_agent) === 630_000, JSON.stringify(r1.r).slice(0, 220))
  check("the OCTOBER deal: 30 % = $2,520.00", r2.r.success && leadCut(r2, t2.LEAD_A) === 252_000, JSON.stringify(r2.r).slice(0, 220))

  // ══ C · the waterfall conserves ══════════════════════════════════════════════════════════════
  console.log("\n[C · an agent concession (the listing agreement's commission credit to the seller) no longer breaks the identity]")
  const cr = newDeal({ close: "2026-08-15", liveSplit: 70, versions: [{ effective_from: "2026-01-01", split: 70 }], adjustments: [{ applies_to: "gross", value_type: "flat", value: 500, direction: "credit", notes: "listing-agreement commission concession" }] })
  const credit = await runEngine(seedDeal(cr), cr)
  const dist = rows(credit.svc, "commission_distributions")
  const sumRows = dist.reduce((s, r) => s + cents(r.calculated_amount), 0)
  check("a $500 CREDIT on $12,000 posts: summary gross = the $11,500 the brokerage RECEIVES, agent $8,050 / brokerage $3,450", credit.r.success && cents(credit.r.gross_commission) === 1_150_000 && cents(credit.r.net_to_agent) === 805_000 && cents(credit.r.net_to_brokerage) === 345_000, JSON.stringify(credit.r).slice(0, 220))
  check("the persisted distributions foot to the gross of record EXACTLY (11,500.00) and NO negative `entry` row exists (the live CHECK commission_distributions_calculated_amount_check would refuse one)", sumRows === 1_150_000 && dist.every((r) => cents(r.calculated_amount) >= 0 && (r.entry_type ?? "entry") === "entry"), `sum ${sumRows}`)
  check("the concession is on the record: commission_calculations carries the gross before it ($12,000), the signed concession (-500) and total_commission = the gross of record (11,500)",
    (() => { const c = rows(credit.svc, "commission_calculations")[0]; const b = c?.breakdown_json; return Number(c?.total_commission) === 11_500 && b?.gross_commission_before_adjustments === 12_000 && b?.gross_adjustments?.[0]?.signed_amount === -500 })())
  check("POSITIVE CONTROL: the identity the engine ENFORCED at HEAD (adjustment row counted in the distributed sum) mismatches by exactly the concession — 11,000.00 vs 11,500.00 — which is why every deal with a concession threw",
    sumRows + cents(-500) === 1_100_000 && sumRows !== 1_100_000)
  const sur = newDeal({ close: "2026-08-15", liveSplit: 70, versions: [{ effective_from: "2026-01-01", split: 70 }], adjustments: [{ applies_to: "gross", value_type: "percent", value: 2.5, direction: "surcharge" }] })
  const surcharge = await runEngine(seedDeal(sur), sur)
  check("a 2.5 % SURCHARGE direction is honoured (gross $12,300) and foots", surcharge.r.success && cents(surcharge.r.gross_commission) === 1_230_000 && rows(surcharge.svc, "commission_distributions").reduce((s, r) => s + cents(r.calculated_amount), 0) === 1_230_000)

  // ══ D · referral payouts are deductions ══════════════════════════════════════════════════════
  console.log("\n[D · referral payouts: off the top, conserved, linked to one deal]")
  check("agreedReferralPct: only 0 < pct <= 100 is an agreement; blank/0/negative/>100/NaN are NOT (never fabricated)", agreedReferralPct(25) === 25 && agreedReferralPct("12.5") === 12.5 && [null, "", 0, -3, 101, "x"].every((v) => agreedReferralPct(v) === null))
  check("referralFeeCents: 25 % of $12,000.00 = 300,000 cents; one rounding at the boundary; a non-positive base pays nothing", referralFeeCents(1_200_000, 25) === 300_000 && referralFeeCents(1_001, 33.33) === 334 && referralFeeCents(0, 25) === 0 && referralFeeCents(-5, 25) === 0)
  const RA = "agent-recv", RR = "agent-ref", TXN = "txn-1"
  const base = (o: Record<string, unknown>) => ({ id: "r", agent_id: RA, referring_agent_id: RR, referral_fee_pct: 25, status: "received", transaction_id: null, created_at: "2026-07-01T00:00:00Z", ...o })
  check("pickReferralForDeal: a referral already linked to THIS deal wins; else the newest unlinked non-lost one",
    pickReferralForDeal([base({ id: "a" }), base({ id: "b", transaction_id: TXN })], { transactionId: TXN, producingAgentId: RA }).alreadyLinked === true
    && pickReferralForDeal([base({ id: "old", created_at: "2026-01-01T00:00:00Z" }), base({ id: "new" }), base({ id: "lost", status: "lost", created_at: "2026-12-01T00:00:00Z" })], { transactionId: TXN, producingAgentId: RA }).referral?.id === "new")
  check("a referral consumed by ANOTHER deal is not available; an external-partner referral (no referring agent) is untouched",
    pickReferralForDeal([base({ transaction_id: "other-txn" })], { transactionId: TXN, producingAgentId: RA }).referral === null
    && pickReferralForDeal([base({ referring_agent_id: null })], { transactionId: TXN, producingAgentId: RA }).referral === null)
  const selfRef = pickReferralForDeal([base({ referring_agent_id: RA })], { transactionId: TXN, producingAgentId: RA })
  const otherRecv = pickReferralForDeal([base({ agent_id: "someone-else" })], { transactionId: TXN, producingAgentId: RA })
  const noPct = pickReferralForDeal([base({ referral_fee_pct: null })], { transactionId: TXN, producingAgentId: RA })
  check("unsafe referrals are SKIPPED WITH A FINDING, never paid on a guess: self-referral, a different receiving agent, no agreed percent", selfRef.referral === null && otherRecv.referral === null && noPct.referral === null && [selfRef, otherRecv, noPct].every((p) => p.findings.length === 1))

  const rf = newDeal({ close: "2026-08-15", liveSplit: 70, versions: [{ effective_from: "2026-01-01", split: 70 }] })
  const REFERRER = uuid(), REF = uuid()
  rf.referrals = [{ id: REF, brokerage_id: rf.B, agent_id: rf.A, referring_agent_id: REFERRER, referral_fee_pct: 25, status: "received", referred_contact_id: rf.C, transaction_id: null, created_at: "2026-07-01T00:00:00Z" }]
  rf.extra = { agents: [{ id: rf.A, brokerage_id: rf.B, user_id: rf.U, team_id: null }, { id: REFERRER, brokerage_id: rf.B, user_id: uuid(), team_id: null }] }
  const ref = await runEngine(seedDeal(rf), rf)
  const rd = rows(ref.svc, "commission_distributions")
  const refRow = rd.filter((r) => r.distribution_type === "referral")
  check("the referral fee is a DEDUCTION: $3,000.00 (25 % of $12,000) to the REFERRING agent, with the commission's id, funded by the deal; the rest splits 70/30 -> agent $6,300.00 / brokerage $2,700.00",
    ref.r.success && refRow.length === 1 && refRow[0].agent_id === REFERRER && cents(refRow[0].calculated_amount) === 300_000 && !!refRow[0].commission_id && refRow[0].source_of_funds === "brokerage"
    && cents(ref.r.net_to_agent) === 630_000 && cents(ref.r.net_to_brokerage) === 270_000, JSON.stringify(ref.r).slice(0, 240))
  check("the identity FOOTS with the referral in it: referral + agent + brokerage = the $12,000.00 of record", rd.reduce((s, r) => s + cents(r.calculated_amount), 0) === 1_200_000)
  check("the referral is LINKED to the deal (compare-and-swap) and the snapshot says so", rows(ref.svc, "referrals")[0].transaction_id === rf.T && (rows(ref.svc, "commission_calculations")[0].engine_inputs as any).referral.link.referralId === REF)
  const T2 = uuid()
  ref.svc.tables.transactions.push({ id: T2, brokerage_id: rf.B, agent_id: rf.A, purchase_price: 400_000, commission_percentage: 3, close_date: "2026-09-20", status: "closed", contact_id: rf.C })
  setSvc(ref.svc)
  const { calculateCommission } = await import("../lib/commission/engine")
  const warn = console.warn; console.warn = () => {}
  const second = await calculateCommission({ transactionId: T2, brokerageId: rf.B, calculationMode: "final", triggeredBy: null })
  console.warn = warn
  check("ONE referral pays on ONE deal: a second closing for the same contact books NO second fee (agent keeps the full 70 % = $8,400.00)", second.success && cents(second.net_to_agent) === 840_000 && rows(ref.svc, "commission_distributions").filter((r) => r.distribution_type === "referral").length === 1)
  const prev = await runEngine(seedDeal(rf), rf, {}, "preview")
  check("PREVIEW shows the referral deduction without persisting or linking anything", prev.r.preview === true && (prev.r.distributions ?? []).some((x) => x.distribution_type === "referral") && rows(prev.svc, "referrals")[0].transaction_id === null && rows(prev.svc, "commission_distributions").length === 0)
  const closer = code("lib/agents/referral-closer.ts")
  const BOOKS_FEE = /from\(\s*["']commission_distributions["']\s*\)/
  check("the free-standing post-close booking is GONE from referral-closer (one writer of distribution_type 'referral': the waterfall stage)", !BOOKS_FEE.test(closer) && /distribution_type:\s*['"]referral['"]/.test(code("lib/commission/waterfall/03b-referral-deduction.ts")))
  check("POSITIVE CONTROL: the finder recognises the removed pattern in a specimen", BOOKS_FEE.test(`await supabase.from("commission_distributions").insert({ distribution_type: "referral" })`))

  // ══ E · the CDA names every payee ═══════════════════════════════════════════════════════════
  console.log("\n[E · the CDA's waterfall context speaks the LIVE vocabulary]")
  const liveTypes = CHECK_VOCABULARIES.commission_distributions.distribution_type
  check("the live CHECK admits team_member / residual / referral / fee — and REFUSES the spellings the old context read ('team', 'revenue_share'), which is why those CDA lines were blank on every deal",
    ["team_member", "residual", "referral", "fee"].every((t) => liveTypes.includes(t)) && !liveTypes.includes("team") && !liveTypes.includes("revenue_share"))
  const ctx = cdaWaterfallContext({ gross_commission: 12_000, agent_net: 6_300, brokerage_net: 2_700, distributions: [
    { distribution_type: "fee", calculated_amount: 100 }, { distribution_type: "team_member", calculated_amount: 1_000 }, { distribution_type: "residual", calculated_amount: 200 },
    { distribution_type: "referral", calculated_amount: 3_000 }, { distribution_type: "referral", calculated_amount: 999, status: "voided" }, { distribution_type: "agent", calculated_amount: 6_300 } ] })
  check("every live type maps to its line: fees 100, team_split 1,000, revenue_share 200, referral 3,000 (the VOIDED $999 referral row carries no money)", ctx.fees === 100 && ctx.team_split === 1_000 && ctx.revenue_share === 200 && ctx.referral === 3_000)
  check("a type with no rows reads null, never 0 (a blank is not 'matches')", cdaWaterfallContext({ gross_commission: 1, distributions: [] }).referral === null && cdaWaterfallContext({ gross_commission: 1 }).team_split === null)
  check("every key the context can return is in the ONE catalog the mapping editor and the classifier offer (no unbindable line)", Object.keys(ctx).every((k) => k in CDA_WATERFALL_KEYS))
  const editor = code("app/dashboard/admin/onboarding/components/os/cda-field-mapping-editor.tsx")
  check("the editor's own twin option list is gone: it derives from CDA_WATERFALL_KEYS (no literal `{ key: \"gross_commission\"` list remains)", /CDA_WATERFALL_KEYS/.test(editor) && !/\{\s*key:\s*"gross_commission"/.test(editor))
  const payees = cdaPayeesFromDistributions([
    { distribution_type: "referral", calculated_amount: 3000, status: "paid", agent_id: "r1" },
    { distribution_type: "referral", calculated_amount: -500, status: "paid", agent_id: "r1" },
    { distribution_type: "referral", calculated_amount: 800, status: "voided", agent_id: "r2" },
    { distribution_type: "team_member", calculated_amount: 1000, status: "pending", agent_id: "t1" },
    { distribution_type: "agent", calculated_amount: 6300, status: "pending", agent_id: "a" }], new Map([["r1", "Riley Referrer"]]))
  check("cdaPayeesFromDistributions: the referral payee is named, a correction row nets (3,000 - 500 = 2,500), a voided row vanishes, the team share is summed, agent/brokerage rows are not payees",
    payees.referralPayouts.length === 1 && payees.referralPayouts[0].payee === "Riley Referrer" && payees.referralPayouts[0].amount === 2500 && payees.teamShare === 1000)
  const lines = composeCdaDisbursementLines({ grossCommission: 12000, agentNet: 6300, brokerageNet: 2700, referralPayouts: payees.referralPayouts, teamShare: payees.teamShare })
  check("the authorization title receives names the referral payee and the team share", lines.some((l) => /Referral fee payable to Riley Referrer: \$2,500/.test(l)) && lines.some((l) => /Team share: \$1,000/.test(l)) && composeCdaDisbursementLines({ grossCommission: 1, agentNet: 1, brokerageNet: 0 }).length === 3)
  const cdaSend = code("app/actions/cda-portal.ts")
  check("sendCdaToTitleAction reads the live payee rows on a TENANT-PINNED service read and STOPS on a refused read (an authorization missing a payee is not sent)",
    /cdaPayeesFromDistributions/.test(cdaSend) && /\.eq\("brokerage_id", cda\.brokerage_id\)\s*\n?\s*\.in\("distribution_type"/.test(cdaSend) && /cda_payees_read_refused/.test(cdaSend))

  // ══ F · payout only from received funds ═════════════════════════════════════════════════════
  console.log("\n[F · the funds-received gate]")
  check("payoutFundsGate: received -> ok; not received & no reason -> refused by name; reason < 5 chars -> refused; a stated reason -> an ADVANCE",
    payoutFundsGate({ deposit_received_at: "2026-10-01T00:00:00Z" }).ok === true && (() => { const g = payoutFundsGate({}); return !g.ok && /funds_not_received/.test(g.error) })()
    && !payoutFundsGate({}, "no").ok && (() => { const g = payoutFundsGate({}, "owner-approved bridge advance"); return g.ok && g.advance && g.reason === "owner-approved bridge advance" })())
  const KB = uuid(), KA = uuid(), KAU = uuid(), KADMIN = uuid(), KTX1 = uuid(), KTX2 = uuid(), KTX3 = uuid(), C_NO = uuid(), C_ADV = uuid(), C_OK = uuid(), CAPROW = uuid()
  const kernelSvc = canaryClient({
    brokerages: [{ id: KB, name: "Gate Brokerage" }],
    users: [{ id: KADMIN, email: "broker@gate.test", user_type: "broker_owner", brokerage_id: KB }, { id: KAU, email: "agent@gate.test", user_type: "agent", brokerage_id: KB }],
    agents: [{ id: KA, user_id: KAU, brokerage_id: KB, is_active: true }],
    transactions: [KTX1, KTX2, KTX3].map((id) => ({ id, brokerage_id: KB, agent_id: KA, status: "closed", close_date: "2026-08-15" })),
    agent_commissions: [
      { id: C_NO, brokerage_id: KB, agent_id: KA, transaction_id: KTX1, status: "approved", net_to_agent: 8400, deposit_received_at: null, payment_initiated_at: null },
      { id: C_ADV, brokerage_id: KB, agent_id: KA, transaction_id: KTX2, status: "approved", net_to_agent: 8400, deposit_received_at: null, payment_initiated_at: null },
      { id: C_OK, brokerage_id: KB, agent_id: KA, transaction_id: KTX3, status: "approved", net_to_agent: 8400, deposit_received_at: "2026-08-20T00:00:00Z", payment_initiated_at: null },
    ],
    agent_cap_tracking: [{ id: CAPROW, agent_id: KA, brokerage_id: KB, cap_amount: 20_000, cap_paid_to_date: 1_000, anniversary_start: "2026-01-01", anniversary_end: "2026-12-31" }],
  })
  setSvc(kernelSvc)
  const fin = await import("../lib/kernel/financial")
  type Ctx = Parameters<typeof fin.markCommissionPaid>[0]["ctx"]
  const broker = { userId: KADMIN, agentId: null, brokerageId: KB, userType: "broker", platformRole: null, isTenantPrincipal: true } as unknown as Ctx
  const errLog = console.error; console.error = () => {}
  const noFunds = await fin.markCommissionPaid({ ctx: broker, commissionId: C_NO, brokerageId: KB, method: "check" })
  const initNo = await fin.initiateCommissionPayout({ ctx: broker, commissionId: C_NO, brokerageId: KB, method: "check" })
  check("FAIL CLOSED: neither recording nor initiating a payout works on a commission whose funds are not recorded as received — refused by name, the row unchanged", !noFunds.success && /funds_not_received/.test(noFunds.error ?? "") && !initNo.success && /funds_not_received/.test(initNo.error ?? "") && rows(kernelSvc, "agent_commissions").find((r) => r.id === C_NO)!.status === "approved")
  const adv = await fin.markCommissionPaid({ ctx: broker, commissionId: C_ADV, brokerageId: KB, method: "check", advanceReason: "owner approved a bridge advance pending the wire" })
  const advAct = rows(kernelSvc, "activities").filter((a) => a.activity_type === "commission_payout_advance")
  check("an ADVANCE with a stated reason pays and leaves the reason on the record (an activity naming who and why)", adv.success && advAct.length === 1 && /bridge advance/.test(String(advAct[0].description)) && JSON.parse(String(advAct[0].notes)).advanced_by === KADMIN)
  const okPaid = await fin.markCommissionPaid({ ctx: broker, commissionId: C_OK, brokerageId: KB, method: "check" })
  check("with the deposit recorded the payout goes through and writes NO advance evidence", okPaid.success && rows(kernelSvc, "activities").filter((a) => a.activity_type === "commission_payout_advance").length === 1)
  check("recording a payout NEVER touches the cap ledger (cap_paid_to_date stays 1,000 after two payouts — the second, wrong writer is gone; stage 11 owns the ledger)", Number(rows(kernelSvc, "agent_cap_tracking")[0].cap_paid_to_date) === 1_000)
  console.error = errLog
  const finSrc = code("lib/kernel/financial.ts")
  check("source: markCommissionPaid no longer names agent_cap_tracking (POSITIVE CONTROL: the finder sees it in the stage that owns the ledger)", !/agent_cap_tracking/.test(fnBody(finSrc, "markCommissionPaid")) && /agent_cap_tracking/.test(code("lib/commission/waterfall/11-validate-persist.ts")))

  // ══ G · pre-apply honesty ════════════════════════════════════════════════════════════════════
  console.log("\n[G · with m812 NOT applied the engine degrades to the live rows and says so]")
  const pre = newDeal({ close: "2026-08-15", liveSplit: 80 })
  const PREREF = uuid(), PREFER = uuid()
  pre.referrals = [{ id: PREREF, brokerage_id: pre.B, agent_id: pre.A, referring_agent_id: PREFER, referral_fee_pct: 10, status: "received", referred_contact_id: pre.C, created_at: "2026-07-01T00:00:00Z" }]
  pre.extra = { agents: [{ id: pre.A, brokerage_id: pre.B, user_id: pre.U, team_id: null }, { id: PREFER, brokerage_id: pre.B, user_id: uuid(), team_id: null }] }
  const warns: string[] = []
  const w0 = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.join(" ")) }
  const preSvc = canaryClient(seedDeal(pre) as never, { missingTables: ["agent_commission_profile_versions", "team_commission_profiles"], missingColumns: { referrals: ["transaction_id"] } })
  setSvc(preSvc)
  const eng = await import("../lib/commission/engine")
  const preR = await eng.calculateCommission({ transactionId: pre.T, brokerageId: pre.B, calculationMode: "final", triggeredBy: null })
  console.warn = w0
  check("the deal still calculates on the LIVE profile (80 %), with a referral fee of 10 % off the top: ($12,000 - $1,200) x 80 % = $8,640.00 to the agent", preR.success && cents(preR.net_to_agent) === 864_000, JSON.stringify(preR).slice(0, 200))
  check("and it SAYS so: history-unavailable and link-unavailable are printed and frozen in engine_inputs (never silent)", warns.some((x) => /m812 not applied/.test(x)) && (rows(preSvc, "commission_calculations")[0]?.engine_inputs as any)?.agreement?.source === "live_profile")
  const realRefusal = canaryClient(seedDeal(pre) as never, { refuse: { agent_commission_profile_versions: "permission denied" } })
  setSvc(realRefusal)
  const w1 = console.warn; console.warn = () => {}
  const refused = await eng.calculateCommission({ transactionId: pre.T, brokerageId: pre.B, calculationMode: "final", triggeredBy: null })
  console.warn = w1
  check("a REAL refusal of the history read is not 'unavailable': the calculation FAILS CLOSED rather than pricing today's percentage on a historic deal, and nothing was posted", refused.success === false && /history read refused/.test(refused.error ?? "") && rows(realRefusal, "commission_distributions").length === 0)

  console.log("\n[G · no agreement in force is a refusal, not a 0 % split]")
  const nb = newDeal({ close: "2026-08-15", liveSplit: 70 })
  const nbSeed = seedDeal(nb); nbSeed.agent_commission_profiles = []
  const noTerms = await runEngine(nbSeed, nb)
  check("FINAL with no commission terms on record for the agent: REFUSED by name (it would have posted the agent $0 and the brokerage 100 %), nothing posted",
    noTerms.r.success === false && /No commission agreement terms are in force/.test(noTerms.r.error ?? "") && rows(noTerms.svc, "agent_commissions").length === 0 && rows(noTerms.svc, "commission_distributions").length === 0, noTerms.r.error)
  const inactive = newDeal({ close: "2026-08-15", liveSplit: 70, versions: [{ effective_from: "2026-01-01", split: 70 }] })
  const inSeed = seedDeal(inactive); inSeed.agent_commission_profile_versions = [{ id: uuid(), agent_id: inactive.A, brokerage_id: inactive.B, effective_from: "2026-01-01", terms: { split_percent: 70, is_active: false }, recorded_at: "2026-01-01T00:00:00Z" }]
  const inactiveR = await runEngine(inSeed, inactive)
  check("an INACTIVE agreement in force on the date is no agreement: refused the same way", inactiveR.r.success === false && /No commission agreement terms are in force/.test(inactiveR.r.error ?? ""))
  const prevNo = await runEngine(nbSeed, nb, {}, "preview")
  check("a PREVIEW with no terms still runs (it posts nothing) so the broker can see what is missing", prevNo.r.success === true && prevNo.r.preview === true && rows(prevNo.svc, "commission_distributions").length === 0)

  // ══ H · migration + registry ═════════════════════════════════════════════════════════════════
  console.log("\n[H · the migration and the registry]")
  const dir = join(ROOT, "supabase/migrations")
  const mig = readdirSync(dir).filter((f) => /^m\d+-.*\.sql$/.test(f)).map((f) => ({ f, sql: readFileSync(join(dir, f), "utf8") })).find((m) => /CREATE TABLE IF NOT EXISTS public\.agent_commission_profile_versions/.test(m.sql))
  const sql = mig?.sql ?? ""
  check("one migration defines agent_commission_profile_versions and its first line states its apply status (WRITTEN, NOT APPLIED / APPLIED LIVE)", !!mig && /^-- (WRITTEN, NOT APPLIED|── APPLIED LIVE)/.test(sql))
  check("it creates the history WRITER (a trigger on agent_commission_profiles) and the team writer (a trigger on teams) — the readers' data has a source for every writer of the profile", /CREATE TRIGGER record_agent_commission_profile_version[\s\S]*?ON public\.agent_commission_profiles/.test(sql) && /CREATE TRIGGER record_team_commission_profile_version[\s\S]*?ON public\.teams/.test(sql))
  check("it gives the referral its deal link, and the history table no write policy (RLS enabled, SELECT only)", /ADD COLUMN IF NOT EXISTS transaction_id uuid REFERENCES public\.transactions/.test(sql) && /ENABLE ROW LEVEL SECURITY/.test(sql) && !/FOR (INSERT|UPDATE|DELETE|ALL)\b[^;]*agent_commission_profile_versions/.test(sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g, "")))
  const agreementSrc = code("lib/commission/agreement-terms.ts")
  const colsInCode = ["effective_from", "terms", "recorded_at", "agent_id", "brokerage_id"]
  check("every column the loader selects from the history table exists in the migration's CREATE TABLE", colsInCode.every((c) => new RegExp(`\\b${c}\\b`).test(sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.agent_commission_profile_versions"), sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS public.agent_commission_profile_versions"))))) && /agent_commission_profile_versions/.test(agreementSrc))
  check("NOTHING writes the history table from application code (the trigger is the only writer) — POSITIVE CONTROL: the finder recognises an insert in a specimen",
    !["lib", "app"].some((d) => walk(d).some((f) => /from\(\s*["']agent_commission_profile_versions["']\s*\)\s*\.(insert|update|upsert|delete)\(/.test(stripComments(readFileSync(f, "utf8")))))
    && /from\(\s*["']agent_commission_profile_versions["']\s*\)\s*\.(insert|update|upsert|delete)\(/.test(`svc.from("agent_commission_profile_versions").insert({})`))
  check("the table has a steward in the manager registry (TABLE_MANAGER)", /agent_commission_profile_versions:\s*"finance_manager"/.test(code("lib/kernel/manager-registry.ts")))
  // WAVE 144 (lane 144D): stages 03 and 03b now take the calculation mode (a held concession / partner fee refuses a FINAL),
  // so the order is asserted on the CALL, not on a literal argument list (the rule, not the waypoint).
  check("the engine wires stage 03b between 03 and 04, in that order", (() => { const e = code("lib/commission/engine.ts"); const a = e.search(/applyGrossAdjustments\(context\b/), b = e.search(/applyReferralDeduction\(context\b/), c = e.indexOf("splitAgentBrokerage(context)"); return a > 0 && b > a && c > b })())

  console.log("\nBLIND SPOTS: the engine ran against the in-memory client (no RLS, no triggers, no CHECK constraints — the negative-row CHECK is emulated by assertion); m812's SQL was proved on a")
  console.log("  scratch PostgreSQL 16 against stub tables by the lane (backfill, no-op save, same-day replace, re-dating, team flat/percent, null-tenant guard, FK cascade, idempotent re-run),")
  console.log("  not by this script; cap-window attribution is now the DEAL's cycle (wave 144 — proved by scripts/cap-cycle-guard.ts, not here), the brokerage default gross rate (commission_structures has no effective dates) and the")
  console.log("  team-lead anchor (teams.team_lead_id is current-only) are NOT effective-dated here; QuickBooks / Stripe / bank events are not exercised (no credentials).")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

function walk(dir: string): string[] {
  const out: string[] = []
  const abs = join(ROOT, dir)
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue
    const rel = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(rel))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(join(ROOT, rel))
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
