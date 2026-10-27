"use server"

/**
 * app/actions/buyer-offer/record-contract-addendum.ts — THE DOOR FOR AN EXECUTED ADDENDUM / AMENDMENT (wave 143, lane 143A).
 *
 * Owner (wave 143): "a counter supersedes the contract terms" — and so does an addendum signed after the contract. The precedence
 * rule (lib/offers/governing-terms.ts resolveGoverningTerms) and the immutable record (contract_term_versions, m797) already take an
 * `addendum` / `amendment` version, and the offers chain supplies counters by itself; this is the one door through which a person
 * records an addendum that was signed OUTSIDE the offers chain (a repair credit, a closing-date extension, a title-policy change).
 *
 * What it will NOT do — nothing here invents anything:
 *   · it records no addendum on a contract that is not executed yet (there is nothing to amend);
 *   · it records an EXECUTED version only from a stored document that shows BOTH parties' signatures (recordContractTermsVersion
 *     refuses the rest by name) — the date and the terms are the agent's own confirmed reading of that document;
 *   · it signs nothing, accepts nothing and creates no transaction.
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant is the SESSION's (requireCaller), the caller must be the contract's
 * agent or a tenant admin, and the service client is used only AFTER that gate. Closing compliance reads the result through the
 * ONE reader, governingContractTerms — it never reads this record directly.
 */

import { requireCaller } from "@/lib/auth/require-caller"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import { governingContractTerms, recordContractTermsVersion } from "@/lib/offers/governing-terms"

/** A calendar day, exactly as printed on the signed document (yyyy-mm-dd), that is a real day and not in the future. */
function executedDayError(raw: unknown, now: Date): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "Give the date the addendum was fully signed, as yyyy-mm-dd."
  const d = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return `${raw} is not a calendar date.`
  // one day of slack for the writer's timezone; a signature date in the future is not a signature date
  if (d.getTime() > now.getTime() + 24 * 3_600_000) return "An addendum cannot have been signed in the future."
  return null
}

export async function recordContractAddendum(params: {
  /** The transaction the addendum changes… */
  transactionId?: string
  /** …or, before one exists, any offer in the contract's chain. Exactly one of the two. */
  offerId?: string
  kind: "addendum" | "amendment"
  /** The stored document that IS the executed addendum (it must show the buyer's and the seller's signatures). */
  documentId: string
  /** ONLY the terms the addendum changes, in the contract-term vocabulary. An explicit null strikes a term. */
  terms: Record<string, unknown>
  /** The day it was fully signed, yyyy-mm-dd. */
  executedOn: string
  /** WAVE 145 (lane 145C, owner ruling 8): the day the change TAKES EFFECT when the instrument states one apart from its
   *  execution (yyyy-mm-dd). Kept as evidence on the version and carried to its consequences; precedence stays execution order. */
  effectiveOn?: string | null
}): Promise<{
  success: boolean
  error?: string
  versionNo?: number
  /** WAVE 145: what the executed change set in motion (affected obligations, compliance re-review, settlement, CDA, notices). */
  consequences?: { obligations: string[]; settlement: string; cda: string | null; resendCdaToTitle: boolean; complianceOpenBlocking: number; needsHuman: string[] }
}> {
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (!!params.transactionId === !!params.offerId) return { success: false, error: "Name the transaction OR an offer in the contract's chain — exactly one." }
  if (params.transactionId && !isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (params.offerId && !isValidUUID(params.offerId)) return { success: false, error: "Invalid offer ID" }
  if (params.kind !== "addendum" && params.kind !== "amendment") return { success: false, error: "Say whether this is an addendum or an amendment." }
  if (!isValidUUID(params.documentId)) return { success: false, error: "Invalid document ID" }
  if (!params.terms || typeof params.terms !== "object" || Array.isArray(params.terms)) return { success: false, error: "State the terms the addendum changes." }
  const dayError = executedDayError(params.executedOn, new Date())
  if (dayError) return { success: false, error: dayError }
  const effectiveOn = params.effectiveOn ? String(params.effectiveOn) : null
  if (effectiveOn && (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) || new Date(`${effectiveOn}T00:00:00.000Z`).toISOString().slice(0, 10) !== effectiveOn)) {
    return { success: false, error: "Give the date the change takes effect as yyyy-mm-dd (or leave it empty when it takes effect on signing)." }
  }

  const svc = createServiceClient()
  const ref = params.transactionId ? { transactionId: params.transactionId } : { offerId: params.offerId as string }
  const current = await governingContractTerms(svc as any, caller.brokerageId, ref)
  if (!current.ok) return { success: false, error: `The contract could not be read: ${current.reason}` }
  if (!current.governing.governingVersion) return { success: false, error: "There is no executed contract to amend yet — an addendum changes a contract both parties have signed." }

  // the gate: the contract's agent, or a tenant admin (a contract with no offer chain on it is the admin class's alone)
  if (!TENANT_ADMIN_USER_TYPES.has(String(caller.userType ?? "").toLowerCase())) {
    if (!current.rootOfferId) return { success: false, error: "Only a brokerage admin can record an addendum on a contract with no offer on file." }
    const { data: root, error: rootErr } = await svc.from("offers").select("id, agent_id").eq("id", current.rootOfferId).eq("brokerage_id", caller.brokerageId).maybeSingle()
    if (rootErr) return { success: false, error: `Could not read the contract's offer: ${rootErr.message}` }
    const agentId = await resolveAgentIdInBrokerage(svc as any, caller.userId, caller.brokerageId)
    if (!root || !agentId || (root as { agent_id?: string | null }).agent_id !== agentId) return { success: false, error: "Only the contract's agent or a brokerage admin can record an addendum on it." }
  }

  // End of the stated day: an addendum amends a contract that already exists, so on a same-day tie it is the later act
  // (the resolver also ranks addendum/amendment after counters at equal instants).
  const executedAt = `${params.executedOn}T23:59:59.999Z`
  const rec = await recordContractTermsVersion(svc as any, {
    brokerageId: caller.brokerageId, rootOfferId: current.rootOfferId, transactionId: current.transactionId,
    source: params.kind, status: "executed", terms: params.terms, documentId: params.documentId, executedAt, recordedBy: caller.userId,
    evidence: { recorded_via: "record_contract_addendum", executed_on: params.executedOn, ...(effectiveOn ? { effective_on: effectiveOn } : {}) },
  })
  if (!rec.ok) return { success: false, error: rec.reason }

  // evidence (best effort — the version is recorded; a lost event is logged, not a reason to fail the agent)
  try {
    const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
    await recordLifecycleEvent(svc as any, caller.brokerageId, {
      event_type: "contract.addendum.recorded",
      payload: { kind: params.kind, version_no: rec.versionNo, document_id: params.documentId, executed_on: params.executedOn, terms: Object.keys(params.terms), transaction_id: current.transactionId, root_offer_id: current.rootOfferId },
      source: "ui", user_id: caller.userId,
      entity_type: current.transactionId ? "transaction" : "offer", entity_id: (current.transactionId ?? current.rootOfferId) as string,
    }, { dedupeWindowHours: null })
  } catch (err) {
    console.error(`[record-contract-addendum] version ${rec.versionNo} recorded but its lifecycle event was not written:`, (err as Error)?.message ?? err)
  }
  const c = rec.consequences
  return {
    success: true,
    versionNo: rec.versionNo,
    consequences: c
      ? {
          obligations: c.impact.obligations,
          settlement: c.settlement.detail,
          cda: c.cda?.outcome ?? null,
          resendCdaToTitle: c.cda?.resendToTitle ?? false,
          complianceOpenBlocking: c.complianceReReview.openBlocking,
          needsHuman: c.errors,
        }
      : undefined,
  }
}
