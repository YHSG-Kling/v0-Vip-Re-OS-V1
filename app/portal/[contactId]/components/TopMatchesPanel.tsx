/**
 * TopMatchesPanel — renders the buyer's cached AI property matches on the
 * portal Properties page.
 *
 * Data source: getBuyerPortalMatches() (app/actions/buyer-portal-matches.ts),
 * which reads the property_matches upserts written by generatePropertyMatches()
 * and joins them — via the unified resolvePropertyFacts resolver — against BOTH
 * our own brokerage listings AND cached external/MLS snapshots. Each row carries
 * a match score, the AI's match reasons, address/price/beds/baths, and (for our
 * listings) days-on-market.
 *
 * This panel is the rendered surface that makes that action live: before it, the
 * action was imported by nothing. Presentational only — it takes already-resolved
 * matches as a prop. Hides itself when there are no matches.
 */

import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Home, Sparkles, Clock } from "lucide-react"
import type { BuyerPortalMatch } from "@/app/actions/buyer-portal-matches"

interface TopMatchesPanelProps {
  contactId: string
  matches: BuyerPortalMatch[]
}

export function TopMatchesPanel({ contactId, matches }: TopMatchesPanelProps) {
  if (!matches || matches.length === 0) return null

  return (
    <section className="mb-2">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold">Your Top Matches</h2>
        <Badge className="bg-primary/10 text-primary text-xs border-0">AI Matched</Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {matches.map((m) => {
          const scorePct = Math.round((m.match_score ?? 0) <= 1 ? (m.match_score ?? 0) * 100 : (m.match_score ?? 0))
          return (
            <div
              key={m.id}
              className="rounded-xl border border-border overflow-hidden hover:shadow-md transition-shadow bg-card"
            >
              <div className="aspect-[4/3] bg-muted relative">
                {m.primary_photo_url ? (
                  <img
                    src={m.primary_photo_url}
                    alt={m.address ?? "Property"}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Home className="h-10 w-10 text-muted-foreground" />
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <Badge className="bg-primary text-primary-foreground text-xs">
                    {scorePct}% match
                  </Badge>
                </div>
                {m.status && (
                  <div className="absolute top-2 right-2">
                    <Badge variant="secondary" className="text-xs capitalize">
                      {m.status}
                    </Badge>
                  </div>
                )}
              </div>
              <div className="p-4">
                <p className="font-semibold truncate">{m.address ?? "Property"}</p>
                {(m.city || m.state) && (
                  <p className="text-xs text-muted-foreground truncate">
                    {[m.city, m.state].filter(Boolean).join(", ")}
                  </p>
                )}
                {m.list_price != null && (
                  <p className="text-xl font-bold text-primary mt-1">
                    ${m.list_price.toLocaleString()}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {m.bedrooms != null ? `${m.bedrooms}bd` : "—"} &middot;{" "}
                  {m.bathrooms != null ? `${m.bathrooms}ba` : "—"}
                  {m.sqft != null ? ` · ${m.sqft.toLocaleString()} sqft` : ""}
                </p>
                {m.days_on_market != null && (
                  <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {m.days_on_market} {m.days_on_market === 1 ? "day" : "days"} on market
                  </p>
                )}
                {m.match_reasons.length > 0 && (
                  <p className="text-xs text-primary mt-2 font-medium border-l-2 border-primary/40 pl-2">
                    {m.match_reasons[0]}
                  </p>
                )}
                <div className="flex gap-2 mt-3">
                  <Button size="sm" className="flex-1 text-xs" asChild>
                    <Link href={`/portal/${contactId}/properties/${m.property_id}`}>View</Link>
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
