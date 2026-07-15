"use client"

/**
 * BROKER EXCEPTION CENTER — everything the OS could NOT safely repair, in one
 * place with its evidence and three verbs: Retry (re-run the scan+heal pass),
 * Resolve (a human handled it), Dismiss (not an issue). Below it, the
 * supervised repairs a human may still veto — "this fix was wrong" appends a
 * failure to the ledger and demotes that repair type instantly (the ratchet's
 * feedback loop). Renders only when there's something to show.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, RefreshCw, Check, X, ShieldAlert } from "lucide-react"
import {
  getExceptionCenter, resolveException, dismissException, retryDataFlows, flagRepairWrong,
} from "@/app/actions/exception-center"
import type { ExceptionCenterRead } from "@/lib/kernel/exception-center"

export function BrokerExceptionCenter() {
  const [read, setRead] = useState<ExceptionCenterRead | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [retryNote, setRetryNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    getExceptionCenter().then((x) => { if (x.success) setRead(x.read) }).catch(() => {})
  }, [])
  useEffect(() => { reload() }, [reload])

  if (!read || (read.open.length === 0 && read.supervised.length === 0)) return null

  const act = async (key: string, fn: () => Promise<{ success: boolean }>) => {
    setBusy(key)
    try { await fn(); reload() } finally { setBusy(null) }
  }

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base font-semibold">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            Exception Center
          </span>
          <Button
            size="sm" variant="outline" disabled={busy !== null}
            onClick={() => act("retry", async () => {
              const r = await retryDataFlows()
              if (r.success) setRetryNote(`Re-scanned: ${r.healed} repaired, ${r.breaks} break${r.breaks === 1 ? "" : "s"} found`)
              return { success: r.success }
            })}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Retry all
          </Button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What the OS couldn't repair safely — with why, and what it already tried
        </p>
        {retryNote && <p className="text-xs text-emerald-700">{retryNote}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {read.open.map((ex) => (
          <div key={ex.eventId} className="rounded-md border border-amber-100 p-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{ex.describes}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{ex.reason}</p>
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null}
                onClick={() => act(ex.eventId, () => resolveException(ex.eventId))}>
                <Check className="mr-1 h-3 w-3" /> Resolved
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null}
                onClick={() => act(ex.eventId, () => dismissException(ex.eventId))}>
                <X className="mr-1 h-3 w-3" /> Not an issue
              </Button>
            </div>
          </div>
        ))}
        {read.supervised.length > 0 && (
          <div className="pt-1">
            <p className="text-xs font-medium text-muted-foreground">Recent supervised repairs — veto if a fix was wrong</p>
            <ul className="mt-1.5 space-y-1.5">
              {read.supervised.map((rep) => (
                <li key={rep.eventId} className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">Auto-fixed: {rep.describes}</span>
                  <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs text-red-700" disabled={busy !== null}
                    onClick={() => act(rep.eventId, () => flagRepairWrong(rep.eventId))}>
                    This fix was wrong
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              A veto records a failure on the ledger — that repair type loses its autonomy immediately and reports every fix again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
