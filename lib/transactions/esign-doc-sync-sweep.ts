// lib/transactions/esign-doc-sync-sweep.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AUTONOMOUS TWIN OF THE PORTAL-PAGE SYNC.
//
// app/portal/[contactId]/documents/page.tsx calls syncAllForContact on a page
// load — a document syncs only when a contact happens to open their portal.
// This sweep is the loop half: it finds transactions and listings whose
// provider documents have gone stale (or never synced) and calls the SAME two
// persisting cores the portal page and app/actions/forms-kernel.ts:
// syncEsignDocsAction call, so a click, a page load and this cron all run one
// path (§6) — never a third.
//
// OUTCOME IS A DISCRIMINANT, NOT A BOOLEAN (same shape as
// lib/storage/orphan-sweeper.ts): a refused candidate-read and an empty
// worklist are numerically identical (both "found nothing") and must not read
// as the same thing — pre-rollout, `external_provider_source` is NULL on every
// live row, so "swept 0" is the ordinary case and a caller has to be able to
// tell that apart from "could not look".
//
// No session anywhere in this module — the caller passes the client, and the
// cron route passes a SERVICE client. A cron has no cookies.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  syncTransactionDocumentsFromProvider,
  syncListingDocumentsFromProvider,
  type SyncFromProviderResult,
} from "@/lib/transactions/sync-from-provider"

type AnySupabase = SupabaseClient<any, any, any>

export interface EsignDocSyncSweepEntry {
  kind:   "transaction" | "listing"
  id:     string
  result: SyncFromProviderResult
}

export type EsignDocSyncSweepOutcome =
  | { outcome: "read_refused"; error: string }
  | {
      outcome: "swept"
      transactionsExamined: number
      listingsExamined:     number
      synced:               number
      failed:               number
      entries:              EsignDocSyncSweepEntry[]
    }

/**
 * Sweep transactions and listings whose provider-linked packet has not been
 * synced within `staleAfterSec` (the same default as the portal page's own
 * throttle) and pull each through its persisting core.
 *
 * CANDIDATE SELECTION is deliberately loose rather than exact: it admits any
 * open transaction/listing carrying `external_provider_source`, OR — for the
 * transaction lane only — one that does not YET carry it but has a linked
 * offer with a `provider_envelope_id` (the day-zero backfill path
 * syncTransactionDocumentsFromProvider itself resolves and writes back). The
 * persisting cores are cheap to call with nothing to do (they return
 * `skipped: "no-external-id"` or `"fresh"` without ever reaching the
 * provider), so over-admitting a row here costs a filtered-out no-op, not a
 * wasted provider call — and under-admitting one would silently starve a
 * transaction's document sync forever.
 */
export async function sweepEsignDocSync(
  supabase: AnySupabase,
  opts: { limit?: number; staleAfterSec?: number } = {},
): Promise<EsignDocSyncSweepOutcome> {
  const limit = opts.limit ?? 100
  const staleAfterSec = opts.staleAfterSec ?? 300

  const staleCutoff = new Date(Date.now() - staleAfterSec * 1000).toISOString()

  // ── Transaction lane ────────────────────────────────────────────────────
  const [byProvider, byLinkedOffer] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, brokerage_id, buyer_contact_id, seller_contact_id, contact_id")
      .not("stage", "eq", "closed")
      .not("external_provider_source", "is", null)
      .or(`last_provider_sync_at.is.null,last_provider_sync_at.lt.${staleCutoff}`)
      .limit(limit),
    supabase
      .from("transactions")
      // transactions↔offers are joined by TWO FKs (transactions.offer_id → offers AND
      // offers.transaction_id → transactions); a bare `offers(...)` embed is PGRST201 and
      // kills the whole read (CLAUDE.md §3). The accepted offer a deal was opened FROM is
      // the transactions.offer_id side.
      .select("id, brokerage_id, buyer_contact_id, seller_contact_id, contact_id, offers!transactions_offer_id_fkey!inner(provider_envelope_id)")
      .not("stage", "eq", "closed")
      .is("external_provider_source", null)
      .not("offers.provider_envelope_id", "is", null)
      .limit(limit),
  ])

  if (byProvider.error) {
    return { outcome: "read_refused", error: `transactions (provider-linked) read failed: ${byProvider.error.message}` }
  }
  if (byLinkedOffer.error) {
    return { outcome: "read_refused", error: `transactions (offer-linked) read failed: ${byLinkedOffer.error.message}` }
  }

  const txnRows = new Map<string, { id: string; brokerage_id: string; contactId: string | null }>()
  for (const r of [...(byProvider.data ?? []), ...(byLinkedOffer.data ?? [])]) {
    const row = r as Record<string, unknown>
    const contactId = (row.buyer_contact_id as string | null)
      ?? (row.seller_contact_id as string | null)
      ?? (row.contact_id as string | null)
      ?? null
    txnRows.set(row.id as string, { id: row.id as string, brokerage_id: row.brokerage_id as string, contactId })
  }

  // ── Listing lane ────────────────────────────────────────────────────────
  const { data: listingRows, error: listingErr } = await supabase
    .from("listings")
    .select("id, brokerage_id, seller_contact_id, contact_id")
    .not("status", "eq", "sold")
    .not("external_provider_source", "is", null)
    .or(`last_provider_sync_at.is.null,last_provider_sync_at.lt.${staleCutoff}`)
    .limit(limit)
  if (listingErr) {
    return { outcome: "read_refused", error: `listings read failed: ${listingErr.message}` }
  }

  const entries: EsignDocSyncSweepEntry[] = []

  for (const t of txnRows.values()) {
    // A transaction with no resolvable contact has nothing to attribute the
    // portal-visible document to — skip rather than write a nonsensical row;
    // the transaction still gets picked up once a contact is attached.
    if (!t.contactId) continue
    const result = await syncTransactionDocumentsFromProvider({
      brokerageId:   t.brokerage_id,
      transactionId: t.id,
      contactId:     t.contactId,
      staleAfterSec,
    })
    entries.push({ kind: "transaction", id: t.id, result })
  }

  for (const l of listingRows ?? []) {
    const row = l as Record<string, unknown>
    const contactId = (row.seller_contact_id as string | null) ?? (row.contact_id as string | null) ?? null
    if (!contactId) continue
    const result = await syncListingDocumentsFromProvider({
      brokerageId: row.brokerage_id as string,
      listingId:   row.id as string,
      contactId,
      staleAfterSec,
    })
    entries.push({ kind: "listing", id: row.id as string, result })
  }

  return {
    outcome: "swept",
    transactionsExamined: txnRows.size,
    listingsExamined:     (listingRows ?? []).length,
    synced: entries.filter((e) => e.result.ok && e.result.synced > 0).reduce((s, e) => s + e.result.synced, 0),
    failed: entries.filter((e) => !e.result.ok).length,
    entries,
  }
}
