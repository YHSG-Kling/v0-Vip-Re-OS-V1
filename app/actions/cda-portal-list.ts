"use server"

/**
 * Read-only sibling to app/actions/cda-portal.ts — list views the
 * compliance dashboard needs to surface CDAs awaiting review.
 *
 * Kept separate from cda-portal.ts (which holds the per-CDA actions:
 * draft, submit, approve, request-changes, override, send-to-title, etc.)
 * to avoid bloating that file. Same auth model — brokerage scope enforced.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { buildCdaContractVerdict, expectedGrossFromTerms, sumOutstandingAgentFees, type CdaDiscrepancy } from "@/lib/commission/cda-discrepancy"

const COMPLIANCE_ROLES = new Set([
  "compliance_officer",
  "admin",
  "broker",
  "broker_admin",
  "superadmin",
])

export interface CdaReviewItem {
  id:                       string
  transactionId:            string
  propertyAddress:          string | null
  agentName:                string | null
  status:                   string
  /** Set once the broker has applied their signature (the 2nd signature). */
  brokerApprovedAt:         string | null
  revisionNumber:           number
  grossCommission:          number | null
  agentNet:                 number | null
  brokerageNet:             number | null
  signatureCheckPassed:     boolean | null
  missingDocs:              Array<{ document_type: string; reason: string }> | null
  manualOverrideBy:         string | null
  agentSubmittedAt:         string | null
  changesRequestedAt:       string | null
  changesRequestedNotes:    string | null
  preliminaryCdUploadedAt:  string | null
  // Live split-vs-contract verdict (null = no contract on file ⇒ grandfathered).
  contractCheckPassed:      boolean | null
  contractDiscrepancies:    CdaDiscrepancy[] | null
  contractSplitPct:         number | null
  /** Unpaid fees the agent owes the brokerage — must be deducted in the CDA (0 = none). */
  outstandingFees:          number
}

/**
 * Returns CDAs in the brokerage that compliance currently needs to look at:
 *   • status = "submitted" (awaiting approve/request-changes/override)
 *   • status = "changes_requested" within the last 7 days (kept visible so
 *     compliance sees the back-and-forth without hunting)
 */
export async function listCdasForComplianceReviewAction(): Promise<{
  success: true; items: CdaReviewItem[]
} | {
  success: false; error: string
}> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false, error: "forbidden" }
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

  const { data: cdas, error } = await supabase
    .from("closing_disclosure_agreement")
    .select(`
      id, transaction_id, agent_id, status, revision_number,
      gross_commission, agent_net, brokerage_net,
      signature_check_passed, missing_docs, manual_override_by,
      agent_submitted_at, changes_requested_at, changes_requested_notes,
      preliminary_cd_uploaded_at, broker_approved_at
    `)
    .eq("brokerage_id", auth.brokerageId)
    // submitted (compliance review) + recent changes_requested + approved-awaiting-
    // broker-signature (broker_approved_at null) so the broker can sign in the panel.
    .or(`status.eq.submitted,and(status.eq.changes_requested,changes_requested_at.gte.${sevenDaysAgo}),and(status.eq.approved,broker_approved_at.is.null)`)
    .order("agent_submitted_at", { ascending: true, nullsFirst: false })
    .limit(50)

  if (error) return { success: false, error: error.message }
  if (!cdas || cdas.length === 0) return { success: true, items: [] }

  // Resolve transaction property + agent name (separate batched lookups —
  // the table has no FK joins declared)
  const txnIds = Array.from(new Set(cdas.map(c => c.transaction_id).filter(Boolean)))
  const agentIds = Array.from(new Set(cdas.map(c => c.agent_id).filter(Boolean)))

  const [txnsRes, agentsRes, profilesRes, capRes] = await Promise.all([
    txnIds.length
      ? supabase.from("transactions").select("id, property_address, estimated_commission, purchase_price, commission_percentage").in("id", txnIds)
      : Promise.resolve({ data: [] as Array<{ id: string; property_address: string | null; estimated_commission: number | null; purchase_price: number | null; commission_percentage: number | null }> }),
    agentIds.length
      ? supabase.from("agents").select("id, user_id").in("id", agentIds)
      : Promise.resolve({ data: [] as Array<{ id: string; user_id: string | null }> }),
    agentIds.length
      ? supabase.from("agent_commission_profiles").select("agent_id, split_percent, cap_amount, effective_date").eq("is_active", true).in("agent_id", agentIds).order("effective_date", { ascending: false })
      : Promise.resolve({ data: [] as Array<{ agent_id: string; split_percent: number | null; cap_amount: number | null; effective_date: string | null }> }),
    agentIds.length
      ? supabase.from("agent_cap_tracking").select("agent_id, cap_amount, cap_paid_to_date").eq("brokerage_id", auth.brokerageId).in("agent_id", agentIds)
      : Promise.resolve({ data: [] as Array<{ agent_id: string; cap_amount: number | null; cap_paid_to_date: number | null }> }),
  ])

  // Outstanding (unpaid) fees per agent — the amount that must be deducted in the CDA.
  const { data: feeChargeRows } = agentIds.length
    ? await supabase.from("agent_fee_charges")
        .select("agent_id, amount, status, paid_at")
        .eq("brokerage_id", auth.brokerageId).in("agent_id", agentIds).in("status", ["open", "overdue"])
    : { data: [] as Array<{ agent_id: string; amount: number | null; status: string | null; paid_at: string | null }> }
  const feeChargesByAgent = new Map<string, Array<{ amount?: number | null; status?: string | null; paid_at?: string | null }>>()
  for (const f of feeChargeRows ?? []) {
    const arr = feeChargesByAgent.get(f.agent_id) ?? []
    arr.push({ amount: f.amount, status: f.status, paid_at: f.paid_at })
    feeChargesByAgent.set(f.agent_id, arr)
  }

  const propertyByTxn = new Map<string, string | null>(
    (txnsRes.data ?? []).map(t => [t.id, t.property_address])
  )
  const termsByTxn = new Map(
    (txnsRes.data ?? []).map(t => [t.id, { estimated_commission: t.estimated_commission, purchase_price: t.purchase_price, commission_percentage: t.commission_percentage }])
  )
  // Latest active profile per agent (rows already sorted newest-first).
  const profileByAgent = new Map<string, { split_percent: number | null; cap_amount: number | null }>()
  for (const p of profilesRes.data ?? []) {
    if (!profileByAgent.has(p.agent_id)) profileByAgent.set(p.agent_id, { split_percent: p.split_percent, cap_amount: p.cap_amount })
  }
  const capByAgent = new Map<string, { cap_amount: number | null; cap_paid_to_date: number | null }>()
  for (const c of capRes.data ?? []) {
    const prev = capByAgent.get(c.agent_id)
    if (!prev || Number(c.cap_paid_to_date ?? 0) > Number(prev.cap_paid_to_date ?? 0)) capByAgent.set(c.agent_id, { cap_amount: c.cap_amount, cap_paid_to_date: c.cap_paid_to_date })
  }
  const userIds = (agentsRes.data ?? []).map(a => a.user_id).filter(Boolean) as string[]
  const usersRes = userIds.length
    ? await supabase.from("users").select("id, first_name, last_name").in("id", userIds)
    : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null }> }
  const nameByUserId = new Map<string, string | null>(
    (usersRes.data ?? []).map((u: any) => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || null])
  )
  const userIdByAgent = new Map<string, string | null>(
    (agentsRes.data ?? []).map(a => [a.id, a.user_id])
  )

  const items: CdaReviewItem[] = cdas.map(c => {
    const userId = userIdByAgent.get(c.agent_id) ?? null
    // Live split-vs-contract verdict (the compliance officer's "does the contract agree" check).
    const profile = profileByAgent.get(c.agent_id)
    const contractSplit = profile?.split_percent ?? null
    const outstandingFees = sumOutstandingAgentFees(feeChargesByAgent.get(c.agent_id) ?? [])
    let contractCheckPassed: boolean | null = null
    let contractDiscrepancies: CdaDiscrepancy[] | null = null
    if (contractSplit != null && Number.isFinite(contractSplit)) {
      const cap = capByAgent.get(c.agent_id)
      const capAmount = Number(cap?.cap_amount ?? profile?.cap_amount ?? 0)
      const capPaid = Number(cap?.cap_paid_to_date ?? 0)
      const capReached = capAmount > 0 && capPaid >= capAmount
      const terms = termsByTxn.get(c.transaction_id) ?? {}
      const v = buildCdaContractVerdict({
        computedGross: Number(c.gross_commission ?? 0),
        computedAgentNet: Number(c.agent_net ?? 0),
        expectedGross: expectedGrossFromTerms(terms as Record<string, number | null>),
        contractSplitPct: capReached ? 100 : contractSplit,
        outstandingFees,
      })
      contractCheckPassed = v.passed
      contractDiscrepancies = v.discrepancies.length ? v.discrepancies : null
    }
    return {
      id:                       c.id,
      transactionId:            c.transaction_id,
      propertyAddress:          propertyByTxn.get(c.transaction_id) ?? null,
      agentName:                userId ? (nameByUserId.get(userId) ?? null) : null,
      status:                   c.status,
      brokerApprovedAt:         c.broker_approved_at ?? null,
      revisionNumber:           c.revision_number ?? 1,
      grossCommission:          c.gross_commission,
      agentNet:                 c.agent_net,
      brokerageNet:             c.brokerage_net,
      signatureCheckPassed:     c.signature_check_passed,
      missingDocs:              (c.missing_docs as CdaReviewItem["missingDocs"]) ?? null,
      manualOverrideBy:         c.manual_override_by,
      agentSubmittedAt:         c.agent_submitted_at,
      changesRequestedAt:       c.changes_requested_at,
      changesRequestedNotes:    c.changes_requested_notes,
      preliminaryCdUploadedAt:  c.preliminary_cd_uploaded_at,
      contractCheckPassed,
      contractDiscrepancies,
      contractSplitPct:         contractSplit,
      outstandingFees,
    }
  })

  return { success: true, items }
}
