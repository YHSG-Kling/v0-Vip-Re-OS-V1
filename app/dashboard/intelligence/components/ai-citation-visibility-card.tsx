/**
 * AiCitationVisibilityCard — GEO / AI-search visibility section for the
 * Intelligence Center. Surfaces ai_search_citation_observations rows written
 * daily by the citation monitor (lib/kernel/ai-search-citation-monitor.ts),
 * which checks whether AI search platforms cite the brokerage's published
 * reel pages.
 *
 * Presentational server component — the intelligence page loads the rows and
 * passes them in. Hidden when there are no observations.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Search } from "lucide-react"

export interface CitationObservationRow {
  id: string
  platform: string
  outcome: string // 'cited' | 'not_cited' | 'not_checked'
  cited_url: string | null
  provider: string | null
  public_slug: string | null
  observed_at: string | null
  /**
   * THE PROMPT THAT WAS ASKED of the AI platform (written by the monitor at
   * lib/kernel/ai-search-citation-monitor.ts, upsert `query`). Without it an
   * outcome is a verdict with no question — "not cited" for WHAT? Nullable
   * only for rows older than the column.
   */
  query: string | null
}

const OUTCOME_BADGE: Record<string, string> = {
  cited: "bg-emerald-100 text-emerald-700 border-emerald-200",
  not_cited: "bg-amber-100 text-amber-700 border-amber-200",
  not_checked: "bg-slate-100 text-slate-600 border-slate-200",
}

export function AiCitationVisibilityCard({ observations }: { observations: CitationObservationRow[] }) {
  if (observations.length === 0) return null

  // Aggregate outcomes by platform
  const byPlatform = new Map<string, { cited: number; notCited: number; notChecked: number }>()
  for (const obs of observations) {
    const bucket = byPlatform.get(obs.platform) ?? { cited: 0, notCited: 0, notChecked: 0 }
    if (obs.outcome === "cited") bucket.cited += 1
    else if (obs.outcome === "not_cited") bucket.notCited += 1
    else bucket.notChecked += 1
    byPlatform.set(obs.platform, bucket)
  }

  const recent = observations.slice(0, 8)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-sky-600" />
          <div>
            <CardTitle className="text-base">AI Search Citations</CardTitle>
            <CardDescription>
              Whether AI search platforms cite your published pages (last 30 days)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Per-platform trend */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...byPlatform.entries()].map(([platform, counts]) => {
            const checked = counts.cited + counts.notCited
            const rate = checked > 0 ? Math.round((counts.cited / checked) * 100) : null
            return (
              <div key={platform} className="p-3 rounded-lg border">
                <p className="text-xs text-muted-foreground capitalize">{platform.replace(/_/g, " ")}</p>
                <p className="text-xl font-bold text-sky-700">{rate !== null ? `${rate}%` : "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {counts.cited} cited · {counts.notCited} not cited
                  {counts.notChecked > 0 ? ` · ${counts.notChecked} unchecked` : ""}
                </p>
              </div>
            )
          })}
        </div>

        {/* Latest outcomes */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Latest observations</p>
          <ul className="divide-y">
            {recent.map((obs) => (
              <li key={obs.id} className="py-2 flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {obs.platform.replace(/_/g, " ")}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[10px] capitalize ${OUTCOME_BADGE[obs.outcome] ?? ""}`}
                    >
                      {obs.outcome.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate">
                      {obs.cited_url ?? (obs.public_slug ? `/v/${obs.public_slug}` : "")}
                    </span>
                  </div>
                  {/* Same spelling as the landing rail's card
                      (app/dashboard/marketing/seo/landing-citation-card.tsx) —
                      one vocabulary for "the question that was asked". */}
                  {obs.query && (
                    <p className="text-xs text-foreground/90 truncate" title={obs.query}>
                      “{obs.query}”
                    </p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {obs.observed_at ? new Date(obs.observed_at).toLocaleDateString() : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
