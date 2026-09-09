"use client"

// "Sync e-sign documents" — the ONE UI caller of app/actions/forms-kernel.ts::syncEsignDocsAction
// (wave 46, 2026-09-09). The autonomous half already runs without anyone pressing this
// (app/api/cron/esign-doc-sync sweeps stale transactions and listing packets on the
// deal_coordinator's cadence); this control is the coordinator's "pull it NOW" for a deal
// whose signer just told them a document landed. Same core either way — the action
// delegates to lib/transactions/sync-from-provider.ts, never a second implementation.
import { useState, useTransition } from "react"
import { syncEsignDocsAction } from "@/app/actions/forms-kernel"

export function EsignSyncButton({ transactionId, contactId }: { transactionId: string; contactId: string | null }) {
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)
  if (!contactId) return null

  return (
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setNote(null)
            const r = await syncEsignDocsAction({ transaction_id: transactionId, contact_id: contactId })
            setNote(
              r.success
                ? `Synced ${r.synced ?? 0} document${(r.synced ?? 0) === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} unchanged)` : ""}`
                : `Sync failed: ${r.error ?? "provider refused"}`,
            )
          })
        }
        className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync e-sign documents"}
      </button>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  )
}
