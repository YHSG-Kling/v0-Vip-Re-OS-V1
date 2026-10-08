import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Radio } from "lucide-react"
import type { BrandListeningReading } from "@/lib/competitive-intel/brand-listening"

// BRAND LISTENING (wave 139H) — the reading of brand_mentions on the Competitive Monitor: volume,
// sentiment of OUR mentions, share of voice against the watched rivals (the GEO citationShare KPI,
// over mentions), live spikes, discussion topics and the newest mentions. The AI insights the pass
// writes ride the existing ad_insights rail (insight type "Brand Listening") rendered by the client
// below this card. Server component; the reading was taken with the SESSION client (RLS-scoped).

const SENTIMENT_TONE: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  neutral: "bg-muted text-muted-foreground",
  negative: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
}

export function BrandListeningCard({ reading }: { reading: BrandListeningReading }) {
  const sov = reading.shareOfVoice
  const s = reading.ourSentiment
  const delta = reading.mentions7d - reading.mentionsPrev7d
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="h-4 w-4" /> Brand listening
        </CardTitle>
        <CardDescription>
          Public mentions of your brokerage, agents, teams, listings, watched competitors and tracked keywords
          over the last {reading.windowDays} days. Platform-covered — never billed to your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {reading.refused ? (
          <p className="text-muted-foreground">Mentions could not be read right now ({reading.refused}). This is a monitoring gap, not a result.</p>
        ) : reading.mentions === 0 ? (
          <p className="text-muted-foreground">No public mentions captured yet. The daily listening pass will fill this in.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">Mentions (7d)</div><div className="text-lg font-semibold">{reading.mentions7d} <span className="text-xs font-normal text-muted-foreground">{delta >= 0 ? "+" : ""}{delta} vs prior 7d</span></div></div>
              <div><div className="text-xs text-muted-foreground">Our sentiment</div><div>{s.positive} positive · {s.neutral} neutral · {s.negative} negative{s.mixed ? ` · ${s.mixed} mixed` : ""}{s.unscored ? ` · ${s.unscored} unscored` : ""}</div></div>
              <div><div className="text-xs text-muted-foreground">Share of voice</div><div className="text-lg font-semibold">{sov.shareOfVoicePct === null ? "—" : `${sov.shareOfVoicePct}%`}</div>{sov.topCompetitors[0] ? <div className="text-xs text-muted-foreground">{sov.topCompetitors[0].name}: {sov.topCompetitors[0].sharePct}%</div> : null}</div>
              <div><div className="text-xs text-muted-foreground">Compliance flags</div><div className="text-lg font-semibold">{reading.complianceFlags}</div></div>
            </div>
            {reading.spikes.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Live spikes (24h)</div>
                {reading.spikes.slice(0, 5).map((sp) => (
                  <div key={sp.subjectKey} className="flex items-center gap-2">
                    <Badge variant="outline">{sp.subjectKind}</Badge>
                    <span>{sp.label}: {sp.recent24h} mentions vs {sp.baselinePerDay}/day{sp.kind === "negative" ? ` — ${sp.negative24h} negative` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            {reading.topics.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {reading.topics.map((t) => <Badge key={t.topic} variant="secondary">{t.topic} · {t.mentions}</Badge>)}
              </div>
            )}
            <ul className="space-y-2">
              {reading.recent.map((m) => (
                <li key={m.id} className="flex flex-col gap-0.5 border-b pb-2 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{m.source}</Badge>
                    {m.sentiment ? <span className={`rounded px-1.5 py-0.5 text-xs ${SENTIMENT_TONE[m.sentiment] ?? ""}`}>{m.sentiment}</span> : null}
                    {m.compliance_flag ? <Badge variant="destructive" title={m.compliance_reason ?? undefined}>compliance review</Badge> : null}
                    <span className="text-xs text-muted-foreground">
                      {m.subject_kind}: {m.subject_label}{m.author ? ` · by ${m.author}` : ""} · {new Date(m.published_at ?? m.captured_at).toLocaleDateString()}
                      {m.reach_estimate !== null ? ` · reach index ${m.reach_estimate}` : ""} · via {m.provider}
                      {m.names_us && m.subject_kind === "competitor" ? " · names you too" : ""}
                    </span>
                  </div>
                  <a href={m.url} target="_blank" rel="noopener noreferrer" className="truncate text-primary hover:underline">{m.title ?? m.url}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}
