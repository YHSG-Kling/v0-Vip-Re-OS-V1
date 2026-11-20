import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { CalendarDays, Eye, Heart, MessageSquare, Users, TrendingUp } from "lucide-react"

// Renders the seller's weekly digest (seller_weekly_reports.report_content, written by
// runSellerWeeklyReports). Pure display of evidence-derived, client-safe numbers — no raw feedback,
// no fabricated figures. Absent/empty report → renders nothing (the card simply doesn't appear).

interface WeeklyReport {
  week_start?: string
  headline?: string
  momentum?: "strong" | "steady" | "building"
  activity?: {
    showings_this_week?: number
    total_showings?: number
    views?: number
    saves?: number
    inquiries?: number
    days_on_market?: number | null
    marketing_channels?: number
  }
  feedback_note?: string
}

const MOMENTUM_LABEL: Record<string, string> = { strong: "Strong week", steady: "Steady interest", building: "Building interest" }
const MOMENTUM_CLASS: Record<string, string> = {
  strong: "bg-emerald-100 text-emerald-700 border-emerald-200",
  steady: "bg-blue-100 text-blue-700 border-blue-200",
  building: "bg-amber-100 text-amber-700 border-amber-200",
}

/**
 * generatedAt — seller_weekly_reports.generated_at, the moment the runner compiled
 * this digest (lib/listings/seller-weekly-report-runner.ts:84). The week label lives
 * in report_week_start; this is the freshness stamp, without which the seller cannot
 * tell a digest cut this morning from one cut six days ago. Absent → no line, never
 * a fabricated "today".
 */
export function SellerWeeklyReportCard({
  report,
  generatedAt = null,
}: {
  report: WeeklyReport | null
  generatedAt?: string | null
}) {
  if (!report || !report.headline) return null
  const compiled = generatedAt ? new Date(generatedAt) : null
  const compiledLabel =
    compiled && !Number.isNaN(compiled.getTime())
      ? compiled.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null
  const a = report.activity ?? {}
  const stats: Array<{ icon: React.ReactNode; label: string; value: number | null | undefined }> = [
    { icon: <Users className="h-4 w-4 text-blue-600" />, label: "Showings this week", value: a.showings_this_week },
    { icon: <Eye className="h-4 w-4 text-purple-600" />, label: "Views", value: a.views },
    { icon: <Heart className="h-4 w-4 text-rose-600" />, label: "Saves", value: a.saves },
    { icon: <MessageSquare className="h-4 w-4 text-amber-600" />, label: "Inquiries", value: a.inquiries },
  ]
  const shown = stats.filter((s) => typeof s.value === "number")

  return (
    <Card className="shadow-lg border-0">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-emerald-600" />
            Your Week at a Glance
          </CardTitle>
          {report.momentum && (
            <Badge variant="outline" className={`text-xs ${MOMENTUM_CLASS[report.momentum] ?? ""}`}>
              <TrendingUp className="h-3 w-3 mr-1" />
              {MOMENTUM_LABEL[report.momentum] ?? report.momentum}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-foreground leading-relaxed">{report.headline}</p>

        {shown.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {shown.map((s) => (
              <div key={s.label} className="rounded-lg border bg-muted/30 p-2.5 text-center">
                <div className="flex justify-center mb-1">{s.icon}</div>
                <p className="text-lg font-semibold text-foreground">{s.value}</p>
                <p className="text-[11px] text-muted-foreground leading-tight">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {typeof a.days_on_market === "number" && (
            <Badge variant="outline" className="text-xs">{a.days_on_market} {a.days_on_market === 1 ? "day" : "days"} on market</Badge>
          )}
          {typeof a.total_showings === "number" && a.total_showings > 0 && (
            <Badge variant="outline" className="text-xs">{a.total_showings} total showings</Badge>
          )}
          {typeof a.marketing_channels === "number" && a.marketing_channels > 0 && (
            <Badge variant="outline" className="text-xs">Promoted on {a.marketing_channels} channels</Badge>
          )}
        </div>

        {report.feedback_note && (
          <p className="text-xs text-muted-foreground border-t pt-3">{report.feedback_note}</p>
        )}

        {compiledLabel && (
          <p className="text-[11px] text-muted-foreground">Compiled {compiledLabel}</p>
        )}
      </CardContent>
    </Card>
  )
}
