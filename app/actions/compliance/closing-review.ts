"use server"

/**
 * app/actions/compliance/closing-review.ts — WAVE 153 (lane 153D). FINAL CLOSING COMPLIANCE: THE READINESS LIST AND THE DECISION.
 *
 * Owner (verbatim, 2026-11-14): "when the transaction is closing and goes through a compliance review, they take charge of approving
 * and making sure all docs are accurate and submitted (settlement statement and cda-if required are part of the check)".
 *
 * Every export is a public endpoint (CLAUDE.md §4): the tenant comes from the SESSION (resolveSessionActor), the deal is read pinned to
 * it, the viewer is gated (the deal's agent, its TC or tenant staff — the closing-question roster), and only then is the service
 * client used. The decision rule is lib/transactions/closing-compliance-core.ts; the reads, the writer, the gate and the checklist amendment are
 * lib/transactions/closing-compliance.ts (loadClosingReadiness / recordClosingReviewDecision / amendDealChecklistVersion).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Gate =
  | { ok: true; actor: { userId: string; agentId: string | null; brokerageId: string; userType: string; isTenantPrincipal?: boolean }; svc: ReturnType<typeof import("@/lib/supabase/service").createServiceClient> }
  | { ok: false; error: string }

/** A refusal the reviewer reads, through THE PRESENTER (153D-8, wave 153 lane 153Q): raw database / ledger detail is LOGGED with a
 *  reference by presentTenantError and never shown; the sentence itself is gated by tenantCopyVerdict. Module-private. */
async function presentRefusal(what: string, detail?: string): Promise<string> {
  const { presentTenantError, presentTenantMessage } = await import("@/lib/errors")
  return (detail
    ? presentTenantError({ what, raw: detail, next: "you", action: null, context: "closing-review" })
    : presentTenantMessage({ what, next: "you" })).sentence
}

/** The session actor, admitted to THIS deal (its agent, its TC, or tenant staff). Module-private. */
async function gateDeal(transactionId: string): Promise<Gate> {
  if (!UUID.test(String(transactionId ?? ""))) return { ok: false, error: "Choose a deal." }
  const { resolveSessionActor } = await import("@/lib/agreements/session-actor")
  const s = await resolveSessionActor()
  if (!s.ok) return { ok: false, error: "Sign in again to see this closing." }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const B = s.actor.brokerageId
  const { data: tx, error } = await svc.from("transactions").select("agent_id, buyer_agent_id, seller_agent_id, coordinator_id").eq("id", transactionId).eq("brokerage_id", B).maybeSingle()
  if (error) return { ok: false, error: "The deal couldn't be read just now. Try again shortly." }
  if (!tx) return { ok: false, error: "This deal isn't in your account." }
  const t = tx as { agent_id: string | null; buyer_agent_id: string | null; seller_agent_id: string | null; coordinator_id: string | null }
  let coordinatorUserId: string | null = null
  if (t.coordinator_id) {
    const { data: tc, error: tcErr } = await svc.from("transaction_coordinators").select("user_id").eq("id", t.coordinator_id).eq("brokerage_id", B).maybeSingle()
    if (tcErr) return { ok: false, error: "The deal team couldn't be read just now. Try again shortly." }
    coordinatorUserId = (tc as { user_id?: string | null } | null)?.user_id ?? null
  }
  const { mayAttestClosing } = await import("@/lib/commission/closing-verification")
  if (!mayAttestClosing(s.actor, { agentIds: [t.agent_id, t.buyer_agent_id, t.seller_agent_id], coordinatorUserId })) return { ok: false, error: "Only the deal's agent, its TC or your compliance team can see this closing review." }
  return { ok: true, actor: s.actor, svc }
}

/** The ONE readiness list for the deal's closing, the reviewer's standing, and whether this viewer may decide. */
export async function getClosingReadinessAction(input: { transactionId: string }) {
  const g = await gateDeal(input?.transactionId)
  if (!g.ok) return { success: false as const, error: g.error }
  const { loadClosingReadiness, mayReviewClosing } = await import("@/lib/transactions/closing-compliance")
  const { READINESS_GROUP_LABEL } = await import("@/lib/transactions/closing-compliance-core")
  const r = await loadClosingReadiness(g.svc as never, { brokerageId: g.actor.brokerageId, transactionId: input.transactionId })
  if (!r.ok) return { success: false as const, error: "The closing file couldn't be read just now, so nothing is shown as ready. Try again shortly." }
  const canDecide = mayReviewClosing(g.actor)
  // The deal's current portal-rail documents and its assigned issuers — what the team picks from when a vendor's corrected file
  // arrived OFF the platform (recordOffPlatformIssuerDocumentAction). A refused read leaves the form empty and says so.
  const B = g.actor.brokerageId, T = input.transactionId
  const [docs, assignments, escrow] = await Promise.all([
    g.svc.from("transaction_documents").select("id, doc_label, doc_type, metadata").eq("brokerage_id", B).eq("transaction_id", T).order("created_at", { ascending: false }).limit(50),
    g.svc.from("vendor_assignments").select("vendor_id").eq("brokerage_id", B).eq("transaction_id", T),
    g.svc.from("transaction_title_escrow").select("title_company_name").eq("brokerage_id", B).eq("transaction_id", T).limit(1),
  ])
  const { isSupersededDocument } = await import("@/lib/compliance/required-documents")
  const issuerDocuments = ((docs.data ?? []) as Array<{ id: string; doc_label: string | null; doc_type: string | null; metadata: unknown }>)
    .filter((d) => !isSupersededDocument(d.metadata)).map((d) => ({ id: d.id, label: d.doc_label || d.doc_type || "Document" }))
  const issuers: Array<{ kind: "title"; name: string } | { kind: "lender" | "vendor"; vendorId: string; name: string }> = []
  const escrowName = ((escrow.data ?? []) as Array<{ title_company_name: string | null }>)[0]
  if (escrowName) issuers.push({ kind: "title", name: escrowName.title_company_name || "The deal's title company" })
  const vendorIds = [...new Set(((assignments.data ?? []) as Array<{ vendor_id: string | null }>).map((a) => a.vendor_id).filter((x): x is string => !!x))]
  if (vendorIds.length) {
    const { data: vendors } = await g.svc.from("vendors").select("id, name, category").eq("brokerage_id", B).in("id", vendorIds)
    const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
    for (const v of (vendors ?? []) as Array<{ id: string; name: string | null; category: string | null }>) issuers.push({ kind: isLenderVendorCategory(v.category) ? "lender" : "vendor", vendorId: v.id, name: v.name || "Vendor" })
  }
  return {
    success: true as const,
    readiness: r.loaded.readiness,
    groupLabels: READINESS_GROUP_LABEL,
    standing: r.loaded.standing,
    required: r.loaded.required,
    latest: r.loaded.latest ? { decision: r.loaded.latest.decision, notes: r.loaded.latest.notes, decidedAt: r.loaded.latest.decidedAt } : null,
    checklistVersionAt: r.loaded.checklistVersionAt,
    canDecide,
    offPlatform: { documents: issuerDocuments, issuers, unreadable: !!(docs.error || assignments.error || escrow.error) },
  }
}

/** A reviewer approves, holds or rejects the closing (notes required to hold / reject). Approval is refused while anything holds it. */
export async function recordClosingReviewDecisionAction(input: { transactionId: string; decision: "approve" | "hold" | "reject"; notes?: string | null }) {
  const g = await gateDeal(input?.transactionId)
  if (!g.ok) return { success: false as const, error: g.error }
  if (!["approve", "hold", "reject"].includes(String(input?.decision))) return { success: false as const, error: "Choose approve, hold or reject." }
  const { recordClosingReviewDecision } = await import("@/lib/transactions/closing-compliance")
  const r = await recordClosingReviewDecision(g.svc as never, g.actor, { transactionId: input.transactionId, decision: input.decision, notes: input.notes ?? null })
  if (!r.ok) return { success: false as const, error: await presentRefusal(r.error, r.detail) }
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, standing: r.standing, replay: r.replay }
}

/** A reviewer applies TODAY's brokerage checklist to this one deal, with a written reason (the deal otherwise keeps its own version). */
export async function amendDealChecklistAction(input: { transactionId: string; reason: string }) {
  const g = await gateDeal(input?.transactionId)
  if (!g.ok) return { success: false as const, error: g.error }
  const { amendDealChecklistVersion } = await import("@/lib/transactions/closing-compliance")
  const r = await amendDealChecklistVersion(g.svc as never, g.actor, { transactionId: input.transactionId, reason: String(input?.reason ?? "") })
  if (!r.ok) return { success: false as const, error: await presentRefusal(r.error, r.detail) }
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, rules: r.rules, rechecked: r.rechecked, openBlocking: r.openBlocking }
}
