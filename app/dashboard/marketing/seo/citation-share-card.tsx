import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Trophy, TriangleAlert } from "lucide-react"
import { citationShare, describeCitationShare, type ShareObservationRow } from "@/lib/geo/citation-share"

/**
 * GEO CITATION SHARE — the KPI a broker can act on.
 *
 * Two numbers, deliberately side by side, because they are different questions
 * and can move in OPPOSITE directions: the citation rate is our hit rate on the
 * answers we read, while share of voice is how much of the naming went to us
 * rather than to a rival. A broker whose rate doubled while a competitor's went
 * up six times is losing, and a card showing only the rate would congratulate
 * them for it.
 *
 * The sample size shown is ANSWERS READ, not observation rows. The monitor
 * writes five rows per answer (one per platform vocabulary, all scored from the
 * same fetched text), so counting rows would report a month of 50 real queries
 * as 250 checks. See lib/geo/citation-share.ts.
 */
export function CitationShareCard({ rows }: { rows: ShareObservationRow[] }) {
  const share = citationShare(rows)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="h-4 w-4" />
          AI Citation Share
        </CardTitle>
        <CardDescription>
          When an AI answers a buyer&apos;s question in your market, how often does it name you —
          and how much of the naming goes to a competitor instead?
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{describeCitationShare(share)}</p>

        {share.citationRatePct !== null && (
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="Citation rate"
              value={`${share.citationRatePct}%`}
              sub={`${share.queriesCited} of ${share.queriesChecked} answers read`}
            />
            <Metric
              label="Share of voice"
              // Null is NOT zero here: nobody was named at all. Saying 0% would
              // tell the broker a rival beat them when the category is open.
              value={share.shareOfVoicePct === null ? "—" : `${share.shareOfVoicePct}%`}
              sub={
                share.shareOfVoicePct === null
                  ? "no brokerage named yet"
                  : `${share.ourCitations} of ${share.ourCitations + share.competitorCitations} brokerage mentions`
              }
            />
          </div>
        )}

        {share.queriesNotChecked > 0 && (
          <p className="text-xs text-amber-700 flex items-start gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {share.queriesNotChecked} answer{share.queriesNotChecked === 1 ? "" : "s"} couldn&apos;t be
            read in this window. Those are excluded from both numbers — a monitoring gap is not a
            citation miss.
          </p>
        )}

        {share.topCompetitors.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Who else the AI named</p>
            <div className="space-y-1.5">
              {share.topCompetitors.slice(0, 5).map((c) => (
                <div key={c.name} className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate">{c.name}</span>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {c.sharePct}% · {c.citations}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums mt-0.5">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </div>
  )
}
