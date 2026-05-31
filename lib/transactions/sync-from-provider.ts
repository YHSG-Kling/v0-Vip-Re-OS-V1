/**
 * lib/transactions/sync-from-provider.ts
 *
 * Canonical "pull documents from the brokerage's configured transaction provider into
 * our transaction_documents table" helper. Provider-agnostic — works for Dotloop,
 * SkySlope, Brokermint, FormSimplicity uniformly via the ITransactionProvider interface.
 *
 * WHY:
 *   The buyer/seller portal documents pages (app/portal/[contactId]/documents/page.tsx)
 *   read directly from transaction_documents. The legacy Dotloop integration was the
 *   ONLY path that populated that table — brokerages on any other provider saw zero
 *   documents on the portal despite their provider holding the real data. This helper
 *   plus migration m106 closes that gap by giving us a single way to pull from any
 *   configured provider and upsert idempotently.
 *
 * Idempotency:
 *   The (transaction_id, provider_source, external_document_id) unique partial index
 *   added by m106 enforces at most one row per provider-document. We use upsert with
 *   onConflict=ignoreDuplicates so a re-sync no-ops on rows already present.
 *
 * Throttle:
 *   Callers (portal pages especially) can pass `staleAfterSec` to skip the round-trip
 *   if `transactions.last_provider_sync_at` is fresh enough. Default is 5 minutes —
 *   tight enough that the portal stays current, loose enough that a page reload doesn't
 *   hammer the provider's API.
 *
 * Never throws — failures return {ok: false, error} so the caller (typically a server
 * component rendering the portal page) can degrade to showing what's already in the DB.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { getTransactionProvider } from "@/lib/integrations/providers/provider-resolver"
import type { ProviderDocument } from "@/lib/integrations/providers/transaction-provider.interface"

export interface SyncFromProviderInput {
  brokerageId:    string
  transactionId:  string
  contactId:      string
  /** Skip the sync when transactions.last_provider_sync_at is within this many seconds.
   *  Set to 0 to force a sync. Default 300 (5 min). */
  staleAfterSec?: number
}

export interface SyncFromProviderResult {
  ok:           boolean
  synced:       number
  skipped:      "fresh" | "no-provider" | "no-external-id" | null
  error:        string | null
}

const DEFAULT_STALE_SEC = 300

export async function syncTransactionDocumentsFromProvider(
  input: SyncFromProviderInput,
): Promise<SyncFromProviderResult> {
  const svc = createServiceClient()

  // 1. Pull the transaction row — we need external_provider_source +
  //    external_provider_transaction_id (m106) and the staleness clock.
  const { data: txn, error: txnErr } = await svc
    .from("transactions")
    .select("id, brokerage_id, external_provider_source, external_provider_transaction_id, last_provider_sync_at, dotloop_loop_id")
    .eq("id", input.transactionId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (txnErr) return { ok: false, synced: 0, skipped: null, error: `transaction load failed: ${txnErr.message}` }
  if (!txn)   return { ok: false, synced: 0, skipped: null, error: "transaction not found in this brokerage" }

  // 2. Staleness gate. Skip the provider round-trip when the last sync is fresh.
  const staleAfter = input.staleAfterSec ?? DEFAULT_STALE_SEC
  if (staleAfter > 0 && txn.last_provider_sync_at) {
    const ageMs = Date.now() - new Date(txn.last_provider_sync_at as string).getTime()
    if (ageMs < staleAfter * 1000) {
      return { ok: true, synced: 0, skipped: "fresh", error: null }
    }
  }

  // 3. Resolve the provider source + external id. Prefers the new generic columns;
  //    falls back to the legacy `dotloop_loop_id` when only that's populated (which is
  //    the case for transactions created before m106 ran).
  const providerSource = (txn.external_provider_source as string | null)
    ?? (txn.dotloop_loop_id ? "dotloop" : null)
  const externalId = (txn.external_provider_transaction_id as string | null)
    ?? (txn.dotloop_loop_id as string | null)

  if (!providerSource || !externalId) {
    return { ok: true, synced: 0, skipped: "no-external-id", error: null }
  }

  // 4. Resolve the provider class and pull. Catch all failures — the configured provider
  //    might be misconfigured (revoked token, deleted account), and we don't want a portal
  //    page to crash on that path. Bumping last_provider_sync_at on failure would mask the
  //    error too long; only update it on success.
  let docs: ProviderDocument[] = []
  try {
    const provider = await getTransactionProvider(input.brokerageId)
    const res = await provider.syncDocuments({
      externalTransactionId: externalId,
      transactionId:         input.transactionId,
      contactId:             input.contactId,
    })
    if (!res.success) {
      return { ok: false, synced: 0, skipped: null, error: res.error ?? "provider sync returned !success" }
    }
    docs = res.documents ?? []
  } catch (e) {
    return { ok: false, synced: 0, skipped: null, error: `provider sync threw: ${(e as Error).message}` }
  }

  // 5. Upsert each ProviderDocument into transaction_documents. The unique partial index
  //    `uq_transaction_documents_provider_external_id` (m106) makes this idempotent on
  //    (transaction_id, provider_source, external_document_id).
  let synced = 0
  for (const d of docs) {
    if (!d.externalDocumentId) continue  // can't dedupe without the provider id; skip
    const { error: upErr } = await svc
      .from("transaction_documents")
      .upsert(
        {
          transaction_id:       input.transactionId,
          contact_id:           input.contactId,
          provider_source:      providerSource,
          external_document_id: d.externalDocumentId,
          doc_type:             d.folderName?.toLowerCase().replace(/\s+/g, "_") ?? "unknown",
          doc_label:            d.documentName,
          status:               d.isSigned ? "signed" : "pending",
          storage_url:          d.url ?? null,
          uploaded_at:          d.uploadedAt ?? d.lastModified ?? new Date().toISOString(),
          signature_status: {
            is_signed:  d.isSigned,
            signers:    d.signers ?? [],
            synced_at:  new Date().toISOString(),
          },
        },
        { onConflict: "transaction_id,provider_source,external_document_id", ignoreDuplicates: false },
      )
    if (!upErr) synced++
  }

  // 6. Stamp last_provider_sync_at so the staleness gate above can skip the next call.
  await svc
    .from("transactions")
    .update({ last_provider_sync_at: new Date().toISOString() })
    .eq("id", input.transactionId)

  return { ok: true, synced, skipped: null, error: null }
}

/**
 * Convenience for portal pages — sweeps every transaction the contact is on either
 * side of and syncs each. Returns one entry per transaction so the caller can log /
 * surface failures per-transaction without aborting the page render.
 */
export async function syncAllForContact(params: {
  brokerageId:   string
  contactId:     string
  staleAfterSec?: number
}): Promise<{ transactionId: string; result: SyncFromProviderResult }[]> {
  const svc = createServiceClient()
  const { data: rows } = await svc
    .from("transactions")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .or(`buyer_contact_id.eq.${params.contactId},seller_contact_id.eq.${params.contactId}`)
  const ids = (rows ?? []).map(r => r.id as string)
  const out: { transactionId: string; result: SyncFromProviderResult }[] = []
  for (const id of ids) {
    out.push({
      transactionId: id,
      result: await syncTransactionDocumentsFromProvider({
        brokerageId:   params.brokerageId,
        transactionId: id,
        contactId:     params.contactId,
        staleAfterSec: params.staleAfterSec,
      }),
    })
  }
  return out
}
