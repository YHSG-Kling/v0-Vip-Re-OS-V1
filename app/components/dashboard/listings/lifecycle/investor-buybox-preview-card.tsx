"use client"

/**
 * app/components/dashboard/listings/lifecycle/investor-buybox-preview-card.tsx
 *
 * On-demand "N investor buyers matched" badge for the listing-concierge (wave 69 orphan-export
 * wire-up for lib/external/batchdata-mcp.ts::investorBuyboxPreview). Cheap, no-charge preview —
 * never the billed page pull that lib/kernel/listings-batchdata-feed.ts::runBuyBoxMatchingForMarket
 * already runs autonomously per market. On-demand like MatchingBuyersPanel beside it: no fetch on
 * mount, so a listing page load never spends a call a visiting agent doesn't ask for.
 *
 * AGENT/BROKERAGE-SIDE ONLY — never rendered on a buyer/investor-facing surface (wave 68 owner
 * ruling: investors never see other investors circling a property, symmetric to sellers never
 * being exposed to an investor's own criteria).
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, TrendingUp, AlertTriangle } from "lucide-react"
import { getInvestorBuyboxPreviewForListing } from "@/app/actions/investor-buybox-preview"

export function InvestorBuyboxPreviewCard({ listingId }: { listingId: string }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ matchedCount?: number; unconfigured?: boolean; error?: string } | null>(null)

  const run = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await getInvestorBuyboxPreviewForListing({ listingId })
      setResult(res)
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Unknown error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-indigo-500" />
          Investor Buyer Interest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          BatchData Buy Box preview — investors whose buying profile matches this property.
          Free sample; no cost until a full match run.
        </p>
        <Button size="sm" variant="outline" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          {loading ? "Checking…" : "Check investor buyers"}
        </Button>
        {result?.error && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {result.unconfigured ? "BatchData is not configured for this environment." : result.error}
          </div>
        )}
        {result?.matchedCount !== undefined && !result.error && (
          <Badge variant="secondary" className="text-xs">
            {result.matchedCount} investor buyer{result.matchedCount === 1 ? "" : "s"} matched (preview)
          </Badge>
        )}
      </CardContent>
    </Card>
  )
}
