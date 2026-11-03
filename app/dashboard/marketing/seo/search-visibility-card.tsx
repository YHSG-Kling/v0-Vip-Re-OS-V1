import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Radar } from "lucide-react"
import type { SearchVisibility, VisibilityStatus } from "@/lib/geo/search-visibility"
import { visibilityHeadline } from "@/lib/geo/search-visibility"

/**
 * C31 SEARCH VISIBILITY (wave 149, lane 149E — owner ruling 13: "the agent can see on their dashboard where they rank on
 * AI search, Google, etc.").
 *
 * Every row says which source it is, whether the OS can measure it, the number it read, how many answers or mentions that
 * number rests on, and the table it came from. A source the OS cannot measure (Google positions, until a Search Console
 * property is connected) is shown as NOT MEASURED with what would make it measurable — never as a zero and never as an
 * estimated rank. Recommendations come from the same ranking the weekly marketing planner reads.
 */
const STATUS_LABEL: Record<VisibilityStatus, string> = {
  measured: "Measured",
  no_observations: "No readings yet",
  not_measured: "Not measured",
  refused: "Not read",
}

export function SearchVisibilityCard({ visibility }: { visibility: SearchVisibility }) {
  const v = visibility
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Radar className="h-4 w-4" />
          Search visibility
        </CardTitle>
        <CardDescription>{visibilityHeadline(v)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="space-y-2">
          {v.sources.map((s) => (
            <div key={s.key} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{s.label}</span>
                <Badge variant={s.status === "measured" ? "default" : "secondary"}>{STATUS_LABEL[s.status]}</Badge>
              </div>
              <p className="mt-1 text-muted-foreground">{s.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Source: {s.evidence.source ?? "none connected"} · sample {s.evidence.sampleSize} · {s.evidence.method}
              </p>
              {s.waitingExternal && <p className="mt-1 text-xs text-muted-foreground">To measure it: {s.waitingExternal}</p>}
            </div>
          ))}
        </div>

        {v.markets && (
          <div>
            <p className="font-medium">Your markets (from Settings → Territories)</p>
            {v.markets.markets.length === 0 ? (
              <p className="text-muted-foreground">
                No settings territory yet.
                {v.markets.fallbackHint?.city ? ` Using ${v.markets.fallbackHint.city}, ${v.markets.fallbackHint.state} from your ${v.markets.fallbackHint.basis.replace(/_/g, " ")} until you add one.` : ""}
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {v.markets.markets.slice(0, 8).map((m) => (
                  <li key={m.market} className="text-muted-foreground">
                    {m.city}, {m.state}{m.zips.length ? ` · ${m.zips.length} zip(s)` : ""} · public-record data:{" "}
                    {m.registry.status === "covered"
                      ? `${m.registry.queryableDatasets.length} dataset(s) (${m.registry.queryableDatasets.map((d) => d.c19).join(", ")})`
                      : m.registry.status.replace(/_/g, " ")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {v.trends.length > 0 && (
          <div>
            <p className="font-medium">Trends</p>
            <ul className="mt-1 space-y-1">
              {v.trends.map((t) => (
                <li key={t.metric} className="text-muted-foreground">
                  {t.metric === "ai_citation_rate" ? "AI citation rate" : "Public mentions"}: {t.direction === "unknown" ? "direction unknown" : t.direction}
                  {t.current !== null && t.previous !== null ? ` (${t.previous} → ${t.current})` : ""} — {t.note}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v.gaps.length > 0 && (
          <div>
            <p className="font-medium">Questions where you are not named</p>
            <ul className="mt-1 space-y-1">
              {v.gaps.slice(0, 6).map((g) => (
                <li key={g.query} className="text-muted-foreground">
                  “{g.query}” — {g.answersRead} answer(s) read{g.competitorsNamed.length ? `; named instead: ${g.competitorsNamed.slice(0, 3).join(", ")}` : "; no brokerage named yet"}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v.competitors.length > 0 && (
          <div>
            <p className="font-medium">Competitors seen</p>
            <ul className="mt-1 space-y-1">
              {v.competitors.slice(0, 6).map((c) => (
                <li key={c.name} className="text-muted-foreground">{c.name} — {c.evidence.join("; ")}</li>
              ))}
            </ul>
          </div>
        )}

        {v.contentHooks.length > 0 && (
          <div>
            <p className="font-medium">What to make next</p>
            <ul className="mt-1 space-y-2">
              {v.contentHooks.slice(0, 5).map((h, i) => (
                <li key={`${h.kind}-${i}`}>
                  <span>{h.title}</span>
                  <p className="text-xs text-muted-foreground">{h.evidence.join(" · ")}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">{v.rankPolicy}</p>
        {v.blindSpots.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary>What could not be read ({v.blindSpots.length})</summary>
            <ul className="mt-1 list-disc pl-4">{v.blindSpots.slice(0, 12).map((b, i) => <li key={i}>{b}</li>)}</ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
