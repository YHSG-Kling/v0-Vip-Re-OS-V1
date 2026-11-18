import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Search } from "lucide-react"
import type { getSearchDemandIntelligence } from "@/app/actions/marketing-intelligence"

/**
 * SEARCH DEMAND — the dashboard reader for Google / search demand intelligence (wave 154, lane 154B; owner ruling R5(b):
 * "google search intelligence … stay"). One row per producer with its HONEST status (not connected / owner-held / ran),
 * and the topic ideas it would send to the topic pool. Evidence is shown with its kind: a measured count, a relative
 * index (never "searches"), or unknown. No person appears here — the producers emit category labels and counts only.
 */
type Data = Awaited<ReturnType<typeof getSearchDemandIntelligence>>

const PRODUCER_LABEL: Record<string, string> = {
  trends: "Google Trends (regional interest)",
  search_console: "Search Console (your own site)",
  first_party: "Your portal & site searches (consented)",
  keyword_intel: "Keyword intelligence",
}
const STATUS_LABEL: Record<string, string> = {
  ran: "Live", nothing_found: "Nothing new", not_connected: "Not connected", owner_held: "Needs your connection", refused: "Unavailable",
}

function evidenceText(e: { kind: string; value: number | null; unit: string | null }): string {
  if (e.value == null) return "volume unknown"
  if (e.unit === "relative_index_0_100") return `interest ${e.value}/100 (relative)`
  if (e.unit === "impressions") return `${e.value.toLocaleString()} impressions`
  if (e.unit === "distinct_contacts") return `${e.value} buyers asked`
  if (e.unit === "searches_per_month") return `${e.value.toLocaleString()} est. monthly searches`
  return e.kind === "unknown" ? "unknown" : String(e.value)
}

export function SearchDemandCard({ data }: { data: Data }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4" />
          Search Demand
        </CardTitle>
        <CardDescription>What people in your market search for — turned into content topics, never into people.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.ok ? (
          <p className="text-sm text-muted-foreground">Search demand could not be read: {data.error}</p>
        ) : (
          data.producers.map((p) => (
            <div key={p.producer} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{PRODUCER_LABEL[p.producer] ?? p.producer}</span>
                <Badge variant={p.status === "ran" ? "default" : "secondary"} className="text-[10px]">{STATUS_LABEL[p.status] ?? p.status}</Badge>
              </div>
              {p.reason && <p className="text-xs text-muted-foreground">{p.reason}</p>}
              {p.ideas.length > 0 && (
                <ul className="space-y-1">
                  {p.ideas.map((i) => (
                    <li key={i.title} className="text-sm flex flex-wrap items-center gap-2">
                      <span>{i.title}</span>
                      <span className="text-xs text-muted-foreground" title={i.evidence.note ?? undefined}>{evidenceText(i.evidence)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {p.caveats.length > 0 && <p className="text-[11px] text-muted-foreground">{p.caveats.join(" · ")}</p>}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
