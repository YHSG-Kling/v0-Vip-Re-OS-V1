// lib/agreements/referral-agreements.ts — RECORDING THE EXECUTED REFERRAL AGREEMENT A PAYOUT NEEDS
// (wave 145, lane 145C; owner ruling 9, 2026-10-27: "There will be agreed and executed referral agreements if a brokerage needs
// to pay the referral on a transaction.").
//
// The RULE lives in lib/commission/referral-payout.ts (referralAgreementOnRecord, read by pickReferralForDeal at stage 03b): a
// referral fee — inside agent or outside partner — is paid only on an executed referral agreement on record; otherwise a FINAL
// commission calculation HOLDS by name. This module is the one WRITER of that record (m860):
//   · referrals.referral_agreement_document_id + referral_agreement_executed_on — the agreement for ONE referral; recorded once
//     (an executed agreement is evidence, never edited — compare-and-swap on "not yet recorded");
//   · referral_partners.agreement_document_id (+ the existing agreement_date / agreement_end_date window) — an outside partner's
//     STANDING agreement; a renewal replaces it, ledgered with what it replaced.
// The paper is a stored document of THIS brokerage (documents — the one stored-paper survivor; the m860 trigger re-checks the
// tenant). A finance admin records it from the executed paper; AI never does.

import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { calendarDay, type AgreementActor } from "./agent-agreements"

type Db = { from: (t: string) => any }

const m860Missing = (message: string | undefined) => /referral_agreement_|agreement_document_id|agreement_recorded/.test(String(message ?? "")) && /column|schema cache|does not exist/i.test(String(message ?? ""))

async function storedDocument(db: Db, brokerageId: string, documentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await db.from("documents").select("id").eq("id", documentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `document_read_refused: ${error.message}` }
  if (!data) return { ok: false, error: "document_not_found: the executed referral agreement must be a document stored in this brokerage" }
  return { ok: true }
}

async function ledgered<T extends { ok: boolean; error?: string }>(db: Db, actor: AgreementActor, action: string, subjectType: string, subjectId: string, ref: string, reasonDetail: string, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>(
    { brokerageId: actor.brokerageId, action, actor: { type: "user", userId: actor.userId, agentId: actor.agentId }, subject: { type: subjectType, id: subjectId, ref }, reasonCode: "HUMAN_REQUESTED", reasonDetail: reasonDetail.slice(0, 500), riskClass: "FINANCIAL", systemSource: "referral_agreement", detail },
    run,
    { settle: (r) => (r.ok ? { status: "executed", outcome: "recorded" } : { status: "failed", outcome: "refused", error: r.error ?? null }), replay: (claim) => ({ ok: false, error: `already ${claim.kind === "in_flight" ? "in flight" : "recorded"}` }) as unknown as T },
    { client: db as never },
  )
}

/** Record the EXECUTED referral agreement for one referral (finance admins; once — compare-and-swap on "not recorded"). */
export async function recordReferralAgreement(
  db: Db,
  actor: AgreementActor,
  input: { referralId: string; documentId: string; executedOn: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) return { ok: false, error: "forbidden: only the brokerage's finance admins record a referral agreement" }
  const day = calendarDay(input.executedOn)
  if (!day) return { ok: false, error: "executed_on_invalid: the date the referral agreement was fully signed, yyyy-mm-dd" }
  if (day > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) return { ok: false, error: "executed_on_invalid: an agreement cannot have been signed in the future" }
  const doc = await storedDocument(db, actor.brokerageId, input.documentId)
  if (!doc.ok) return doc
  const { data: ref, error: rErr } = await db.from("referrals").select("*").eq("id", input.referralId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (rErr) return { ok: false, error: `referral_read_refused: ${rErr.message}` }
  if (!ref) return { ok: false, error: "referral_not_found" }
  if ((ref as Record<string, unknown>).referral_agreement_document_id) return { ok: false, error: "already_recorded: this referral's executed agreement is on record — it is evidence and is not replaced" }
  return ledgered(db, actor, "finance.referral_agreement.recorded", "referral", input.referralId, input.documentId,
    `executed referral agreement recorded (signed ${day})`, { referral_id: input.referralId, document_id: input.documentId, executed_on: day }, async () => {
      const { data, error } = await db.from("referrals")
        .update({ referral_agreement_document_id: input.documentId, referral_agreement_executed_on: day, referral_agreement_recorded_by: actor.userId, referral_agreement_recorded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", input.referralId).eq("brokerage_id", actor.brokerageId).is("referral_agreement_document_id", null).select("id")
      if (error) return { ok: false, error: m860Missing(error.message) ? `m860 (referral agreements) is not applied: ${error.message}` : `record_refused: ${error.message}` }
      if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "not_recorded: the referral changed under you (already recorded, or not in this brokerage)" }
      return { ok: true }
    })
}

/**
 * Record (or renew) an outside partner's STANDING executed referral agreement and the window it governs. Finance admins; the
 * replaced document, if any, is kept in the ledger evidence. An `informal` partner arrangement has no paper and authorizes nothing.
 */
export async function recordPartnerReferralAgreement(
  db: Db,
  actor: AgreementActor,
  input: { partnerId: string; documentId: string; agreementDate: string; agreementEndDate?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!actor.brokerageId) return { ok: false, error: "no_tenant" }
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType, is_tenant_principal: actor.isTenantPrincipal })) return { ok: false, error: "forbidden: only the brokerage's finance admins record a partner's referral agreement" }
  const from = calendarDay(input.agreementDate)
  if (!from) return { ok: false, error: "agreement_date_invalid: the date the partner's executed agreement takes effect, yyyy-mm-dd" }
  const end = input.agreementEndDate ? calendarDay(input.agreementEndDate) : null
  if (input.agreementEndDate && !end) return { ok: false, error: "agreement_end_date_invalid: yyyy-mm-dd, or leave it empty for an open-ended agreement" }
  if (end && end < from) return { ok: false, error: "agreement_end_date_invalid: the agreement cannot end before it starts" }
  const doc = await storedDocument(db, actor.brokerageId, input.documentId)
  if (!doc.ok) return doc
  const { data: cur, error: pErr } = await db.from("referral_partners").select("*").eq("id", input.partnerId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (pErr) return { ok: false, error: `partner_read_refused: ${pErr.message}` }
  if (!cur) return { ok: false, error: "partner_not_found" }
  const before = { agreement_document_id: (cur as Record<string, unknown>).agreement_document_id ?? null, agreement_date: (cur as Record<string, unknown>).agreement_date ?? null, agreement_end_date: (cur as Record<string, unknown>).agreement_end_date ?? null }
  return ledgered(db, actor, "finance.referral_agreement.partner_recorded", "referral_partner", input.partnerId, input.documentId,
    `partner's executed referral agreement recorded (${from} → ${end ?? "open"})`, { partner_id: input.partnerId, document_id: input.documentId, agreement_date: from, agreement_end_date: end, before }, async () => {
      const { data, error } = await db.from("referral_partners")
        .update({ agreement_document_id: input.documentId, agreement_date: from, agreement_end_date: end, agreement_recorded_by: actor.userId, agreement_recorded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", input.partnerId).eq("brokerage_id", actor.brokerageId).select("id")
      if (error) return { ok: false, error: m860Missing(error.message) ? `m860 (referral agreements) is not applied: ${error.message}` : `record_refused: ${error.message}` }
      if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "not_recorded: the partner is no longer in this brokerage" }
      return { ok: true }
    })
}
