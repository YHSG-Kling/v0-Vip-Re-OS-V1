"use client"

// CASH BUYERS PANEL — the disposition sibling of MatchingBuyersPanel. Where "Matching Buyers" surfaces
// the brokerage's OWN retail buyers, this surfaces nearby CASH INVESTORS (landlords, flippers, builders)
// sourced from BatchData's investor-buybox for a distressed / hard-to-finance listing — who they are,
// what they've bought in the box, why they fit. On-demand (runs only when the agent clicks). Nothing
// auto-sends: the ranked list is intelligence the agent reviews before reaching out. Provider-gated —
// shows an honest "not connected" when BatchData isn't configured, never a fabricated list.

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Banknote, Loader2, TrendingUp } from "lucide-react"
import { findCashBuyersAction, getCashBuyerMatchAction } from "@/app/actions/cash-buyer-match"

interface RankedInvestor {
  name: string | null
  investorType: string | null
  classification: string | null
  holdingsCount: number | null
  acquisitionsCount: number | null
  matchScore: number
  reasons: string[]
}
interface Match {
  candidate_count: number
  candidates: RankedInvestor[]
  last_matched_at: string | null
}

function scoreStyle(s: number): string {
  if (s >= 0.7) return "bg-emerald-100 text-emerald-700 border-emerald-200"
  if (s >= 0.5) return "bg-amber-100 text-amber-700 border-amber-200"
  return "bg-gray-100 text-gray-600 border-gray-200"
}

export function CashBuyersPanel({ listingId }: { listingId: string }) {
  const [loading, setLoading] = useState(false)
  const [match, setMatch] = useState<Match | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load any previously-run match so the ranked list persists across page loads.
  useEffect(() => {
    let alive = true
    getCashBuyerMatchAction({ listingId }).then((r) => {
      if (alive && r.success && r.match) setMatch(r.match as Match)
    }).catch(() => {})
    return () => { alive = false }
  }, [listingId])

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await findCashBuyersAction({ listingId })
      if (res.success) {
        const r = await getCashBuyerMatchAction({ listingId })
        if (r.success && r.match) setMatch(r.match as Match)
      } else {
        setError(res.error ?? "Could not find cash buyers.")
      }
    } catch {
      setError("Could not find cash buyers.")
    } finally {
      setLoading(false)
    }
  }

  const candidates = (match?.candidates ?? []).slice(0, 10)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Banknote className="h-4 w-4 text-emerald-600" />
              Cash Buyers
            </CardTitle>
            <CardDescription>Nearby cash investors who buy this kind of property — for a fast, as-is sale.</CardDescription>
          </div>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Banknote className="h-4 w-4 mr-1" />}
            {match ? "Re-run" : "Find Cash Buyers"}
          </Button>
        </div>
      </CardHeader>
      {(match || error) && (
        <CardContent className="space-y-2">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {match && candidates.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-2">
              No matching cash investors found for this property yet. Try again as the market data refreshes.
            </p>
          )}
          {candidates.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{match!.candidate_count} cash investor{match!.candidate_count === 1 ? "" : "s"} ranked by fit — review before reaching out.</p>
              {candidates.map((c, i) => (
                <div key={`${c.name ?? "investor"}-${i}`} className="p-3 rounded-lg border flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{c.name ?? "Investor"}</span>
                      <Badge className={scoreStyle(c.matchScore)}>{Math.round(c.matchScore * 100)}% fit</Badge>
                      {c.classification && <Badge variant="outline" className="text-[10px]">{c.classification}</Badge>}
                    </div>
                    {c.reasons.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" />{c.reasons.slice(0, 2).join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
