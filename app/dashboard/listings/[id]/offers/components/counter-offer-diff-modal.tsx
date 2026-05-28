"use client"

/**
 * CounterOfferDiffModal — analytical 3-column diff (Original | Counter |
 * Recommendation) that helps the agent review only what changed in a
 * counter-offer instead of reading 47 pages.
 *
 * Complementary to the existing CounterOfferSlideOver (which CREATES a
 * counter). This one ANALYZES the diff and surfaces per-field
 * recommendations from buildCounterOfferDiff.
 *
 * Drop-in: pass an offerId + the counter payload (what the seller sent
 * back). The component fetches via loadCounterOfferDiff server action.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Loader2, GitCompare, ArrowRight, Check, AlertCircle, X } from "lucide-react"
import { loadCounterOfferDiff } from "@/app/actions/counter-offer-diff"
import type { CounterOfferDiff, CounterDiffRow } from "@/lib/workflow/intelligence/multi-offer-matrix"

interface Props {
  offerId:        string
  counterPayload: Record<string, unknown>
  /** Render style — 'button' (default) or 'icon' (compact, for crowded toolbars) */
  variant?:       "button" | "icon"
  buttonLabel?:   string
}

const RECOMMENDATION_BADGE: Record<CounterDiffRow["recommendation"], string> = {
  accept:        "bg-emerald-100 text-emerald-700",
  match:         "bg-blue-100 text-blue-700",
  counter_back:  "bg-amber-100 text-amber-700",
  decline:       "bg-red-100 text-red-700",
  review:        "bg-slate-100 text-slate-700",
}

const RECOMMENDATION_ICON: Record<CounterDiffRow["recommendation"], React.ElementType> = {
  accept:        Check,
  match:         Check,
  counter_back:  ArrowRight,
  decline:       X,
  review:        AlertCircle,
}

export default function CounterOfferDiffModal({ offerId, counterPayload, variant = "button", buttonLabel = "Diff & advise" }: Props) {
  const [open, setOpen]   = useState(false)
  const [busy, setBusy]   = useState(false)
  const [diff, setDiff]   = useState<CounterOfferDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadDiff() {
    setBusy(true)
    setError(null)
    try {
      const result = await loadCounterOfferDiff({ offerId, counterPayload })
      if (result.success) setDiff(result.diff)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  function handleOpen() {
    setOpen(true)
    setDiff(null)
    setError(null)
    void loadDiff()
  }

  return (
    <>
      {variant === "icon" ? (
        <Button size="icon" variant="ghost" title={buttonLabel} onClick={handleOpen}>
          <GitCompare className="h-4 w-4" />
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={handleOpen} className="gap-1.5">
          <GitCompare className="h-3.5 w-3.5" />
          {buttonLabel}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompare className="h-4 w-4 text-violet-600" />
              Counter-offer diff
            </DialogTitle>
            <DialogDescription>
              Per-field comparison and AI recommendation for each changed term.
            </DialogDescription>
          </DialogHeader>

          {busy && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing the counter…
            </div>
          )}

          {error && (
            <div className="rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {diff && !busy && (
            <div className="space-y-4">
              {/* AI bottom line */}
              {diff.bottomLine && (
                <div className="rounded-lg border border-violet-200 bg-violet-50/40 dark:bg-violet-950/20 p-4">
                  <p className="text-xs uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-400 mb-1.5">
                    AI take
                  </p>
                  <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                    {diff.bottomLine}
                  </p>
                </div>
              )}

              {/* Per-field diff table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b">
                    <tr>
                      <th className="text-left py-2 font-medium">Field</th>
                      <th className="text-left py-2 font-medium">Original</th>
                      <th className="text-left py-2 font-medium">Counter</th>
                      <th className="text-left py-2 font-medium">Recommend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.rows.filter(r => r.changed).map((row, i) => {
                      const Icon = RECOMMENDATION_ICON[row.recommendation] ?? AlertCircle
                      return (
                        <tr key={i} className="border-b last:border-0 align-top">
                          <td className="py-3 font-medium">{row.labelForSeller}</td>
                          <td className="py-3 text-muted-foreground line-through">
                            {formatValue(row.original)}
                          </td>
                          <td className="py-3 font-semibold">
                            {formatValue(row.counter)}
                          </td>
                          <td className="py-3">
                            <Badge className={`${RECOMMENDATION_BADGE[row.recommendation]} gap-1`}>
                              <Icon className="h-3 w-3" />
                              {row.recommendation.replace("_", " ")}
                            </Badge>
                            {row.rationale && (
                              <p className="text-xs text-muted-foreground mt-1.5 max-w-xs">
                                {row.rationale}
                              </p>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {diff.rows.filter(r => r.changed).length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                          Counter doesn't change any material terms.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ")
  if (typeof value === "number") {
    return value > 1000 ? `$${value.toLocaleString()}` : value.toString()
  }
  if (typeof value === "boolean") return value ? "yes" : "no"
  return String(value)
}
