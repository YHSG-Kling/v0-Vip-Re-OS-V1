"use client"

/**
 * "Sync to QuickBooks" for the SCOPED books export (wave 26).
 *
 * The team P&L and agent-commission export lanes in
 * lib/finance/scoped-accounting-export.ts were fully built and had no importer,
 * so a team or agent with their own QuickBooks company connected had no way to
 * send anything to it. This is the control.
 *
 * HONEST ABOUT ALL THREE OUTCOMES, because the lane distinguishes them:
 *   · attempted:false           → nothing was tried (not connected / no row).
 *                                 Rendered as a plain note, never as a failure.
 *   · attempted:true, success:false → the export ran and QuickBooks refused.
 *   · success:true              → shows the QuickBooks id that came back, which
 *                                 only exists when Intuit actually returned one.
 * The export is idempotent through the quickbooks_export_id marker, so pressing
 * this twice returns the existing id rather than double-posting.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw } from "lucide-react"

type Outcome =
  | { ok: true; attempted: boolean; success: boolean; externalId?: string; error?: string }
  | { ok: false; error: string }

export function QbScopedExportButton({
  label = "Sync to QuickBooks",
  run,
}: {
  label?: string
  /** Server action bound by the page — this component never names an owner. */
  run: () => Promise<Outcome>
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null)

  async function onClick() {
    setBusy(true)
    setNote(null)
    try {
      const res = await run()
      if (!res.ok) {
        setNote({ tone: "err", text: res.error })
      } else if (!res.attempted) {
        setNote({ tone: "warn", text: res.error ?? "Nothing to sync yet." })
      } else if (!res.success) {
        setNote({ tone: "err", text: res.error ?? "QuickBooks refused the export." })
      } else {
        setNote({
          tone: "ok",
          text: res.externalId ? `Synced — QuickBooks id ${res.externalId}` : "Synced.",
        })
      }
    } catch (e) {
      setNote({ tone: "err", text: e instanceof Error ? e.message : "Export failed." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Syncing…
          </>
        ) : (
          <>
            <RefreshCw className="h-4 w-4 mr-2" /> {label}
          </>
        )}
      </Button>
      {note && (
        <span
          className={
            note.tone === "ok"
              ? "text-xs text-emerald-700"
              : note.tone === "warn"
              ? "text-xs text-muted-foreground"
              : "text-xs text-red-600"
          }
        >
          {note.text}
        </span>
      )}
    </div>
  )
}
