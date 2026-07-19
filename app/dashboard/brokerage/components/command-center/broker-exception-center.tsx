"use client"

/**
 * BROKER EXCEPTION CENTER — everything the OS could NOT safely repair, in one
 * place with its evidence and three verbs: Retry (re-run the scan+heal pass),
 * Resolve (a human handled it), Dismiss (not an issue). Below it, the
 * supervised repairs a human may still veto — "this fix was wrong" appends a
 * failure to the ledger and demotes that repair type instantly (the ratchet's
 * feedback loop). Renders only when there's something to show.
 *
 * MULTI-LOCATION (owner: "exception center — brokerage, multiple location
 * brokerage"): on the multi_location tier an office picker narrows the list
 * using the same location-scope idiom reporting uses (agents.location_id).
 * The honest default is ALL locations; a location admin is pinned to their
 * own office by the egress-scope rule, and any rows an office filter hides
 * because they could not be attributed to an office are counted out loud.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { AlertTriangle, RefreshCw, Check, X, ShieldAlert, MapPin } from "lucide-react"
import {
  getExceptionCenter, resolveException, dismissException, retryDataFlows, flagRepairWrong,
} from "@/app/actions/exception-center"
import type { ExceptionCenterRead, ExceptionScope } from "@/lib/kernel/exception-center"

const ALL_LOCATIONS = "__all__"

export function BrokerExceptionCenter() {
  const [read, setRead] = useState<ExceptionCenterRead | null>(null)
  const [scope, setScope] = useState<ExceptionScope | null>(null)
  const [locationId, setLocationId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [retryNote, setRetryNote] = useState<string | null>(null)

  const reload = useCallback((loc: string | null) => {
    getExceptionCenter(loc ? { locationId: loc } : undefined)
      .then((x) => {
        if (x.success) {
          setRead(x.read)
          setScope(x.scope)
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => { reload(locationId) }, [reload, locationId])

  if (!read || !scope) return null
  const empty = read.open.length === 0 && read.supervised.length === 0
  const filterActive = !!scope.selectedLocationId
  // Nothing anywhere and no office narrowing in play → stay out of the way.
  if (empty && !filterActive) return null
  // A location admin (pinned office) with a genuinely clean office and nothing hidden.
  if (empty && filterActive && scope.forced && scope.hiddenUnattributed === 0) return null

  const act = async (key: string, fn: () => Promise<{ success: boolean }>) => {
    setBusy(key)
    try { await fn(); reload(locationId) } finally { setBusy(null) }
  }

  const showPicker = scope.multiLocation && scope.locations.length > 0

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
        {showPicker && (
          <div className="flex items-center gap-2 pt-1">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            {scope.forced ? (
              <span className="text-xs text-muted-foreground">
                {scope.locations.find((l) => l.id === scope.selectedLocationId)?.name ?? "Your office"} — your office (location-admin scope)
              </span>
            ) : (
              <Select
                value={locationId ?? ALL_LOCATIONS}
                onValueChange={(v) => setLocationId(v === ALL_LOCATIONS ? null : v)}
              >
                <SelectTrigger className="h-7 w-56 text-xs">
                  <SelectValue placeholder="All locations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
                  {scope.locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
        {filterActive && scope.hiddenUnattributed > 0 && (
          <p className="text-xs text-muted-foreground">
            {scope.hiddenUnattributed} exception{scope.hiddenUnattributed === 1 ? "" : "s"} couldn't be
            attributed to an office and {scope.hiddenUnattributed === 1 ? "is" : "are"} hidden by this filter —
            {scope.forced ? " ask a broker to review them under All locations." : " switch to All locations to see them."}
          </p>
        )}
        {retryNote && <p className="text-xs text-emerald-700">{retryNote}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {empty && (
          <p className="text-sm text-muted-foreground">Nothing open for this office.</p>
        )}
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
