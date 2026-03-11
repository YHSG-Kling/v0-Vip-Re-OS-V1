import { notFound } from "next/navigation"
import { Suspense } from "react"
import { getHomeValueResult } from "@/app/actions/home-value"
import { ValuationResultCard } from "@/app/components/home-value/ValuationResultCard"
import { CompsTable } from "@/app/components/home-value/CompsTable"
import { EquityCalculator } from "@/app/components/home-value/EquityCalculator"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Phone, Mail, TrendingUp, TrendingDown, Minus, Calendar, MapPin } from "lucide-react"
import Link from "next/link"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params
  return {
    title: "Your Home Value Estimate | Results",
    description: `View your personalized home value estimate for request ${requestId}`,
  }
}

interface PageProps {
  params: Promise<{ requestId: string }>
}

export default async function HomeValueResultPage({ params }: PageProps) {
  const { requestId } = await params

  const result = await getHomeValueResult(requestId)

  if (!result.success || !result.estimate) {
    notFound()
  }

  const { estimate, agent } = result
  const marketTrendIcon =
    estimate.marketTrend === "appreciating" ? (
      <TrendingUp className="h-4 w-4 text-green-600" />
    ) : estimate.marketTrend === "depreciating" ? (
      <TrendingDown className="h-4 w-4 text-red-600" />
    ) : (
      <Minus className="h-4 w-4 text-muted-foreground" />
    )

  const marketTrendColor =
    estimate.marketTrend === "appreciating"
      ? "bg-green-100 text-green-800"
      : estimate.marketTrend === "depreciating"
        ? "bg-red-100 text-red-800"
        : "bg-muted text-muted-foreground"

  return (
    <main className="min-h-screen bg-background py-8 px-4">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Section 1: Estimate Header */}
        <ValuationResultCard
          propertyAddress={estimate.propertyAddress}
          estimatedValueLow={estimate.estimatedValueLow}
          estimatedValueMid={estimate.estimatedValueMid}
          estimatedValueHigh={estimate.estimatedValueHigh}
          confidenceScore={estimate.confidenceScore}
          methodology={estimate.methodology}
          marketTrend={estimate.marketTrend}
          generatedAt={estimate.generatedAt}
        />

        {/* Section 2: AI Narrative */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              AI Analysis
              <Badge variant="outline" className="text-xs font-normal">
                Estimated Range Based on Market Data
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm max-w-none text-muted-foreground">
              {estimate.aiNarrative.split("\n\n").map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Equity Calculator */}
        <EquityCalculator estimatedValue={estimate.estimatedValueMid} />

        {/* Section 4: Comparable Sales Table */}
        <CompsTable comps={estimate.comps} />

        {/* Section 5: Market Trend Mini-Chart Placeholder */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Market Trend
              <Badge className={marketTrendColor}>
                <span className="flex items-center gap-1">
                  {marketTrendIcon}
                  {estimate.marketTrend.charAt(0).toUpperCase() + estimate.marketTrend.slice(1)}
                </span>
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {estimate.comps && estimate.comps.length > 0 ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold text-foreground">
                      ${Math.round(estimate.comps.reduce((sum, c) => sum + c.price_per_sqft, 0) / estimate.comps.length)}
                    </p>
                    <p className="text-sm text-muted-foreground">Avg $/Sq Ft</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold text-foreground">
                      {Math.round(estimate.comps.reduce((sum, c) => sum + c.distance_miles, 0) / estimate.comps.length * 10) / 10} mi
                    </p>
                    <p className="text-sm text-muted-foreground">Avg Distance</p>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50">
                    <p className="text-2xl font-bold text-foreground">{estimate.comps.length}</p>
                    <p className="text-sm text-muted-foreground">Comparables</p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                Market trend data loading — check back soon for detailed analytics.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Section 6: Agent CTA Card */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row items-center gap-6">
              {agent ? (
                <>
                  {agent.profile_image_url && (
                    <img
                      src={agent.profile_image_url}
                      alt={`${agent.first_name} ${agent.last_name}`}
                      className="h-20 w-20 rounded-full object-cover border-2 border-primary"
                    />
                  )}
                  <div className="flex-1 text-center sm:text-left">
                    <h3 className="text-xl font-semibold text-foreground">
                      {agent.first_name} {agent.last_name}
                    </h3>
                    <p className="text-muted-foreground mb-4">Your Local Real Estate Expert</p>
                    <div className="flex flex-col sm:flex-row gap-3">
                      {agent.phone_mobile && (
                        <Button asChild>
                          <a href={`tel:${agent.phone_mobile}`}>
                            <Phone className="h-4 w-4 mr-2" />
                            Call Now
                          </a>
                        </Button>
                      )}
                      {agent.email && (
                        <Button variant="outline" asChild>
                          <a href={`mailto:${agent.email}?subject=Home Value Estimate Question`}>
                            <Mail className="h-4 w-4 mr-2" />
                            Email
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 text-center">
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    Talk to a Local Expert
                  </h3>
                  <p className="text-muted-foreground mb-4">
                    Get a more accurate, in-person assessment of your home's value
                  </p>
                  <Button size="lg">Request a Free Consultation</Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Back to Home Link */}
        <div className="text-center">
          <Link href="/home-value" className="text-primary hover:underline text-sm">
            Get another estimate
          </Link>
        </div>

        {/* Disclaimer */}
        <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto">
          This estimate is generated by AI using publicly available market data and should be used
          for informational purposes only. Actual home values may vary based on condition, upgrades,
          and current market conditions. For a precise valuation, consult with a licensed real
          estate professional.
        </p>
      </div>
    </main>
  )
}
