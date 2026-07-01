"use client"

// INVESTOR DEALS PANEL — the buyer-side off-market finder for a qualified INVESTOR contact. Regular
// buyers get MLS matches (the retail matchers); investors get OFF-MARKET: this matches the investor's
// buy-box against our scraped motivated-seller inventory and ranks the deals by geography + distress +
// equity. On-demand (runs when the agent clicks); the ranked list persists across loads. Nothing
// auto-sends — the agent reviews before acting. Renders only for contact_type='investor'.

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Building2, Loader2, TrendingUp } from "lucide-react"
import { findInvestorDealsAction, getInvestorDealMatchAction } from "@/app/actions/investor-deals"

interface OffMarketMatch {
  leadId: string
  address: string | null
  city: string | null
  zip: string | null
  motivationType: string | null
  equityEstimate: number | null
  matchScore: number
  reasons: string[]
}
interface Match {
  candidate_count: number
  candidates: OffMarketMatch[]
  last_matched_at: string | null
}

function scoreStyle(s: number): string {
  if (s >= 0.75) return "bg-emerald-100 text-emerald-700 border-emerald-200"
  if (s >= 0.55) return "bg-amber-100 text-amber-700 border-amber-200"
  return "bg-gray-100 text-gray-600 border-gray-200"
}

export function InvestorDealsPanel({ contactId }: { contactId: string }) {
  const [loading, setLoading] = useState(false)
  const [match, setMatch] = useState<Match | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getInvestorDealMatchAction({ contactId }).then((r) => {
      if (alive && r.success && r.match) setMatch(r.match as Match)
    }).catch(() => {})
    return () => { alive = false }
  }, [contactId])

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await findInvestorDealsAction({ contactId })
      if (res.success) {
        const r = await getInvestorDealMatchAction({ contactId })
        if (r.success && r.match) setMatch(r.match as Match)
        if ((res.matchCount ?? 0) === 0) setError("No off-market properties in this investor's markets yet — matches appear as we scrape more.")
      } else {
        setError(res.error ?? "Could not find off-market deals.")
      }
    } catch {
      setError("Could not find off-market deals.")
    } finally {
      setLoading(false)
    }
  }

  const deals = (match?.candidates ?? []).slice(0, 10)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-indigo-600" />
              Off-Market Deals
            </CardTitle>
            <CardDescription>Scraped off-market properties that fit this investor's buy-box.</CardDescription>
          </div>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Building2 className="h-4 w-4 mr-1" />}
            {match ? "Re-run" : "Find Off-Market Deals"}
          </Button>
        </div>
      </CardHeader>
      {(match || error) && (
        <CardContent className="space-y-2">
          {error && <p className="text-sm text-amber-700">{error}</p>}
          {deals.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{match!.candidate_count} off-market propert{match!.candidate_count === 1 ? "y" : "ies"} in this investor's markets — ranked by fit.</p>
              {deals.map((d) => (
                <div key={d.leadId} className="p-3 rounded-lg border">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{d.address ?? "Off-market property"}{d.city ? `, ${d.city}` : ""}{d.zip ? ` ${d.zip}` : ""}</span>
                    <Badge className={scoreStyle(d.matchScore)}>{Math.round(d.matchScore * 100)}% fit</Badge>
                    {d.motivationType && <Badge variant="outline" className="text-[10px] capitalize">{d.motivationType.replace(/_/g, " ")}</Badge>}
                  </div>
                  {d.reasons.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" />{d.reasons.slice(0, 2).join(" · ")}
                    </p>
                  )}
                </div>
              ))}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
