"use server"

/**
 * Document Center server action — agent-facing unified view.
 *
 * Pulls from `client_documents` (canonical portal-used table) and joins
 * contacts + transactions for context. Role-aware:
 *   - Agents see docs for contacts they're assigned to
 *   - Broker / admin / TC / compliance_officer see all brokerage docs
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext } from "@/lib/platform/acting-context"
import { issueGovernedDocumentUrl, type AccessPurpose } from "@/lib/kernel/document-custody"

export interface DocumentCenterRow {
  id: string
  documentName: string
  documentType: string | null
  documentUrl: string
  uploadedAt: string
  contactId: string | null
  contactName: string | null
  transactionId: string | null
  transactionAddress: string | null
  scanStatus: "pass" | "warnings" | "blocking_issues" | "pending" | null
  signatureCompleteness: {
    allRequiredSignaturesPresent: boolean | null
    missingCount: number
  } | null
}

export interface DocumentCenterFolder {
  category: string
  label: string
  count: number
  documents: DocumentCenterRow[]
}

const FOLDER_LABELS: Record<string, string> = {
  contract: "Contracts",
  purchase_agreement: "Purchase Agreements",
  listing_agreement: "Listing Agreements",
  addendum: "Addenda",
  disclosure_form: "Disclosures",
  inspection_report: "Inspections",
  appraisal: "Appraisals",
  closing_disclosure: "Closing Disclosures",
  proof_of_funds: "Proof of Funds",
  bank_statement: "Bank Statements",
  drivers_license: "ID Documents",
  title_report: "Title Reports",
  correspondence: "Correspondence",
  other: "Other",
}

export async function getDocumentCenterData(): Promise<{
  success: boolean
  folders: DocumentCenterFolder[]
  totalCount: number
  pendingReviewCount: number
  blockingIssuesCount: number
  error?: string
}> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, folders: [], totalCount: 0, pendingReviewCount: 0, blockingIssuesCount: 0, error: "Unauthorized" }
  }

  // ACT-AS SEAM: read THROUGH ctx.db — the cookie/RLS client for a tenant seat, the
  // service client under an active impersonation grant. Its type is the seam's `any`,
  // so the row callbacks below are annotated explicitly rather than inferred.
  const supabase = ctx.db

  // Determine role-based filter
  const role = ctx.userType
  // SCOPE LADDER (kept inline — admits tc/compliance tiers): 'superadmin'
  // removed — dead as users.user_type (0 live rows); broker_owner added —
  // storable seat that owns the brokerage.
  const elevated = ["admin", "broker", "broker_owner", "broker_admin", "tc", "transaction_coordinator", "compliance_officer"].includes(role ?? "")

  // Build query
  let q = supabase
    .from("client_documents")
    .select(`
      id,
      document_name,
      document_type,
      document_url,
      created_at,
      contact_id,
      transaction_id,
      ai_metadata
    `)
    .order("created_at", { ascending: false })
    .limit(500)

  if (!elevated && ctx.agentId) {
    // Agents see only docs for contacts they own
    const { data: ownedContacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("agent_id", ctx.agentId)
    const contactIds = (ownedContacts ?? []).map((c: any) => c.id)
    if (contactIds.length === 0) {
      return { success: true, folders: [], totalCount: 0, pendingReviewCount: 0, blockingIssuesCount: 0 }
    }
    q = q.in("contact_id", contactIds)
  }

  const { data: docs, error } = await q

  if (error) {
    return { success: false, folders: [], totalCount: 0, pendingReviewCount: 0, blockingIssuesCount: 0, error: error.message }
  }

  // Hydrate contact + transaction context in two batched queries
  const contactIds = Array.from(new Set((docs ?? []).map((d: any) => d.contact_id).filter(Boolean) as string[]))
  const transactionIds = Array.from(new Set((docs ?? []).map((d: any) => d.transaction_id).filter(Boolean) as string[]))

  const [{ data: contacts }, { data: transactions }] = await Promise.all([
    contactIds.length > 0
      ? supabase.from("contacts").select("id, first_name, last_name").in("id", contactIds)
      : Promise.resolve({ data: [] as any[] }),
    transactionIds.length > 0
      ? supabase.from("transactions").select("id, property_address").in("id", transactionIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const contactMap = new Map((contacts ?? []).map((c: any) => [c.id, `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed"]))
  const txMap = new Map((transactions ?? []).map((t: any) => [t.id, t.property_address]))

  // Build rows + group by folder
  const rows: DocumentCenterRow[] = (docs ?? []).map((d: any) => {
    const aiMeta = d.ai_metadata as any
    const sig = aiMeta?.signatureCompleteness ?? null
    return {
      id: d.id,
      documentName: d.document_name,
      documentType: d.document_type,
      documentUrl: d.document_url,
      uploadedAt: d.created_at,
      contactId: d.contact_id,
      contactName: d.contact_id ? contactMap.get(d.contact_id) ?? null : null,
      transactionId: d.transaction_id,
      transactionAddress: d.transaction_id ? txMap.get(d.transaction_id) ?? null : null,
      scanStatus: aiMeta?.overallStatus ?? null,
      signatureCompleteness: sig
        ? {
            allRequiredSignaturesPresent: sig.allRequiredSignaturesPresent ?? null,
            missingCount:
              (sig.missingSignatures?.length ?? 0) + (sig.missingInitials?.length ?? 0),
          }
        : null,
    }
  })

  const folderMap = new Map<string, DocumentCenterRow[]>()
  for (const row of rows) {
    const cat = row.documentType ?? "other"
    if (!folderMap.has(cat)) folderMap.set(cat, [])
    folderMap.get(cat)!.push(row)
  }

  const folders: DocumentCenterFolder[] = Array.from(folderMap.entries())
    .map(([category, docs]) => ({
      category,
      label: FOLDER_LABELS[category] ?? category.replace(/_/g, " "),
      count: docs.length,
      documents: docs,
    }))
    .sort((a, b) => b.count - a.count)

  const pendingReviewCount = rows.filter((r) => r.scanStatus === "warnings").length
  const blockingIssuesCount = rows.filter((r) => r.scanStatus === "blocking_issues").length

  return {
    success: true,
    folders,
    totalCount: rows.length,
    pendingReviewCount,
    blockingIssuesCount,
  }
}

/**
 * GOVERNED document open — the custody-layer access path for the Document Center.
 *
 * The `client-documents` bucket is PRIVATE (scripts/511: public=false), so the bare
 * document_url (a getPublicUrl) does NOT resolve. This action resolves the requesting
 * agent's context, verifies the document is in their brokerage, then mints a
 * TIME-LIMITED signed URL via the custody layer and RECORDS the access on
 * document_access_log (who/when/why/doc). The UI should call this to OPEN a document
 * instead of linking the raw documentUrl.
 *
 * HONEST: a document whose document_url has no parsable bucket object (data: fallback
 * / external URL) returns ok:false with a reason — no fabricated URL.
 */
export async function getGovernedDocumentUrl(
  documentId: string,
  purpose: AccessPurpose = "view",
): Promise<{ success: boolean; url?: string; ttlSeconds?: number; error?: string }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  // Tenant scope check before issuing any access.
  const svc = createServiceClient()
  const { data: doc } = await svc
    .from("client_documents")
    .select("brokerage_id")
    .eq("id", documentId)
    .maybeSingle()
  if (!doc || (doc as any).brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const res = await issueGovernedDocumentUrl(
    {
      documentId,
      requestedBy: {
        // `type: "agent"` names the class; the id must match it (m361). The old
        // `?? ctx.userId` handed a governed-document authority check a users id
        // labelled as an agent.
        type: "agent",
        id: ctx.agentId ?? null,
      },
      purpose,
    },
    svc,
  )

  if (!res.ok || !res.signedUrl) {
    return { success: false, error: res.reason ?? "Could not issue a governed document URL" }
  }
  return { success: true, url: res.signedUrl, ttlSeconds: res.ttlSeconds }
}
