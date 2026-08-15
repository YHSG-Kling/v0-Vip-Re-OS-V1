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
 *   ignoreDuplicates=false (the default), which produces ON CONFLICT DO UPDATE — so
 *   a re-sync REFRESHES each row's state (status flip from pending→signed, updated
 *   storage_url after provider re-renders the PDF, signer list changes, etc.) rather
 *   than no-opping. The unique index just guarantees we never end up with two rows
 *   for the same external document.
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

  // 3. Resolve the provider source + external id. Resolution order:
  //      (a) the generic m106 columns on transactions (new path)
  //      (b) the legacy `dotloop_loop_id` (Dotloop transactions created before m106)
  //      (c) the linked offer's esign_provider + provider_envelope_id (transactions
  //          created from offers BEFORE this commit added inheritance — covers the
  //          install-day-zero case for SkySlope / Brokermint / FormSimplicity)
  // Once any path resolves both fields, we backfill the generic columns on the
  // transactions row so the next sync skips the lookup entirely.
  let providerSource = (txn.external_provider_source as string | null)
    ?? (txn.dotloop_loop_id ? "dotloop" : null)
  let externalId = (txn.external_provider_transaction_id as string | null)
    ?? (txn.dotloop_loop_id as string | null)

  if (!providerSource || !externalId) {
    const { data: linkedOffer } = await svc
      .from("offers")
      .select("esign_provider, provider_envelope_id")
      .eq("transaction_id", input.transactionId)
      .not("provider_envelope_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (linkedOffer?.esign_provider && linkedOffer?.provider_envelope_id) {
      providerSource = linkedOffer.esign_provider as string
      externalId    = linkedOffer.provider_envelope_id as string
      // Backfill so subsequent sync calls hit the fast path.
      await svc.from("transactions")
        .update({
          external_provider_source:         providerSource,
          external_provider_transaction_id: externalId,
        })
        .eq("id", input.transactionId)
    }
  }

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

  // 5. Batch-upsert all ProviderDocuments into transaction_documents in ONE round-trip.
  //    The unique partial index `uq_transaction_documents_provider_external_id` (m106)
  //    makes this idempotent on (transaction_id, provider_source, external_document_id).
  //    Skips rows the provider returned without an externalDocumentId — we can't dedupe
  //    those (the interface marks it required; the guard is defensive against provider
  //    contract violations).
  const now    = new Date().toISOString()
  const rows   = docs
    .filter(d => !!d.externalDocumentId)
    .map(d => ({
      transaction_id:       input.transactionId,
      contact_id:           input.contactId,
      provider_source:      providerSource,
      external_document_id: d.externalDocumentId,
      doc_type:             d.folderName?.toLowerCase().replace(/\s+/g, "_") ?? "unknown",
      doc_label:            d.documentName,
      status:               d.isSigned ? "signed" : "pending",
      storage_url:          d.url ?? null,
      uploaded_at:          d.uploadedAt ?? d.lastModified ?? now,
      signature_status: {
        is_signed:  d.isSigned,
        signers:    d.signers ?? [],
        synced_at:  now,
      },
    }))
  let synced = 0
  if (rows.length > 0) {
    const { error: upErr, count } = await svc
      .from("transaction_documents")
      .upsert(rows, {
        onConflict:       "transaction_id,provider_source,external_document_id",
        ignoreDuplicates: false,
        count:            "exact",
      })
    if (upErr) {
      return { ok: false, synced: 0, skipped: null, error: `upsert failed: ${upErr.message}` }
    }
    synced = count ?? rows.length
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
  // Parallelize — each per-transaction sync is independent (separate transaction_id),
  // and the per-call staleness gate + provider rate limits are the natural backpressure.
  // Sequential awaits added O(N) latency to portal page renders for contacts with
  // multiple transactions.
  return Promise.all(ids.map(async id => ({
    transactionId: id,
    result: await syncTransactionDocumentsFromProvider({
      brokerageId:   params.brokerageId,
      transactionId: id,
      contactId:     params.contactId,
      staleAfterSec: params.staleAfterSec,
    }),
  })))
}
