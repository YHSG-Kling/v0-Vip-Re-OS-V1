/**
 * lib/documents/document-access-log.ts — THE document_access_log WRITER for
 * the paths that already know the tenant (lane 86E, wave 86).
 *
 * WHY THIS EXISTS. app/actions/dotloop-integration.ts::logDocumentAccess was
 * the one checked, ledgered writer — but it is a "use server" action that
 * resolves the caller from the COOKIE session (getAgentContext) and wrote
 * through the cookie client. The Dotloop sync's autonomous half
 * (app/api/cron/dotloop-sync) has no cookie, so every access row the sync
 * tried to record through it was refused "Unauthorized" and swallowed by the
 * caller's `.catch`. The insert + self-heal ledgering moved HERE, unchanged;
 * logDocumentAccess keeps its session gate and calls this after it, and the
 * sessionless sync core (lib/transactions/dotloop-document-sync.ts) calls it
 * with the tenant it read off the transaction row. One writer, two doors (§6).
 *
 * Server-only on purpose, NOT "use server": every export of a "use server"
 * module is a public HTTP endpoint (CLAUDE.md §4), and this one trusts the
 * brokerageId its caller verified.
 */
import "server-only"
import { recordSelfHeal } from "@/lib/kernel/self-heal-ledger"

export interface DocumentAccessRow {
  documentId: string
  accessedByType: "agent" | "client" | "admin" | "external"
  accessedById?: string
  accessedByEmail?: string
  /** "sign" covers a share link opened at access_level 'sign' (document_sharing_links). */
  accessType: "view" | "download" | "edit" | "share" | "delete" | "upload" | "sign"
  ipAddress?: string
  userAgent?: string
}

/**
 * Insert one access row through the SERVICE client the caller holds, after the
 * caller has verified the document is in `brokerageId`. A refusal is RETURNED and
 * LEDGERED (self_heal_events) — an unchecked insert on an audit table is the
 * worst place to lose a row silently.
 */
export async function recordDocumentAccess(
  svc: any,
  brokerageId: string,
  row: DocumentAccessRow,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await svc.from("document_access_log").insert({
    document_id: row.documentId,
    accessed_by_type: row.accessedByType,
    accessed_by_id: row.accessedById,
    accessed_by_email: row.accessedByEmail,
    access_type: row.accessType,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
  })
  if (error) {
    await recordSelfHeal(svc, {
      brokerageId,
      domain: "data_flow",
      subject: `document_access_logged:document_access_log`,
      action: "best_effort_write",
      outcome: "failed",
      detail: { flow: "document_access_logged", table: "document_access_log", message: String(error.message ?? "").slice(0, 300), code: (error as { code?: string }).code ?? null },
    }).catch(() => null)
    return { success: false, error: error.message }
  }
  return { success: true }
}
