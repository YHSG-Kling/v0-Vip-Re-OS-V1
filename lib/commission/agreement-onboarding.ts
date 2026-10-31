// lib/commission/agreement-onboarding.ts — COMMISSION SETUP FROM THE SIGNED AGREEMENTS: AI/the paper PROPOSES, A HUMAN VERIFIES
// (wave 145, lane 145C; owner ruling 6, 2026-10-27).
//
// Owner, verbatim: "Each brokerage/team/agent can be different so maybe onboarding per tenant there should be questions on how
// they determine commission with caps/fees etc.? maybe go by the agent/team agreements and ask at closing if anything changed?"
// → read the signed agreements first; propose deterministic structured settings from them; a human verifies; the executed
// agreement stays the authority — answers configure or EXPLAIN it, never override it.
//
// SURVIVORS (CLAUDE.md §1) — nothing parallel:
//   · the terms record: agent_commission_profiles (+ its m812 history). verifyAgreementTerms below writes it — the SAME row the
//     admin terms editor (app/actions/admin/agent-profile.ts) writes — stamped with the executed agreement it was verified
//     against (m858 agreement_signature_id) and dated by that agreement's effective date, so the m812 version is the agreement's.
//   · the signed record: contract_signatures (m481/m858) — its field_values are what the brokerage typed into the form that was
//     signed (a deterministic source); a stored scan of the executed paper (documents, classification 'commission_agreement')
//     carries the doc kernel's AI extraction (lib/documents/scan-uploaded-document.ts) — a PROPOSAL source only, never applied
//     without a human.
//   · brokerage-level answers already have their own writers (setCommissionPayoutPolicyAction, the concession policy, the CDA
//     setup, the cap basis): the questions below NAME them; nothing here writes a brokerage column.
//   · the controlled-learning pattern (lane 144A's vocabulary proposal: propose → evaluate → a human approves → deterministic
//     promotion inside withActionLedger) is followed; lib/kernel/improvement-proposals.ts itself promotes TENANT POLICY keys only,
//     so per-agent contract terms ride the same shape on their own record: the proposal is reproducible from the signed record
//     (pure, below), the human's verification is the promotion, ledgered with what the human changed from the proposal.
//
// No percentage, fee or cap is invented here: a term the paper does not state stays UNANSWERED (a question for the human), never
// a platform default (owner ruling 4). Sources of every rule: the agreement fields; the cap behaviour is lib/commission/cap-resolver.ts.

import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { CAP_CONTRIBUTION_TYPES } from "./cap-resolver"
import { TERMS_AGREEMENT_TYPES, calendarDay, isExecutedAgreement, type AgentAgreementRow, type AgreementActor } from "@/lib/agreements/agent-agreements"

// ─── The terms an agent agreement can state (agent_commission_profiles columns — ONE vocabulary, CLAUDE.md §6) ───────────

// the live CHECK members of agent_commission_profiles.*_fee_type / structure_type (scripts/check-vocabularies.ts) — module-private
const FEE_TYPES = ["flat", "percent"] as const
const STRUCTURE_TYPES = ["flat_cap", "multi_layer", "split", "team", "tiered"] as const

/** Numeric percent terms (0–100). */
const PERCENT_TERMS = ["split_percent", "team_override_percent"] as const
/** Money/rate values whose unit is set by their *_type sibling. */
const TYPED_VALUE_TERMS = {
  transaction_fee_value: "transaction_fee_type",
  desk_fee_value: "desk_fee_type",
  technology_fee_value: "technology_fee_type",
  eo_fee_value: "eo_fee_type",
  royalty_value: "royalty_type",
  referral_value: "referral_type",
  residual_value: "residual_type",
} as const
const TYPE_TERMS = Object.values(TYPED_VALUE_TERMS)

/** Every agreement term the profile records, by its column name. */
export const AGREEMENT_TERM_KEYS = [
  "structure_type", ...PERCENT_TERMS, "cap_amount", "cap_anniversary_date", "cap_eligible_contributions",
  ...Object.keys(TYPED_VALUE_TERMS), ...TYPE_TERMS,
] as const
export type AgreementTermKey = (typeof AGREEMENT_TERM_KEYS)[number]
const isTermKey = (k: string): k is AgreementTermKey => (AGREEMENT_TERM_KEYS as readonly string[]).includes(k)

// ─── The owner's questions, each mapped to WHERE its answer lives ─────────────────────────────────────────────────────────

export type SetupAnswerHome =
  | { kind: "agreement_terms"; terms: readonly AgreementTermKey[] }
  | { kind: "brokerage_setting"; column: string; writer: string }
  | { kind: "client_agreements"; writer: string }
  | { kind: "explained"; rule: string }

export interface CommissionSetupQuestion {
  key: string
  question: string
  home: SetupAnswerHome
}

/**
 * The owner's question list (ruling 6), each answered by the executed agreement's terms or by the brokerage setting that
 * already has a writer — or EXPLAINED where the engine's rule is fixed (an agreement saying otherwise is a finding for a human,
 * never a silent override).
 */
export const COMMISSION_SETUP_QUESTIONS: readonly CommissionSetupQuestion[] = [
  { key: "split", question: "What is the agent's split (and the structure: split, flat cap, tiered, team)?", home: { kind: "agreement_terms", terms: ["structure_type", "split_percent"] } },
  { key: "cap", question: "Is there a cap — and how much?", home: { kind: "agreement_terms", terms: ["cap_amount"] } },
  { key: "cap_contributions", question: "Which charges count toward the cap (the brokerage split, transaction / desk / technology / E&O fees, royalty)?", home: { kind: "agreement_terms", terms: ["cap_eligible_contributions"] } },
  { key: "cap_reset", question: "When does the cap reset?", home: { kind: "agreement_terms", terms: ["cap_anniversary_date"] } },
  { key: "fees_after_cap", question: "Which fees continue after the cap?", home: { kind: "explained", rule: "every agreement fee NOT listed as counting toward the cap is charged on every deal, before and after the cap; a listed fee stops at the cap (lib/commission/waterfall/10-fees.ts)" } },
  { key: "agent_fees", question: "Which transaction, desk, technology and E&O fees does the agent pay?", home: { kind: "agreement_terms", terms: ["transaction_fee_type", "transaction_fee_value", "desk_fee_type", "desk_fee_value", "technology_fee_type", "technology_fee_value", "eo_fee_type", "eo_fee_value"] } },
  { key: "royalty", question: "Is a royalty owed to the brokerage?", home: { kind: "agreement_terms", terms: ["royalty_type", "royalty_value"] } },
  { key: "team_leader_split", question: "What does the team leader take?", home: { kind: "agreement_terms", terms: ["team_override_percent"] } },
  { key: "referral_fees", question: "Who pays referral fees?", home: { kind: "explained", rule: "an agreed referral fee comes off the TOP of the adjusted gross before the brokerage/agent split, paid to the referring agent or the outside partner's brokerage — and only on an executed referral agreement (lib/commission/referral-payout.ts); an agreement that charges it to the agent alone is a finding for a human" } },
  { key: "revenue_share", question: "How is revenue share / residual calculated?", home: { kind: "agreement_terms", terms: ["residual_type", "residual_value", "referral_type", "referral_value"] } },
  { key: "cda_used", question: "Does the brokerage use a CDA?", home: { kind: "brokerage_setting", column: "brokerages.offers_cda", writer: "app/actions/brokerage-cda-setup.ts" } },
  { key: "payout_release", question: "When does the brokerage release payment?", home: { kind: "brokerage_setting", column: "brokerages.commission_payout_timing", writer: "app/actions/commission-policy/commission-policy.ts setCommissionPayoutPolicyAction" } },
  { key: "concession_approval", question: "Must an agent ask before giving a concession?", home: { kind: "brokerage_setting", column: "brokerages.agent_concession_approval", writer: "app/actions/commission-policy/commission-policy.ts setCommissionPayoutPolicyAction" } },
  { key: "client_charges", question: "Which charges fall on buyers / sellers (transaction or admin fees in their agreements) versus the agent / brokerage?", home: { kind: "client_agreements", writer: "app/actions/commission-policy/client-agreement-fees.ts" } },
]

// ─── PURE: the proposal ─────────────────────────────────────────────────────────────────────────────────────────────

export type ProposalSource = "signed_form_field" | "ai_extraction"

export interface ProposedTerm {
  value: unknown
  source: ProposalSource
  /** The form field / extracted key the value came from. */
  field: string
  /** The extraction's confidence (an AI reading); a signed-form field is the record the brokerage itself typed. */
  confidence: "record" | "high" | "medium" | "low"
}

export interface TermsProposal {
  agreementId: string
  /** The executed agreement's effective date — the date the verified terms will govern from. null = not recorded yet. */
  effectiveDate: string | null
  terms: Partial<Record<AgreementTermKey, ProposedTerm>>
  /** Questions whose agreement terms the paper does not state — the human answers them (or the agreement is silent). */
  unanswered: string[]
  findings: string[]
}

function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string") return null
  const t = v.replace(/[$,%\s]/g, "")
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** PURE — read one stated value for a term key, or null when the paper does not state it under that key (never interpreted). */
function readTerm(key: AgreementTermKey, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null
  if ((TYPE_TERMS as readonly string[]).includes(key)) return (FEE_TYPES as readonly string[]).includes(String(raw).trim().toLowerCase()) ? String(raw).trim().toLowerCase() : null
  if (key === "structure_type") return (STRUCTURE_TYPES as readonly string[]).includes(String(raw).trim().toLowerCase()) ? String(raw).trim().toLowerCase() : null
  if (key === "cap_anniversary_date") return calendarDay(raw)
  if (key === "cap_eligible_contributions") {
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;]/)
    const known = list.map((x) => String(x).trim().toLowerCase()).filter((x) => (CAP_CONTRIBUTION_TYPES as readonly string[]).includes(x))
    return known.length ? Array.from(new Set(known)) : null
  }
  return parseNumber(raw)
}

/**
 * PURE — the structured settings the executed agreement supports, from (1) the fields the brokerage typed into the signed form
 * (its canonical term keys — a field the brokerage named differently is NOT interpreted) and (2) a stored scan's AI extraction of
 * the executed paper (proposal only, lower rank). Where both state a term and DISAGREE, the signed form wins and the
 * disagreement is a finding. Nothing is defaulted.
 */
export function proposeTermsFromAgreement(
  agreement: Pick<AgentAgreementRow, "id" | "effective_date" | "field_values" | "esign_status">,
  extraction?: { documentId: string; fields: Record<string, unknown> | null | undefined; confidence?: "high" | "medium" | "low" | null } | null,
): TermsProposal {
  const terms: Partial<Record<AgreementTermKey, ProposedTerm>> = {}
  const findings: string[] = []
  if (!isExecutedAgreement(agreement)) findings.push(`agreement ${agreement.id} is not fully signed — a proposal can be read from it, but terms are verified only against an executed agreement`)
  const form = agreement.field_values && typeof agreement.field_values === "object" && !Array.isArray(agreement.field_values) ? (agreement.field_values as Record<string, unknown>) : {}
  for (const [k, raw] of Object.entries(form)) {
    if (!isTermKey(k)) continue
    const v = readTerm(k, raw)
    if (v === null) { findings.push(`the signed form's "${k}" (${String(raw)}) is not a readable ${k.replace(/_/g, " ")} — left for the human`); continue }
    terms[k] = { value: v, source: "signed_form_field", field: k, confidence: "record" }
  }
  if (extraction?.fields && typeof extraction.fields === "object") {
    for (const [k, raw] of Object.entries(extraction.fields)) {
      if (!isTermKey(k)) continue
      const v = readTerm(k, raw)
      if (v === null) continue
      const have = terms[k]
      if (have && JSON.stringify(have.value) !== JSON.stringify(v)) {
        findings.push(`the scan of document ${extraction.documentId} reads ${k} as ${JSON.stringify(v)} but the signed form states ${JSON.stringify(have.value)} — the signed form is proposed; a human confirms`)
        continue
      }
      if (!have) terms[k] = { value: v, source: "ai_extraction", field: k, confidence: extraction.confidence ?? "low" }
    }
  }
  // a typed value with no stated unit is half a term — the human states the unit (never assumed flat or percent)
  for (const [valueKey, typeKey] of Object.entries(TYPED_VALUE_TERMS) as Array<[AgreementTermKey, AgreementTermKey]>) {
    if (terms[valueKey] && !terms[typeKey]) findings.push(`${valueKey.replace(/_/g, " ")} is stated without its unit (${typeKey}) — the human states whether it is flat or a percent`)
  }
  const unanswered = COMMISSION_SETUP_QUESTIONS
    .filter((q) => q.home.kind === "agreement_terms" && !q.home.terms.some((t) => terms[t]))
    .map((q) => q.key)
  return { agreementId: agreement.id, effectiveDate: calendarDay(agreement.effective_date), terms, unanswered, findings }
}

/** PURE — validate the human-verified terms (shape only; the VALUES are the human's reading of the executed paper).
 *  Module-private: verifyAgreementTerms runs it before any read, so the guard proves it through that writer. */
function validateVerifiedTerms(terms: Record<string, unknown>): { ok: true; terms: Partial<Record<AgreementTermKey, unknown>> } | { ok: false; error: string } {
  const out: Partial<Record<AgreementTermKey, unknown>> = {}
  for (const [k, raw] of Object.entries(terms ?? {})) {
    if (!isTermKey(k)) return { ok: false, error: `not an agreement term: ${k}` }
    if (raw === null) { out[k] = null; continue }       // an explicit null: the agreement is silent on this term
    const v = readTerm(k, raw)
    if (v === null) return { ok: false, error: `${k}: "${String(raw)}" is not a valid value` }
    if (typeof v === "number" && v < 0) return { ok: false, error: `${k}: a term is never negative` }
    if ((PERCENT_TERMS as readonly string[]).includes(k) && typeof v === "number" && v > 100) return { ok: false, error: `${k}: a percent is at most 100` }
    out[k] = v
  }
  for (const [valueKey, typeKey] of Object.entries(TYPED_VALUE_TERMS) as Array<[AgreementTermKey, AgreementTermKey]>) {
    const v = out[valueKey]
    if (typeof v === "number" && out[typeKey] === undefined) return { ok: false, error: `${valueKey}: state its unit (${typeKey}: flat or percent)` }
    if (typeof v === "number" && out[typeKey] === "percent" && v > 100) return { ok: false, error: `${valueKey}: a percent is at most 100` }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "state at least one term the executed agreement sets" }
  return { ok: true, terms: out }
}

// ─── PURE: setup status (what the onboarding step shows) ──────────────────────────────────────────────────────────────

export type SetupAnswerState = "from_executed_agreement" | "awaiting_verification" | "unanswered" | "brokerage_setting" | "explained" | "client_agreements"

export interface SetupStatusLine { key: string; question: string; state: SetupAnswerState; detail: string }

/**
 * PURE — for one agent: is each question answered by terms VERIFIED against the executed agreement in force, proposed but not
 * verified, or unanswered? Brokerage-level questions point at their own writer.
 */
export function commissionSetupStatus(input: {
  profile: Record<string, unknown> | null
  agreementInForceId: string | null
}): SetupStatusLine[] {
  const verified = !!input.profile && !!input.agreementInForceId && input.profile.agreement_signature_id === input.agreementInForceId
  return COMMISSION_SETUP_QUESTIONS.map((q) => {
    if (q.home.kind === "brokerage_setting") return { key: q.key, question: q.question, state: "brokerage_setting" as const, detail: `${q.home.column} — set by ${q.home.writer}` }
    if (q.home.kind === "explained") return { key: q.key, question: q.question, state: "explained" as const, detail: q.home.rule }
    if (q.home.kind === "client_agreements") return { key: q.key, question: q.question, state: "client_agreements" as const, detail: `recorded per listing / buyer-broker agreement — ${q.home.writer}` }
    const stated = q.home.terms.some((t) => input.profile && input.profile[t] !== null && input.profile[t] !== undefined)
    if (!stated) return { key: q.key, question: q.question, state: "unanswered" as const, detail: "no term recorded — answer it from the executed agreement (or confirm the agreement is silent)" }
    return verified
      ? { key: q.key, question: q.question, state: "from_executed_agreement" as const, detail: `verified against agreement ${input.agreementInForceId}` }
      : { key: q.key, question: q.question, state: "awaiting_verification" as const, detail: input.agreementInForceId ? `recorded, not yet verified against agreement ${input.agreementInForceId}` : "recorded, but no executed agreement is on file to verify it against" }
  })
}

// ─── The human verification (the only path that stamps a profile with its agreement) ───────────────────────────────────

type Db = { from: (t: string) => any }

/**
 * A FINANCE ADMIN VERIFIES the agent's terms against an EXECUTED agreement (with its effective date recorded — m858): the
 * agent_commission_profiles row is written with exactly the verified terms, effective_date = the agreement's effective date
 * and agreement_signature_id = the agreement (the m858 trigger re-checks both; the m812 trigger versions it from that date).
 * Terms the human did not state are left as they are — nothing is defaulted. Ledgered with the proposal it started from and
 * what the human changed.
 */
export async function verifyAgreementTerms(
  db: Db,
  actor: AgreementActor,
  input: { contractSignatureId: string; terms: Record<string, unknown>; proposal?: TermsProposal | null },
): Promise<{ ok: true; profileId: string; effectiveDate: string; changedFromProposal: string[] } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) {
    return { ok: false, error: "forbidden: only the brokerage's finance admins verify commission terms" }
  }
  const v = validateVerifiedTerms(input.terms)
  if (!v.ok) return v
  const { data: agreement, error: aErr } = await db.from("contract_signatures").select("*").eq("id", input.contractSignatureId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (aErr) return { ok: false, error: `agreement_read_refused: ${aErr.message}` }
  const a = agreement as AgentAgreementRow | null
  if (!a) return { ok: false, error: "agreement_not_found" }
  if (!(TERMS_AGREEMENT_TYPES as readonly string[]).includes(a.contract_type)) return { ok: false, error: "not_a_terms_agreement: commission terms are verified against the commission agreement (or the independent-contractor agreement)" }
  if (!isExecutedAgreement(a)) return { ok: false, error: "not_executed: terms are verified only against a fully signed agreement" }
  const eff = calendarDay(a.effective_date)
  if (!eff) return { ok: false, error: "no_effective_date: record the effective date the executed agreement states first" }
  if (!a.agent_id) return { ok: false, error: "agreement_without_agent" }

  const { data: existing, error: pErr } = await db.from("agent_commission_profiles").select("*").eq("agent_id", a.agent_id).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (pErr) return { ok: false, error: `profile_read_refused: ${pErr.message}` }
  const proposalTerms = input.proposal?.terms ?? {}
  const changedFromProposal = Object.keys(v.terms).filter((k) => {
    const p = (proposalTerms as Record<string, ProposedTerm | undefined>)[k]
    return !p || JSON.stringify(p.value) !== JSON.stringify((v.terms as Record<string, unknown>)[k])
  })
  const patch = { ...v.terms, effective_date: eff, agreement_signature_id: a.id, is_active: true }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  let profileId: string | null = null
  const res = await withActionLedger<{ ok: boolean; error?: string }>(
    {
      brokerageId: actor.brokerageId,
      action: "finance.agreement_terms.verified",
      actor: { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "agent_commission_profile", id: (existing as { id?: string } | null)?.id ?? null, ref: a.id },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: `commission terms verified against the executed ${a.contract_type.replace(/_/g, " ")} ${a.id}, effective ${eff}`,
      riskClass: "FINANCIAL",
      systemSource: "agreement_onboarding",
      detail: {
        agent_id: a.agent_id, agreement_id: a.id, effective_date: eff, verified_terms: v.terms,
        proposal_sources: Object.fromEntries(Object.entries(proposalTerms).map(([k, p]) => [k, (p as ProposedTerm).source])),
        changed_from_proposal: changedFromProposal,
        before: existing ? Object.fromEntries(Object.keys(v.terms).map((k) => [k, (existing as Record<string, unknown>)[k] ?? null])) : null,
      },
    },
    async () => {
      if (existing) {
        const { data, error } = await db.from("agent_commission_profiles").update(patch).eq("id", (existing as { id: string }).id).eq("brokerage_id", actor.brokerageId).select("id")
        if (error) return { ok: false, error: `terms_refused: ${error.message}` }
        const rows = (data ?? []) as Array<{ id: string }>
        if (rows.length !== 1) return { ok: false, error: "terms_not_written: the profile is no longer in this brokerage" }
        profileId = rows[0].id
        return { ok: true }
      }
      const { data, error } = await db.from("agent_commission_profiles").insert({ ...patch, agent_id: a.agent_id, brokerage_id: actor.brokerageId }).select("id")
      if (error) return { ok: false, error: `terms_refused: ${error.message}` }
      const rows = (data ?? []) as Array<{ id: string }>
      if (rows.length !== 1) return { ok: false, error: `terms_not_written (${rows.length} rows)` }
      profileId = rows[0].id
      return { ok: true }
    },
    {
      settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }),
      replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }),
    },
    { client: db as never },
  )
  if (!res.ok || !profileId) return { ok: false, error: res.error ?? "terms_not_written" }
  return { ok: true, profileId, effectiveDate: eff, changedFromProposal }
}

/** The AI extraction of a stored scan of the executed paper (documents, tenant-pinned) — a proposal source only. */
export async function loadAgreementExtraction(
  db: Db,
  brokerageId: string,
  documentId: string,
): Promise<{ ok: true; extraction: { documentId: string; fields: Record<string, unknown> | null; confidence: "high" | "medium" | "low" | null } | null } | { ok: false; error: string }> {
  const { data, error } = await db.from("documents").select("id, classification, extracted_fields, classification_confidence").eq("id", documentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `document_read_refused: ${error.message}` }
  if (!data) return { ok: true, extraction: null }
  const d = data as { id: string; extracted_fields?: unknown; classification_confidence?: string | null }
  const conf = ["high", "medium", "low"].includes(String(d.classification_confidence)) ? (d.classification_confidence as "high" | "medium" | "low") : null
  return { ok: true, extraction: { documentId: d.id, fields: d.extracted_fields && typeof d.extracted_fields === "object" ? (d.extracted_fields as Record<string, unknown>) : null, confidence: conf } }
}
