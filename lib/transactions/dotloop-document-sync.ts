/**
 * lib/transactions/dotloop-document-sync.ts — THE Dotloop → client_documents
 * sync core, callable with no session (lane 86E, wave 86).
 *
 * THE DEFECT. app/api/cron/dotloop-sync (every 6 h, lib/kernel/cron-dispatch.ts)
 * called app/actions/dotloop-integration.ts::syncDotloopDocuments — a "use
 * server" action whose FIRST line is getAgentContext(), i.e. the cookie
 * session. A cron has no cookie, so every transaction came back
 * `{ success: false, error: "Unauthorized" }`, the route counted it as "not
 * synced" and reported the run as a SUCCESS with syncedCount 0. No signed
 * Dotloop document ever reached client_documents by the loop; only a person
 * clicking sync did it. Found by scripts/sessionless-use-server-census.ts.
 *
 * THE SHAPE (LANE_RULES wave 86: "Sessionless paths use a server-only core on
 * the service client with tenant from verified context"). The body moved here
 * UNCHANGED in what it writes; what changed is where the tenant comes from:
 *   · the session door (syncDotloopDocuments) passes ctx.brokerageId;
 *   · the cron passes the brokerage_id of the transaction row it read.
 * Either way every read and write carries `.eq("brokerage_id", brokerageId)`,
 * and the contact / transaction the caller names must sit in that tenant.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { syncLoopDocuments } from "@/lib/providers/esign"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { recordDocumentAccess } from "@/lib/documents/document-access-log"

export interface DotloopDocumentSyncInput {
  brokerageId: string
  loopId: string
  contactId: string
  transactionId?: string | null
}

export type DotloopDocumentSyncResult =
  | { success: true; syncedCount: number; skipped: number; refused: number }
  | { success: false; error: string }

/** The Dotloop folder name → client_documents.document_type (moved from the action, unchanged). */
function mapFolderToDocType(folderName: string): string {
  const lowerName = folderName.toLowerCase()
  if (lowerName.includes("contract")) return "contract"
  if (lowerName.includes("disclosure")) return "disclosure"
  if (lowerName.includes("inspection")) return "inspection"
  if (lowerName.includes("appraisal")) return "appraisal"
  if (lowerName.includes("loan")) return "loan_doc"
  if (lowerName.includes("closing")) return "closing_doc"
  return "other"
}

export async function syncDotloopLoopDocuments(svc: any, input: DotloopDocumentSyncInput): Promise<DotloopDocumentSyncResult> {
  const { brokerageId, loopId, contactId } = input
  const transactionId = input.transactionId ?? null
  if (!brokerageId) return { success: false, error: "Dotloop sync refused: no brokerageId (the tenant must come from a session or the transaction row)" }
  if (!loopId) return { success: false, error: "Dotloop sync refused: no loopId" }
  if (!contactId) return { success: false, error: "Dotloop sync refused: no contactId" }

  // The contact (and transaction) the caller names must be in the tenant.
  const { data: c, error: cErr } = await svc
    .from("contacts").select("id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (cErr) return { success: false, error: `Dotloop sync: contact read refused: ${cErr.message}` }
  if (!c) return { success: false, error: "Forbidden: contact not in your brokerage" }
  if (transactionId) {
    const { data: t, error: tErr } = await svc
      .from("transactions").select("id").eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
    if (tErr) return { success: false, error: `Dotloop sync: transaction read refused: ${tErr.message}` }
    if (!t) return { success: false, error: "Forbidden: transaction not in your brokerage" }
  }

  const sync = await syncLoopDocuments(loopId)
  if (!sync.success) return { success: false, error: sync.error ?? "syncLoopDocuments failed" }

  let syncedCount = 0
  let skipped = 0
  let refused = 0
  for (const folder of sync.folders) {
    for (const document of folder.documents || []) {
      // Already synced? A refused read is NOT "absent" — inserting on it could
      // duplicate the row, so it is counted and skipped (CLAUDE.md §3).
      const { data: existing, error: exErr } = await svc
        .from("client_documents")
        .select("id")
        .eq("dotloop_document_id", document.document_id)
        .eq("brokerage_id", brokerageId)
        .limit(1)
      if (exErr) { refused++; continue }
      if ((existing ?? []).length > 0) { skipped++; continue }

      const { data: inserted, error } = await svc.from("client_documents").insert({
        brokerage_id: brokerageId,
        contact_id: contactId,
        transaction_id: transactionId,
        dotloop_loop_id: loopId,
        dotloop_document_id: document.document_id,
        dotloop_folder_name: folder.name,
        document_name: document.name,
        document_type: mapFolderToDocType(folder.name),
        status: document.is_signed ? "signed" : "pending_signature",
        document_url: document.url,
      }).select("id").maybeSingle()

      if (error || !inserted?.id) { refused++; continue }
      syncedCount++
      // AUDIT — a document ARRIVING via provider sync is never opened through
      // issueGovernedDocumentUrl, so nothing else logs it. Best-effort: a failed
      // audit row never fails the sync that already succeeded (it is ledgered).
      await recordDocumentAccess(svc, brokerageId, {
        documentId: inserted.id,
        accessedByType: "external",
        accessType: "upload",
      }).catch((e) => console.error("[dotloop] access log (sync upload) failed:", e))
    }
  }

  if (transactionId) {
    // Freshness stamp only — ledgered rather than silenced (self_heal_events).
    await sentinelWrite(
      svc,
      svc.from("transactions")
        .update({ last_provider_sync_at: new Date().toISOString() })
        .eq("id", transactionId)
        .eq("brokerage_id", brokerageId),
      { table: "transactions", flow: "dotloop_document_sync", brokerageId },
    )
  }

  return { success: true, syncedCount, skipped, refused }
}
