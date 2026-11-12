"use server"

/**
 * app/actions/commission-policy/agreements.ts — THE DOORS FOR THE EXECUTED AGREEMENTS THAT DICTATE THE MONEY
 * (wave 145, lane 145C; owner rulings 3, 4, 6 and 9, 2026-10-27).
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, tenant from the SESSION (lib/agreements/session-actor.ts), never a
 * body field; the writers gate the role themselves (finance admins) and run on the service client AFTER the gate. Nothing here
 * computes money or reads a model: the executed paper is read by a person (or by the doc kernel's existing scan, as a proposal)
 * and a person verifies — lib/agreements/agent-agreements.ts, lib/commission/agreement-onboarding.ts,
 * lib/agreements/referral-agreements.ts are the rules and writers.
 */

import { revalidatePath } from "next/cache"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { resolveSessionActor } from "@/lib/agreements/session-actor"
import type { SetupStatusLine, TermsProposal } from "@/lib/commission/agreement-onboarding"
import type { StartDateProposal } from "@/lib/agreements/agent-agreements"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGREEMENTS_PAGE = "/dashboard/financials/agreements"

async function svc() {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as never
}

export interface AgentAgreementGovernanceView {
  agentId: string
  name: string
  startDate: string | null
  startDateSource: string | null
  /** The seat's provisioning stamp — shown so a human can see it is NOT the start date. */
  seatAnniversaryDate: string | null
  startDateProposal: StartDateProposal
  agreements: Array<{
    id: string; contractType: string; esignStatus: string | null; fullySignedAt: string | null; effectiveDate: string | null; effectiveDateRecordedAt: string | null; amends: string | null; documentUrl: string | null
    /** The start date THIS agreement would set (contract C6 — the same rule the writer enforces), or why it cannot be the source. */
    startDateIfSource: string | null
    startDateRefusal: string | null
  }>
  /** The executed terms agreement in force today (commission agreement, else the independent-contractor agreement). */
  termsAgreementInForce: string | null
  termsVerifiedAgainst: string | null
  proposal: TermsProposal | null
  setup: SetupStatusLine[]
}

/** A stored scan of an executed agent agreement (documents classified commission_agreement) whose AI extraction can PROPOSE terms. */
export interface AgreementScanView { id: string; scannedAt: string | null; summary: string | null; confidence: string | null }

/** The agreement-governance view of every agent: executed agreements, effective dates, start date, terms verification. */
export async function listAgentAgreementGovernanceAction(): Promise<ActionResult<{ agents: AgentAgreementGovernanceView[]; scans: AgreementScanView[] }>> {
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  if (!isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })) return { success: false, error: "forbidden" }
  const db = await svc() as unknown as { from: (t: string) => any }
  const { listAgentAgreements, proposeAgentStartDate, agreementInForce, amendmentChain, validateStartDateSource, TERMS_AGREEMENT_TYPES } = await import("@/lib/agreements/agent-agreements")
  const { proposeTermsFromAgreement, commissionSetupStatus } = await import("@/lib/commission/agreement-onboarding")
  const [agentsRes, agreements, profilesRes, scansRes] = await Promise.all([
    db.from("agents").select("*, users(first_name, last_name)").eq("brokerage_id", s.actor.brokerageId).limit(1000),
    listAgentAgreements(db, s.actor.brokerageId),
    db.from("agent_commission_profiles").select("*").eq("brokerage_id", s.actor.brokerageId).limit(1000),
    db.from("documents").select("id, scanned_at, summary, classification_confidence").eq("brokerage_id", s.actor.brokerageId).eq("classification", "commission_agreement").order("scanned_at", { ascending: false }).limit(50),
  ])
  if (agentsRes.error) return { success: false, error: `Could not read the agents: ${agentsRes.error.message}` }
  if (!agreements.ok) return { success: false, error: agreements.error }
  if (profilesRes.error) return { success: false, error: `Could not read the commission terms: ${profilesRes.error.message}` }
  if (scansRes.error) return { success: false, error: `Could not read the stored agreement scans: ${scansRes.error.message}` }
  const today = new Date().toISOString().slice(0, 10)
  const profiles = new Map<string, Record<string, unknown>>(((profilesRes.data ?? []) as Array<Record<string, unknown>>).map((p) => [String(p.agent_id), p]))
  const views: AgentAgreementGovernanceView[] = ((agentsRes.data ?? []) as Array<Record<string, any>>).map((a) => {
    const mine = agreements.rows.filter((r) => r.agent_id === a.id)
    const commission = mine.filter((r) => r.contract_type === "commission_agreement")
    const inForce = agreementInForce(commission.length ? commission : mine, commission.length ? ["commission_agreement"] : [...TERMS_AGREEMENT_TYPES], today)
    const profile = profiles.get(String(a.id)) ?? null
    const u = Array.isArray(a.users) ? a.users[0] : a.users
    // the amendment HISTORY, readable: each original agreement followed by its executed amendments, oldest first
    const chained = mine.filter((r) => !r.amends_contract_signature_id).flatMap((b) => amendmentChain(mine, b.id))
    const history = [...chained, ...mine.filter((r) => !chained.includes(r))]
    return {
      agentId: String(a.id),
      name: [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "Agent",
      startDate: (a.start_date as string | null | undefined) ?? null,
      startDateSource: (a.start_date_source as string | null | undefined) ?? null,
      seatAnniversaryDate: (a.anniversary_date as string | null | undefined) ?? null,
      startDateProposal: proposeAgentStartDate(String(a.id), mine),
      agreements: history.map((r) => {
        const src = validateStartDateSource({ id: String(a.id), brokerage_id: (a.brokerage_id as string | null) ?? null }, r)
        return {
          id: r.id, contractType: r.contract_type, esignStatus: r.esign_status, fullySignedAt: r.fully_signed_at ?? null, effectiveDate: r.effective_date ?? null,
          effectiveDateRecordedAt: r.effective_date_recorded_at ?? null, amends: r.amends_contract_signature_id ?? null, documentUrl: r.document_url ?? null,
          startDateIfSource: src.ok ? src.startDate : null, startDateRefusal: src.ok ? null : src.error,
        }
      }),
      termsAgreementInForce: inForce?.row.id ?? null,
      termsVerifiedAgainst: (profile?.agreement_signature_id as string | null | undefined) ?? null,
      proposal: inForce ? proposeTermsFromAgreement(inForce.row) : null,
      setup: commissionSetupStatus({ profile, agreementInForceId: inForce?.row.id ?? null }),
    }
  }).sort((x, y) => x.name.localeCompare(y.name))
  const scans: AgreementScanView[] = ((scansRes.data ?? []) as Array<Record<string, any>>).map((d) => ({
    id: String(d.id), scannedAt: (d.scanned_at as string | null) ?? null, summary: (d.summary as string | null) ?? null, confidence: (d.classification_confidence as string | null) ?? null,
  }))
  return { success: true, agents: views, scans }
}

/** A finance admin records the effective date the EXECUTED agreement states (once; a change is an amendment). */
export async function recordAgreementEffectiveDateAction(input: { contractSignatureId: string; effectiveDate: string }): Promise<ActionResult<{ effectiveDate: string }>> {
  if (!UUID.test(String(input?.contractSignatureId ?? ""))) return { success: false, error: "invalid_agreement" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { recordAgreementEffectiveDate } = await import("@/lib/agreements/agent-agreements")
  const r = await recordAgreementEffectiveDate(await svc(), s.actor, { contractSignatureId: input.contractSignatureId, effectiveDate: String(input.effectiveDate ?? "") })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(AGREEMENTS_PAGE)
  return { success: true, effectiveDate: String(r.row.effective_date) }
}

/** A finance admin records an EXECUTED amendment of an agent agreement (a new row; the original is never edited). */
export async function recordAgentAgreementAmendmentAction(input: {
  amendsContractSignatureId: string
  executedOn: string
  effectiveDate: string
  documentUrl: string
  fieldValues?: Record<string, unknown> | null
  note?: string | null
}): Promise<ActionResult<{ amendmentId: string }>> {
  if (!UUID.test(String(input?.amendsContractSignatureId ?? ""))) return { success: false, error: "invalid_agreement" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { recordAgentAgreementAmendment } = await import("@/lib/agreements/agent-agreements")
  const r = await recordAgentAgreementAmendment(await svc(), s.actor, {
    amendsContractSignatureId: input.amendsContractSignatureId, executedOn: String(input.executedOn ?? ""), effectiveDate: String(input.effectiveDate ?? ""),
    documentUrl: String(input.documentUrl ?? ""), fieldValues: input.fieldValues ?? null, note: input.note ?? null,
  })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(AGREEMENTS_PAGE)
  return { success: true, amendmentId: r.row.id }
}

/** A finance admin sets agents.start_date FROM an executed brokerage agreement (contract C6 — the only writer). */
export async function setAgentStartDateAction(input: { agentId: string; contractSignatureId: string }): Promise<ActionResult<{ startDate: string }>> {
  if (!UUID.test(String(input?.agentId ?? "")) || !UUID.test(String(input?.contractSignatureId ?? ""))) return { success: false, error: "invalid_input" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { setAgentStartDateFromAgreement } = await import("@/lib/agreements/agent-agreements")
  const r = await setAgentStartDateFromAgreement(await svc(), s.actor, { agentId: input.agentId, contractSignatureId: input.contractSignatureId })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(AGREEMENTS_PAGE)
  return { success: true, startDate: r.startDate }
}

/** The structured settings the executed agreement supports (signed-form fields, plus an optional stored scan's extraction). */
export async function proposeAgreementTermsAction(input: { contractSignatureId: string; documentId?: string | null }): Promise<ActionResult<{ proposal: TermsProposal }>> {
  if (!UUID.test(String(input?.contractSignatureId ?? ""))) return { success: false, error: "invalid_agreement" }
  if (input.documentId && !UUID.test(String(input.documentId))) return { success: false, error: "invalid_document" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  if (!isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })) return { success: false, error: "forbidden" }
  const db = await svc() as unknown as { from: (t: string) => any }
  const { data, error } = await db.from("contract_signatures").select("*").eq("id", input.contractSignatureId).eq("brokerage_id", s.actor.brokerageId).maybeSingle()
  if (error) return { success: false, error: `Could not read the agreement: ${error.message}` }
  if (!data) return { success: false, error: "agreement_not_found" }
  const { proposeTermsFromAgreement, loadAgreementExtraction } = await import("@/lib/commission/agreement-onboarding")
  let extraction = null
  if (input.documentId) {
    const x = await loadAgreementExtraction(db, s.actor.brokerageId, input.documentId)
    if (!x.ok) return { success: false, error: x.error }
    extraction = x.extraction
  }
  return { success: true, proposal: proposeTermsFromAgreement(data as never, extraction) }
}

/** A finance admin VERIFIES the agent's terms against the executed agreement — the only door that stamps a profile with it. */
export async function verifyAgreementTermsAction(input: { contractSignatureId: string; terms: Record<string, unknown>; documentId?: string | null }): Promise<ActionResult<{ effectiveDate: string; changedFromProposal: string[] }>> {
  if (!UUID.test(String(input?.contractSignatureId ?? ""))) return { success: false, error: "invalid_agreement" }
  if (!input.terms || typeof input.terms !== "object" || Array.isArray(input.terms)) return { success: false, error: "terms_required" }
  const proposed = await proposeAgreementTermsAction({ contractSignatureId: input.contractSignatureId, documentId: input.documentId ?? null })
  if (!proposed.success) return proposed
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { verifyAgreementTerms } = await import("@/lib/commission/agreement-onboarding")
  const r = await verifyAgreementTerms(await svc(), s.actor, { contractSignatureId: input.contractSignatureId, terms: input.terms, proposal: proposed.proposal })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(AGREEMENTS_PAGE)
  return { success: true, effectiveDate: r.effectiveDate, changedFromProposal: r.changedFromProposal }
}

export interface DealReferralAgreementView {
  referralId: string
  feePct: number | null
  payee: string
  partnerId: string | null
  agreementDocumentId: string | null
  agreementExecutedOn: string | null
  partnerStandingDocumentId: string | null
  partnerWindow: { from: string | null; to: string | null } | null
}

/** The referral(s) that would pay on this deal and whether an EXECUTED referral agreement is on record (finance admins). */
export async function listDealReferralAgreementsAction(input: { transactionId: string }): Promise<ActionResult<{ referrals: DealReferralAgreementView[]; documents: Array<{ id: string; label: string }> }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  if (!isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })) return { success: false, error: "forbidden" }
  const db = await svc() as unknown as { from: (t: string) => any }
  const { data: txn, error: tErr } = await db.from("transactions").select("id, contact_id, buyer_contact_id, seller_contact_id").eq("id", input.transactionId).eq("brokerage_id", s.actor.brokerageId).maybeSingle()
  if (tErr) return { success: false, error: `Could not read the transaction: ${tErr.message}` }
  if (!txn) return { success: false, error: "transaction_not_found" }
  const t = txn as Record<string, string | null>
  const contactIds = [t.contact_id, t.buyer_contact_id, t.seller_contact_id].filter((x): x is string => !!x)
  const { data: linked, error: lErr } = await db.from("referrals").select("*").eq("brokerage_id", s.actor.brokerageId).eq("transaction_id", input.transactionId)
  if (lErr) return { success: false, error: `Could not read the referrals: ${lErr.message}` }
  let refs = (linked ?? []) as Array<Record<string, any>>
  if (refs.length === 0 && contactIds.length > 0) {
    const { data: open, error: oErr } = await db.from("referrals").select("*").eq("brokerage_id", s.actor.brokerageId).in("referred_contact_id", contactIds).is("transaction_id", null)
    if (oErr) return { success: false, error: `Could not read the referrals: ${oErr.message}` }
    refs = ((open ?? []) as Array<Record<string, any>>).filter((r) => r.status !== "lost" && (r.referring_agent_id || r.partner_id))
  }
  const partnerIds = [...new Set(refs.map((r) => r.partner_id).filter((x): x is string => !!x))]
  const partners = new Map<string, Record<string, any>>()
  if (partnerIds.length) {
    const { data: ps, error: pErr } = await db.from("referral_partners").select("*").eq("brokerage_id", s.actor.brokerageId).in("id", partnerIds)
    if (pErr) return { success: false, error: `Could not read the referral partners: ${pErr.message}` }
    for (const p of (ps ?? []) as Array<Record<string, any>>) partners.set(String(p.id), p)
  }
  const { data: docs, error: dErr } = await db.from("documents").select("id, classification, document_type, created_at").eq("brokerage_id", s.actor.brokerageId).eq("transaction_id", input.transactionId).order("created_at", { ascending: false }).limit(50)
  if (dErr) return { success: false, error: `Could not read the deal's documents: ${dErr.message}` }
  return {
    success: true,
    referrals: refs.map((r) => {
      const p = r.partner_id ? partners.get(String(r.partner_id)) ?? null : null
      return {
        referralId: String(r.id), feePct: r.referral_fee_pct == null ? null : Number(r.referral_fee_pct),
        payee: p ? `${p.company_name ?? "partner"}${p.partner_name ? ` (${p.partner_name})` : ""}` : "referring agent",
        partnerId: p ? String(p.id) : null,
        agreementDocumentId: (r.referral_agreement_document_id as string | null | undefined) ?? null,
        agreementExecutedOn: (r.referral_agreement_executed_on as string | null | undefined) ?? null,
        partnerStandingDocumentId: (p?.agreement_document_id as string | null | undefined) ?? null,
        partnerWindow: p ? { from: (p.agreement_date as string | null) ?? null, to: (p.agreement_end_date as string | null) ?? null } : null,
      }
    }),
    documents: ((docs ?? []) as Array<Record<string, any>>).map((d) => ({ id: String(d.id), label: `${String(d.classification ?? d.document_type ?? "document").replace(/_/g, " ")} · ${String(d.created_at ?? "").slice(0, 10)}` })),
  }
}

/** A finance admin records the EXECUTED referral agreement for one referral (owner ruling 9). */
export async function recordReferralAgreementAction(input: { referralId: string; documentId: string; executedOn: string }): Promise<ActionResult<object>> {
  if (!UUID.test(String(input?.referralId ?? "")) || !UUID.test(String(input?.documentId ?? ""))) return { success: false, error: "invalid_input" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { recordReferralAgreement } = await import("@/lib/agreements/referral-agreements")
  const r = await recordReferralAgreement(await svc(), s.actor, { referralId: input.referralId, documentId: input.documentId, executedOn: String(input.executedOn ?? "") })
  if (!r.ok) return { success: false, error: r.error }
  return { success: true }
}

/** A finance admin records (or renews) an outside partner's STANDING executed referral agreement (owner ruling 9). */
export async function recordPartnerReferralAgreementAction(input: { partnerId: string; documentId: string; agreementDate: string; agreementEndDate?: string | null }): Promise<ActionResult<object>> {
  if (!UUID.test(String(input?.partnerId ?? "")) || !UUID.test(String(input?.documentId ?? ""))) return { success: false, error: "invalid_input" }
  const s = await resolveSessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { recordPartnerReferralAgreement } = await import("@/lib/agreements/referral-agreements")
  const r = await recordPartnerReferralAgreement(await svc(), s.actor, { partnerId: input.partnerId, documentId: input.documentId, agreementDate: String(input.agreementDate ?? ""), agreementEndDate: input.agreementEndDate ?? null })
  if (!r.ok) return { success: false, error: r.error }
  return { success: true }
}
