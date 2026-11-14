"use server"

/**
 * THE CLOSING DISCLOSURE RECEIPT DOORS (wave 153, lane 153C; directive §153C C2; owner ruling 6).
 *
 * Every export is a public endpoint (CLAUDE.md §4). Each door resolves WHO the caller is from the SESSION — never a body field —
 * then hands the ONE writer (lib/compliance/trid-disclosure-clock-evidence.ts recordTridReceiptEvidence) an actor KIND, which is
 * what decides source and verification:
 *   · recordLenderClosingDisclosureReceiptAction   the deal's ASSIGNED lender vendor (lib/kernel/portal-auth.ts requireLenderVendorActor,
 *                                                   then the writer re-checks assignment + category + tenant) → lender-confirmed
 *   · reportClosingDisclosureReceiptAction          the OWNING AGENT or the deal's TC (lib/auth/deal-work-ownership.ts) → reported,
 *                                                   pending the lender's confirmation — never a started clock (the coaching moment)
 *   · verifyReportedClosingDisclosureReceiptAction  compliance / a tenant admin with the lender's WRITTEN confirmation filed on the deal
 *   · getTridDisclosureStatusAction / getLenderTridStatusAction   the read doors (tenant staff with read access / the assigned lender)
 * No outbound message is sent by any door; nothing here edits a lender document.
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { presentTenantMessage } from "@/lib/errors"

type Result<T = Record<string, never>> = ({ success: true } & T) | { success: false; error: string }

function refuse(what: string, next: "you" | "account_admin" = "you"): { success: false; error: string } {
  return { success: false, error: presentTenantMessage({ what, work: { state: "not_saved" }, next }).sentence }
}

interface ReceiptFields {
  transactionId: string
  version: number
  supersedesId?: string | null
  issuerName: string
  senderRole: string
  senderName?: string | null
  deliveryMethod: string
  deliveredAt?: string | null
  receivedAt?: string | null
  receiptTimezone: string
  receiptEvidence: string
  acknowledgmentSignedAt?: string | null
  documentId?: string | null
  revisionChanges?: string[] | null
  aprPrevious?: number | null
  aprCurrent?: number | null
  notes?: string | null
}

/** ONLY the evidence fields cross the door — never a tenant, an actor, a source, a verification or a "today". */
function pickReceiptFields(input: ReceiptFields) {
  return {
    transactionId: input?.transactionId, version: input?.version, supersedesId: input?.supersedesId ?? null, issuerName: input?.issuerName,
    senderRole: input?.senderRole, senderName: input?.senderName ?? null, deliveryMethod: input?.deliveryMethod, deliveredAt: input?.deliveredAt ?? null,
    receivedAt: input?.receivedAt ?? null, receiptTimezone: input?.receiptTimezone, receiptEvidence: input?.receiptEvidence,
    acknowledgmentSignedAt: input?.acknowledgmentSignedAt ?? null, documentId: input?.documentId ?? null, revisionChanges: input?.revisionChanges ?? [],
    aprPrevious: input?.aprPrevious ?? null, aprCurrent: input?.aprCurrent ?? null, notes: input?.notes ?? null,
  }
}

/** The assigned LENDER records the delivery and the buyer's receipt (or a correction / revision) — lender-confirmed. */
export async function recordLenderClosingDisclosureReceiptAction(input: ReceiptFields & { regularity?: string | null; newWaitDetermination?: string | null }): Promise<Result<{ readinessState: string; earliestConsummationDate: string | null }>> {
  const { requireLenderVendorActor } = await import("@/lib/kernel/portal-auth")
  let actor: { userId: string; vendorId: string; brokerageId: string }
  try {
    actor = await requireLenderVendorActor(input?.transactionId)
  } catch {
    return refuse("Only the lender assigned to this loan can record its Closing Disclosure")
  }
  const { recordTridReceiptEvidence } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const r = await recordTridReceiptEvidence(createServiceClient(), {
    ...pickReceiptFields(input), brokerageId: actor.brokerageId, actor: { userId: actor.userId, kind: "lender", lenderVendorId: actor.vendorId },
    lenderContactName: null, lenderContactMethod: null, regularity: input?.regularity ?? null, newWaitDetermination: input?.newWaitDetermination ?? null,
  })
  if (!r.ok) return refuse(r.error)
  revalidatePath(`/lender/underwriting/${input.transactionId}`)
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true, readinessState: r.readiness.state, earliestConsummationDate: r.readiness.governing?.earliestConsummationDate ?? null }
}

/**
 * The OWNING AGENT or the deal's TC records what the LENDER said (lender off the platform). Stored as reported — pending the
 * lender's confirmation — and it does NOT start the waiting period. Who at the lender said it, and how, is required.
 */
export async function reportClosingDisclosureReceiptAction(input: ReceiptFields & { lenderContactName: string; lenderContactMethod?: string | null }): Promise<Result<{ readinessState: string }>> {
  const auth = await requireCallerTenant()
  if (!auth.ok) return refuse(auth.error)
  const svc = createServiceClient()
  const { loadDealWorkAccess } = await import("@/lib/auth/deal-work-ownership")
  const access = await loadDealWorkAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType ?? null, transactionId: input?.transactionId })
  if (!access.ok) return refuse("This deal's roles could not be checked right now")
  const a = access.access
  const kind = a.roles.includes("owning_agent") ? "agent" : a.roles.includes("assisting_tc") ? "tc" : null
  if (!kind || !a.capabilities.assist) return refuse("Only the deal's agent or its transaction coordinator can record what the lender said, while the deal is active")
  const { recordTridReceiptEvidence } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const r = await recordTridReceiptEvidence(svc, {
    ...pickReceiptFields(input), brokerageId: auth.brokerageId, actor: { userId: auth.userId, kind },
    lenderContactName: input.lenderContactName, lenderContactMethod: input.lenderContactMethod ?? null,
  })
  if (!r.ok) return refuse(r.error)
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true, readinessState: r.readiness.state }
}

/**
 * Compliance or a tenant admin VERIFIES a reported receipt with the lender's WRITTEN confirmation (a document already filed on the
 * deal). The verifying row supersedes the report and is lender-confirmed; the lender's classification / determination may be
 * recorded only as that document states it.
 */
export async function verifyReportedClosingDisclosureReceiptAction(input: {
  transactionId: string; reportedReceiptId: string; documentId: string; regularity?: string | null; newWaitDetermination?: string | null; notes?: string | null
}): Promise<Result<{ readinessState: string; earliestConsummationDate: string | null }>> {
  const auth = await requireCallerTenant()
  if (!auth.ok) return refuse(auth.error)
  const svc = createServiceClient()
  const { loadDealWorkAccess } = await import("@/lib/auth/deal-work-ownership")
  const access = await loadDealWorkAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType ?? null, transactionId: input?.transactionId })
  if (!access.ok) return refuse("This deal's roles could not be checked right now")
  if (!access.access.capabilities.verifyLenderEvidence) return refuse("Only compliance or an account admin can verify a reported receipt", "account_admin")
  const { data: reported, error } = await svc.from("trid_disclosure_receipts")
    .select("id, disclosure_version, issuer_name, sender_role, sender_name, delivery_method, delivered_at, received_at, receipt_timezone, receipt_evidence, acknowledgment_signed_at, revision_changes, apr_previous, apr_current, verification_status")
    .eq("id", input.reportedReceiptId).eq("brokerage_id", auth.brokerageId).eq("transaction_id", input.transactionId).maybeSingle()
  if (error) return refuse("The reported receipt could not be read right now")
  if (!reported) return refuse("The reported receipt was not found on this deal")
  const p = reported as Record<string, any>
  const { recordTridReceiptEvidence } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const r = await recordTridReceiptEvidence(svc, {
    brokerageId: auth.brokerageId, transactionId: input.transactionId, actor: { userId: auth.userId, kind: "compliance" },
    version: Number(p.disclosure_version), supersedesId: String(p.id), issuerName: String(p.issuer_name), senderRole: String(p.sender_role),
    senderName: p.sender_name ?? null, deliveryMethod: String(p.delivery_method), deliveredAt: p.delivered_at ?? null, receivedAt: p.received_at ?? null,
    receiptTimezone: String(p.receipt_timezone), receiptEvidence: String(p.receipt_evidence), acknowledgmentSignedAt: p.acknowledgment_signed_at ?? null,
    documentId: input.documentId, revisionChanges: Array.isArray(p.revision_changes) ? p.revision_changes : [],
    aprPrevious: p.apr_previous == null ? null : Number(p.apr_previous), aprCurrent: p.apr_current == null ? null : Number(p.apr_current),
    regularity: input.regularity ?? null, newWaitDetermination: input.newWaitDetermination ?? null, notes: input.notes ?? null,
  })
  if (!r.ok) return refuse(r.error)
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true, readinessState: r.readiness.state, earliestConsummationDate: r.readiness.governing?.earliestConsummationDate ?? null }
}

interface ReceiptView {
  id: string; version: number; source: string; verification: string; deliveryMethod: string; evidence: string
  deliveredAt: string | null; receivedAt: string | null; timezone: string; issuerName: string; lenderContactName: string | null
  supersedesId: string | null; revisionChanges: string[]; createdAt: string
}

async function receiptViews(svc: ReturnType<typeof createServiceClient>, brokerageId: string, transactionId: string): Promise<{ ok: true; rows: ReceiptView[] } | { ok: false }> {
  const { data, error } = await svc.from("trid_disclosure_receipts")
    .select("id, disclosure_version, source, verification_status, delivery_method, receipt_evidence, delivered_at, received_at, receipt_timezone, issuer_name, lender_contact_name, supersedes_id, revision_changes, created_at")
    .eq("brokerage_id", brokerageId).eq("transaction_id", transactionId).order("created_at", { ascending: true })
  if (error) return { ok: false }
  return {
    ok: true,
    rows: ((data ?? []) as Array<Record<string, any>>).map((r) => ({
      id: String(r.id), version: Number(r.disclosure_version), source: String(r.source), verification: String(r.verification_status),
      deliveryMethod: String(r.delivery_method), evidence: String(r.receipt_evidence), deliveredAt: r.delivered_at ?? null, receivedAt: r.received_at ?? null,
      timezone: String(r.receipt_timezone), issuerName: String(r.issuer_name), lenderContactName: r.lender_contact_name ?? null,
      supersedesId: r.supersedes_id ?? null, revisionChanges: Array.isArray(r.revision_changes) ? r.revision_changes : [], createdAt: String(r.created_at ?? ""),
    })),
  }
}

/** The status panel's read for tenant staff with read access to the deal (agent, TC, compliance, admins, the team lead). */
export async function getTridDisclosureStatusAction(transactionId: string): Promise<Result<{
  item: { status: string; blocking: boolean; detail: string; nextAction: string }
  readiness: { state: string; coaching: string | null; earliestConsummationDate: string | null; effectiveReceiptDate: string | null; reasons: string[]; reportedPendingId: string | null }
  lender: { name: string | null; onPlatform: boolean }
  receipts: ReceiptView[]
  documents: Array<{ id: string; label: string }>
  can: { report: boolean; verify: boolean }
}>> {
  const auth = await requireCallerTenant()
  if (!auth.ok) return refuse(auth.error)
  const svc = createServiceClient()
  const { loadDealWorkAccess } = await import("@/lib/auth/deal-work-ownership")
  const access = await loadDealWorkAccess(svc, { userId: auth.userId, brokerageId: auth.brokerageId, userType: auth.userType ?? null, transactionId })
  if (!access.ok) return refuse("This deal's roles could not be checked right now")
  if (!access.access.capabilities.read) return refuse("You do not have access to this deal")
  const { loadTridDealSnapshot, tridClosingReadinessItem } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const [snap, item, rows, docs] = await Promise.all([
    loadTridDealSnapshot(svc, { brokerageId: auth.brokerageId, transactionId }),
    tridClosingReadinessItem(svc, { brokerageId: auth.brokerageId, transactionId }),
    receiptViews(svc, auth.brokerageId, transactionId),
    svc.from("transaction_documents").select("id, doc_label, doc_type").eq("brokerage_id", auth.brokerageId).eq("transaction_id", transactionId).order("created_at", { ascending: false }).limit(50),
  ])
  if (!snap.ok || !rows.ok || docs.error) return refuse("The Closing Disclosure record could not be read right now")
  const r = snap.snapshot.readiness
  const a = access.access
  return {
    success: true,
    item: { status: item.status, blocking: item.blocking, detail: item.detail, nextAction: item.nextAction },
    readiness: { state: r.state, coaching: r.coaching, earliestConsummationDate: r.governing?.earliestConsummationDate ?? null, effectiveReceiptDate: r.governing?.effectiveReceiptDate ?? null, reasons: r.reasons, reportedPendingId: r.reportedPending?.id ?? null },
    lender: { name: snap.snapshot.lender.name, onPlatform: snap.snapshot.lender.onPlatform },
    receipts: rows.rows,
    documents: ((docs.data ?? []) as Array<{ id: string; doc_label: string | null; doc_type: string | null }>).map((d) => ({ id: d.id, label: d.doc_label ?? d.doc_type ?? "Document" })),
    can: { report: a.capabilities.assist && (a.roles.includes("owning_agent") || a.roles.includes("assisting_tc")), verify: a.capabilities.verifyLenderEvidence },
  }
}

/** The assigned lender's read of its own loan's Closing Disclosure record (no tenant financials beyond what it already holds). */
export async function getLenderTridStatusAction(transactionId: string): Promise<Result<{
  readiness: { state: string; earliestConsummationDate: string | null; effectiveReceiptDate: string | null; reasons: string[]; nextAction: string; reportedPendingId: string | null }
  receipts: ReceiptView[]
}>> {
  const { requireLenderVendorActor } = await import("@/lib/kernel/portal-auth")
  let actor: { brokerageId: string }
  try {
    actor = await requireLenderVendorActor(transactionId)
  } catch {
    return refuse("Only the lender assigned to this loan can view its Closing Disclosure record")
  }
  const svc = createServiceClient()
  const { loadTridDealSnapshot } = await import("@/lib/compliance/trid-disclosure-clock-evidence")
  const [snap, rows] = await Promise.all([loadTridDealSnapshot(svc, { brokerageId: actor.brokerageId, transactionId }), receiptViews(svc, actor.brokerageId, transactionId)])
  if (!snap.ok || !rows.ok) return refuse("The Closing Disclosure record could not be read right now")
  const r = snap.snapshot.readiness
  return {
    success: true,
    readiness: { state: r.state, earliestConsummationDate: r.governing?.earliestConsummationDate ?? null, effectiveReceiptDate: r.governing?.effectiveReceiptDate ?? null, reasons: r.reasons, nextAction: r.nextAction, reportedPendingId: r.reportedPending?.id ?? null },
    receipts: rows.rows.map((x) => ({ ...x, lenderContactName: null })),
  }
}
