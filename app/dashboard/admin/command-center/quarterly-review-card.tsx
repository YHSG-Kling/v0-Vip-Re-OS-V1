/**
 * QUARTERLY BUSINESS REVIEW card (tenant concierge #32) + the ADOPTION
 * PULSE (#23/#31) — one calm principal-facing read on the Command Center:
 * outcomes, the trust the team earned, what's unused, next moves, and
 * (multi-agent accounts) who needs a hand this week with the coachable
 * reasons. Server component; every number is a real trailing-90d count.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CalendarRange, HandHeart } from "lucide-react"
import type { QuarterlyReview } from "@/lib/intelligence/quarterly-review"
import type { PulseEntry } from "@/lib/intelligence/adoption-pulse"

export function QuarterlyReviewCard({ review, pulse }: { review: QuarterlyReview; pulse: PulseEntry[] }) {
  const section = (label: string, lines: string[]) =>
    lines.length > 0 ? (
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <ul className="mt-1 space-y-0.5 text-xs">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      </div>
    ) : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-emerald-700" /> {review.headline}
          <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">quarterly review</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {section("Outcomes", review.outcomes)}
        {section("Trust earned", review.trust)}
        {section("Teamwork", review.teamwork ?? [])}
        {section("Sitting unused", review.gaps)}
        {section("Next moves", review.nextMoves)}
        {pulse.length > 0 && (
          <div className="md:col-span-2 rounded-md border bg-amber-50/50 p-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-900 flex items-center gap-1">
              <HandHeart className="h-3 w-3" /> Who needs a hand this week
            </p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {pulse.map((p) => (
                <li key={p.agentId}><span className="font-medium">{p.name}</span> — {p.reasons.join("; ")}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
