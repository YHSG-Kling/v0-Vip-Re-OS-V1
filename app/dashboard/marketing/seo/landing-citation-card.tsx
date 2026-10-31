/**
 * LandingCitationCard — GEO visibility for LEAD-MAGNET / FAQ landing pages.
 *
 * The citation monitor's landing rail (lib/kernel/ai-search-citation-monitor.ts,
 * runLandingPageCitationMonitor) records one observation per (form, platform,
 * day) into ai_search_landing_citation_observations — including the demand
 * QUERY it actually asked, the provider that answered, the URL the answer
 * cited, and WHO ELSE the answer named (competitors_cited, m328) — and until
 * this card nothing rendered any of it: the only reader (the geo-gap runner)
 * consumed outcome counts alone. This is deliberately NOT the reels card
 * (AiCitationVisibilityCard): the landing rail observes lead_capture_forms,
 * not reel projects, and its rows carry the query and competitor share the
 * reels card has no place for — same-sounding tables, different capability.
 *
 * Presentational server component — the SEO/GEO page loads the rows (scoped
 * per lib/geo/citation-scope) and passes them in. Hidden when empty.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { FileText } from "lucide-react"

export interface LandingCitationRow {
  id: string
  platform: string
  outcome: string // 'cited' | 'not_cited' | 'not_checked'
  query: string | null
  cited_url: string | null
  provider: string | null
  public_slug: string | null
  observed_at: string | null
  /** string[] from detectCompetitorCitations; NULL when the search never ran. */
  competitors_cited: string[] | null
}

const OUTCOME_BADGE: Record<string, string> = {
  cited: "bg-emerald-100 text-emerald-700 border-emerald-200",
  not_cited: "bg-amber-100 text-amber-700 border-amber-200",
  not_checked: "bg-slate-100 text-slate-600 border-slate-200",
}

function competitorNames(row: LandingCitationRow): string[] {
  if (!Array.isArray(row.competitors_cited)) return []
  return row.competitors_cited.filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  )
}

export function LandingCitationCard({ observations }: { observations: LandingCitationRow[] }) {
  if (observations.length === 0) return null

  const checked = observations.filter((o) => o.outcome !== "not_checked")
  const cited = checked.filter((o) => o.outcome === "cited").length
  const rate = checked.length > 0 ? Math.round((cited / checked.length) * 100) : null

  const recent = observations.slice(0, 10)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-sky-600" />
          <div>
            <CardTitle className="text-base">Lead-Magnet Landing Page Citations</CardTitle>
            <CardDescription>
              The real questions AI search was asked, and whether it cited your FAQ landing pages
              {rate !== null ? ` — cited in ${rate}% of checked answers` : ""}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {recent.map((obs) => {
            const rivals = competitorNames(obs)
            return (
              <li key={obs.id} className="py-2 space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
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
                    {obs.provider && obs.provider !== "none" && (
                      <span className="text-[10px] text-muted-foreground">via {obs.provider}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {obs.observed_at ? new Date(obs.observed_at).toLocaleDateString() : "—"}
                  </span>
                </div>
                {obs.query && (
                  <p className="text-xs text-foreground/90 truncate" title={obs.query}>
                    “{obs.query}”
                  </p>
                )}
                <p className="text-xs text-muted-foreground truncate">
                  {obs.cited_url ?? (obs.public_slug ? `/lm/${obs.public_slug}` : "")}
                  {/* NULL competitors means the search never ran; an empty list means
                      we looked and the answer named nobody else. Only name names when
                      the monitor actually looked. */}
                  {rivals.length > 0 && (
                    <span className="text-amber-700"> · also cited: {rivals.slice(0, 3).join(", ")}</span>
                  )}
                </p>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
