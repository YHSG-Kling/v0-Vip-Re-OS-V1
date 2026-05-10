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
      preliminary_cd_uploaded_at
    `)
    .eq("brokerage_id", auth.brokerageId)
    .or(`status.eq.submitted,and(status.eq.changes_requested,changes_requested_at.gte.${sevenDaysAgo})`)
    .order("agent_submitted_at", { ascending: true, nullsFirst: false })
    .limit(50)

  if (error) return { success: false, error: error.message }
  if (!cdas || cdas.length === 0) return { success: true, items: [] }

  // Resolve transaction property + agent name (separate batched lookups —
  // the table has no FK joins declared)
  const txnIds = Array.from(new Set(cdas.map(c => c.transaction_id).filter(Boolean)))
  const agentIds = Array.from(new Set(cdas.map(c => c.agent_id).filter(Boolean)))

  const [txnsRes, agentsRes] = await Promise.all([
    txnIds.length
      ? supabase.from("transactions").select("id, property_address").in("id", txnIds)
      : Promise.resolve({ data: [] as Array<{ id: string; property_address: string | null }> }),
    agentIds.length
      ? supabase.from("agents").select("id, user_id").in("id", agentIds)
      : Promise.resolve({ data: [] as Array<{ id: string; user_id: string | null }> }),
  ])

  const propertyByTxn = new Map<string, string | null>(
    (txnsRes.data ?? []).map(t => [t.id, t.property_address])
  )
  const userIds = (agentsRes.data ?? []).map(a => a.user_id).filter(Boolean) as string[]
  const usersRes = userIds.length
    ? await supabase.from("users").select("id, full_name").in("id", userIds)
    : { data: [] as Array<{ id: string; full_name: string | null }> }
  const nameByUserId = new Map<string, string | null>(
    (usersRes.data ?? []).map(u => [u.id, u.full_name])
  )
  const userIdByAgent = new Map<string, string | null>(
    (agentsRes.data ?? []).map(a => [a.id, a.user_id])
  )

  const items: CdaReviewItem[] = cdas.map(c => {
    const userId = userIdByAgent.get(c.agent_id) ?? null
    return {
      id:                       c.id,
      transactionId:            c.transaction_id,
      propertyAddress:          propertyByTxn.get(c.transaction_id) ?? null,
      agentName:                userId ? (nameByUserId.get(userId) ?? null) : null,
      status:                   c.status,
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
    }
  })

  return { success: true, items }
}
