"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Loader2, ArrowRight, AlertTriangle } from "lucide-react"
import { matchBuyersForListing } from "@/app/actions/property-buyer-matching"

interface BuyerMatch {
  contact_id: string
  buyer_name: string
  score: number
  match_confidence: string
  match_factors?: string[]
  caution_notes?: string[]
}

const CONFIDENCE_STYLE: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-700 border-emerald-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
}

/**
 * Listing → Buyer smart match (System 5.1A). On-demand: runs only when the agent
 * clicks, so no match runs (or activity signals) fire on every listing page load.
 */
export function MatchingBuyersPanel({ listingId }: { listingId: string }) {
  const [loading, setLoading] = useState(false)
  const [matches, setMatches] = useState<BuyerMatch[] | null>(null)
  const [meta, setMeta] = useState<{ evaluated: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await matchBuyersForListing({ listingId, logSignals: true })
      if ((res as { success: boolean }).success) {
        const r = res as { matches: BuyerMatch[]; metadata?: { total_buyers_evaluated?: number } }
        setMatches(r.matches ?? [])
        setMeta({ evaluated: r.metadata?.total_buyers_evaluated ?? 0 })
      } else {
        setError((res as { error?: string }).error ?? "Could not run buyer matching.")
      }
    } catch {
      setError("Could not run buyer matching.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-600" />
              Matching Buyers
            </CardTitle>
            <CardDescription>Best-fit buyers from your database for this listing.</CardDescription>
          </div>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Users className="h-4 w-4 mr-1" />}
            {matches ? "Re-run" : "Find Buyers"}
          </Button>
        </div>
      </CardHeader>
      {(matches || error) && (
        <CardContent className="space-y-2">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {matches && matches.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-2">
              No strong buyer matches yet{meta ? ` (evaluated ${meta.evaluated})` : ""}. As you add and qualify buyers, matches appear here.
            </p>
          )}
          {matches && matches.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{matches.length} match{matches.length === 1 ? "" : "es"} of {meta?.evaluated ?? 0} buyers evaluated</p>
              {matches.map((m) => (
                <div key={m.contact_id} className="p-3 rounded-lg border flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{m.buyer_name}</span>
                      <Badge className={CONFIDENCE_STYLE[m.match_confidence] ?? CONFIDENCE_STYLE.low}>{m.score}% · {m.match_confidence}</Badge>
                    </div>
                    {m.match_factors && m.match_factors.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">{m.match_factors.slice(0, 3).join(" · ")}</p>
                    )}
                    {m.caution_notes && m.caution_notes.length > 0 && (
                      <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />{m.caution_notes[0]}
                      </p>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/crm?contact=${m.contact_id}`}>Open <ArrowRight className="h-3 w-3 ml-1" /></Link>
                  </Button>
                </div>
              ))}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
