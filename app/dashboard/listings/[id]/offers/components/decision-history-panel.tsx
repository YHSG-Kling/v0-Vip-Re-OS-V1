"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { History, RefreshCw, ChevronDown, ChevronUp, Clock } from "lucide-react"
import { getSellerDecisionHistory } from "@/app/actions/seller-decision-governance"
import { formatDistanceToNow } from "date-fns"

interface Props {
  listingId: string
}

const STATUS_STYLES: Record<string, string> = {
  approved:   "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected:   "bg-red-100 text-red-800 border-red-200",
  pending:    "bg-amber-100 text-amber-800 border-amber-200",
  overridden: "bg-purple-100 text-purple-800 border-purple-200",
  expired:    "bg-slate-100 text-slate-600 border-slate-200",
}

export function DecisionHistoryPanel({ listingId }: Props) {
  const [isPending, startTransition] = useTransition()
  const [history, setHistory] = useState<any[] | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState<string | null>(null)

  function loadHistory() {
    setError(null)
    startTransition(async () => {
      const result = await getSellerDecisionHistory(listingId, 20)
      if (result.success) {
        setHistory((result as any).decisions ?? [])
      } else {
        setError(result.error ?? "Failed to load decision history")
      }
    })
  }

  // Auto-load on first render when panel mounts
  if (history === null && !isPending) {
    loadHistory()
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-indigo-500" />
            Decision History
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={loadHistory}
              disabled={isPending}
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setExpanded((e) => !e)}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-2 pt-0">
          {isPending && (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Loading decision history...
            </div>
          )}

          {error && !isPending && (
            <p className="text-xs text-destructive py-2">{error}</p>
          )}

          {!isPending && history !== null && history.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">
              No decisions recorded yet for this listing.
            </p>
          )}

          {!isPending && history !== null && history.length > 0 && (
            <div className="space-y-2">
              {history.map((d: any, i: number) => {
                const decisionType = d.decision_type ?? d.type ?? "decision"
                const status       = d.status ?? d.outcome ?? "pending"
                const decidedBy    = d.decided_by_name ?? d.agent_name ?? null
                const createdAt    = d.created_at ?? d.decided_at ?? null
                const notes        = d.notes ?? d.reason ?? null

                return (
                  <div
                    key={d.id ?? i}
                    className="flex items-start gap-3 rounded-md border bg-muted/30 p-2.5"
                  >
                    <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-medium capitalize">
                          {decisionType.replace(/_/g, " ")}
                        </p>
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 leading-4 border ${STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border"}`}
                        >
                          {status}
                        </Badge>
                      </div>
                      {notes && (
                        <p className="text-xs text-muted-foreground truncate">{notes}</p>
                      )}
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        {decidedBy && <span>{decidedBy}</span>}
                        {createdAt && (
                          <span>
                            {formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
