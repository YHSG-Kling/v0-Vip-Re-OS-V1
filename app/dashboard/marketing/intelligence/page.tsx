import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getTrendingKeywords, getCompetitorHighPerformers } from "@/app/actions/marketing-intelligence"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Sparkles, ExternalLink, Heart } from "lucide-react"

export const dynamic = "force-dynamic"

const CONTENT_ROLES = new Set(["agent", "broker", "broker_admin", "admin", "superadmin", "team_lead", "isa"])

export default async function MarketIntelligencePage() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!CONTENT_ROLES.has(ctx.userType)) redirect("/dashboard")

  const [keywords, competitors] = await Promise.all([
    getTrendingKeywords({ limit: 24 }),
    getCompetitorHighPerformers({ limit: 12 }),
  ])

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Market Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Trending search topics in your market and competitor posts that are working — fuel for your
            Marketing Studio, blog, and newsletter content.
          </p>
        </div>
      </div>

      {/* Trending keywords */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4" />Trending Keywords</CardTitle>
          <CardDescription>Ranked by search volume — use these as content topics.</CardDescription>
        </CardHeader>
        <CardContent>
          {keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No trending keywords captured yet. The keyword-intelligence scrapers populate this as they run.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {keywords.map((k) => (
                <div key={k.keyword} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{k.keyword}</span>
                    {k.trendChangePct != null && (
                      <span className={`text-xs flex items-center gap-0.5 ${k.trendChangePct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {k.trendChangePct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {Math.abs(k.trendChangePct)}%
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    {k.searchVolume != null && <span>{k.searchVolume.toLocaleString()} searches</span>}
                    {k.intentCategory && <Badge variant="secondary" className="text-[10px]">{k.intentCategory}</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Competitor high-performers */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Heart className="h-4 w-4" />Competitor High-Performers</CardTitle>
          <CardDescription>Posts driving engagement in your market — draw inspiration, don't copy.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {competitors.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No competitor posts captured yet. Social-listening scrapers populate this as they run.
            </p>
          ) : (
            competitors.map((p) => (
              <div key={p.id} className="p-3 rounded-lg border flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{p.competitorName || "Competitor"}</span>
                    <Badge variant="outline" className="text-xs">{p.platform}</Badge>
                    {p.hookType && <Badge variant="secondary" className="text-xs">{p.hookType}</Badge>}
                  </div>
                  {p.caption && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{p.caption}</p>}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                    {p.likesCount != null && <span className="flex items-center gap-0.5"><Heart className="h-3 w-3" />{p.likesCount.toLocaleString()}</span>}
                    {p.engagementRate != null && <span>{p.engagementRate}% eng.</span>}
                    {p.detectedTopics?.slice(0, 3).map((t) => <span key={t}>#{t}</span>)}
                  </div>
                </div>
                {p.contentUrl && (
                  <a href={p.contentUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground shrink-0">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
