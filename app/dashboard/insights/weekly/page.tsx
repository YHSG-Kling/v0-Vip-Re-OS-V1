import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getWeeklyInsights } from "@/app/actions/weekly-insights"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Sparkles, ArrowRight } from "lucide-react"

export const dynamic = "force-dynamic"
export const metadata = { title: "What got smarter this week" }

export default async function WeeklyInsightsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const insights = await getWeeklyInsights()
  const empty = insights.metrics.length === 0 && insights.highlights.length === 0

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-amber-500" />
          What got smarter this week
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {insights.weekStart} — {insights.weekEnd}. Each week your AI learns from
          how you work and surfaces what's improving.
        </p>
      </div>

      {empty ? (
        <Card>
          <CardContent className="p-12 text-center text-sm text-muted-foreground">
            Not enough data yet. As you use the AI assistant, send drafts, and tour properties,
            this digest will start filling in.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Headline highlights */}
          {insights.highlights.length > 0 && (
            <Card className="border-amber-200 bg-gradient-to-br from-amber-50/50 to-orange-50/30">
              <CardContent className="p-5 space-y-2">
                {insights.highlights.map((h, i) => (
                  <p key={i} className="text-sm leading-relaxed flex items-start gap-2">
                    <ArrowRight className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <span>{h}</span>
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Metric grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {insights.metrics.map((m, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                    {m.label}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold">{m.value}</span>
                    {m.delta != null && m.delta !== 0 && (
                      <Badge
                        variant="outline"
                        className={`text-xs ${
                          m.delta > 0
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-red-200 bg-red-50 text-red-700"
                        }`}
                      >
                        {m.delta > 0 ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                        {m.delta > 0 ? "+" : ""}
                        {m.delta}% wow
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{m.narrative}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <p className="text-[11px] text-muted-foreground text-center pt-4">
        Generated {new Date(insights.generatedAt).toLocaleString()}.
      </p>
    </div>
  )
}
