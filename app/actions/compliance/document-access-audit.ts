"use server"

/**
 * DOCUMENT ACCESS AUDIT — the compliance-officer-facing reader for
 * document_audit_trail (wave 46 lane EC, orphan doctrine §1.2).
 *
 * document_audit_trail has THREE writers, all in app/actions/dotloop-integration.ts
 * (sendForDotloopSignature, createDocumentShareLink, generateDocumentFromTemplate) —
 * each stamps action / document_id / document_source / performed_by / performed_by_type
 * / notes on every send-for-signature, share-link mint, and template-generated
 * document. Measured (npx tsx scripts/readerless-write-census.ts --list): action,
 * document_id, document_source, notes and performed_by_type were READ BY NOTHING —
 * a compliance trail three code paths carefully wrote and no surface ever showed a
 * compliance officer. (performed_by already had a reader — an RLS policy, not
 * application code — which is why the census marks it [sql:rls] rather than dead.)
 *
 * This is the missing reader, built rather than left write-only. document_audit_trail
 * carries no brokerage_id (verified against the live schema), so tenancy is enforced
 * by joining through the owning document — every current writer stamps
 * document_source:'client_documents', so the audit trail is scoped by resolving
 * which of its document_ids belong to client_documents rows in the caller's own
 * brokerage, and only those rows are returned. A row whose document_source names a
 * table this reader does not yet resolve is reported, never silently dropped —
 * "unresolved tenant" is the honest answer, not an empty list pretending to be clean.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { resolveActorNames } from "@/lib/kernel/actor-attribution"

export interface DocumentAccessAuditRow {
  id: string
  documentId: string
  documentSource: string
  documentName: string | null
  action: string
  notes: string | null
  performedBy: string | null
  performedByName: string | null
  performedByType: string | null
  createdAt: string
}

export interface DocumentAccessAuditResult {
  success: boolean
  rows: DocumentAccessAuditRow[]
  /** document_audit_trail rows whose document_source this reader cannot yet
   *  resolve to a tenant — counted so the surface can say "N unresolved" rather
   *  than silently shrinking the list. */
  unresolvedCount: number
  nameLookupError?: string | null
  error?: string
}

// The only document_source this reader knows how to scope to a tenant today —
// every live writer stamps this value. A future writer naming a different
// source (e.g. 'transaction_documents') is COUNTED as unresolved above rather
// than assumed safe to show or silently dropped.
const RESOLVABLE_SOURCE = "client_documents"

/**
 * Read the brokerage's document access/audit trail for the compliance surface.
 * Gated: caller's user_type must be in TENANT_ADMIN_USER_TYPES (broker, admin,
 * broker_owner, team_lead, broker_admin, compliance_officer — isAdminOrBroker
 * is the pure predicate over that same roster, CLAUDE.md §4). Brokerage comes
 * from the SESSION, never a parameter.
 */
export async function getDocumentAccessAudit(): Promise<DocumentAccessAuditResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, rows: [], unresolvedCount: 0, error: "Unauthorized" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { success: false, rows: [], unresolvedCount: 0, error: `Could not verify your account: ${profileError.message}` }
  if (!profile?.brokerage_id) return { success: false, rows: [], unresolvedCount: 0, error: "No brokerage" }
  if (!isAdminOrBroker({ user_type: profile.user_type as string | null })) {
    return { success: false, rows: [], unresolvedCount: 0, error: "Not authorized for the compliance document audit" }
  }

  const brokerageId = profile.brokerage_id as string
  const svc = createServiceClient()

  // Recent trail entries, newest first. `error` destructured — a refused read
  // must never render as "nothing has happened" (§4/§2).
  const { data: trail, error: trailError } = await svc
    .from("document_audit_trail")
    .select("id, document_id, document_source, action, notes, performed_by, performed_by_type, created_at")
    .order("created_at", { ascending: false })
    .limit(200)
  if (trailError) return { success: false, rows: [], unresolvedCount: 0, error: `Could not read the document audit trail: ${trailError.message}` }

  const resolvable = (trail ?? []).filter((r) => r.document_source === RESOLVABLE_SOURCE)
  const unresolvedCount = (trail ?? []).length - resolvable.length

  const documentIds = [...new Set(resolvable.map((r) => r.document_id as string).filter(Boolean))]
  const docNameById = new Map<string, string | null>()
  if (documentIds.length > 0) {
    // Tenant boundary: only THIS brokerage's documents make a trail row visible.
    const { data: docs, error: docsError } = await svc
      .from("client_documents")
      .select("id, document_name")
      .in("id", documentIds)
      .eq("brokerage_id", brokerageId)
    if (docsError) return { success: false, rows: [], unresolvedCount: 0, error: `Could not verify the audited documents: ${docsError.message}` }
    for (const d of docs ?? []) docNameById.set(d.id as string, (d.document_name as string | null) ?? null)
  }

  const inTenant = resolvable.filter((r) => docNameById.has(r.document_id as string))

  const actorIds = [...new Set(inTenant.map((r) => r.performed_by as string | null).filter((v): v is string => !!v))]
  const { names, error: nameLookupError } = await resolveActorNames(svc, actorIds, { brokerageId })

  const rows: DocumentAccessAuditRow[] = inTenant.map((r) => ({
    id: r.id as string,
    documentId: r.document_id as string,
    documentSource: r.document_source as string,
    documentName: docNameById.get(r.document_id as string) ?? null,
    action: r.action as string,
    notes: (r.notes as string | null) ?? null,
    performedBy: (r.performed_by as string | null) ?? null,
    performedByName: r.performed_by ? (names.get(r.performed_by as string) ?? null) : null,
    performedByType: (r.performed_by_type as string | null) ?? null,
    createdAt: r.created_at as string,
  }))

  return { success: true, rows, unresolvedCount, nameLookupError }
}
