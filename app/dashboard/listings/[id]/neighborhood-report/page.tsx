import { Suspense } from "react"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import {
  getNeighborhoodReport,
  refreshNeighborhoodReport,
  generateEmbedSnippet,
  type SchoolRating,
  type AmenitiesData,
  type PriceHistoryPoint,
  type DataSource,
} from "@/app/actions/neighborhood-reports"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ArrowLeft,
  RefreshCw,
  Copy,
  Home,
  DollarSign,
  Clock,
  TrendingUp,
  GraduationCap,
  MapPin,
  Bus,
  Shield,
  Utensils,
  ShoppingCart,
  Trees,
  Train,
  AlertCircle,
  CheckCircle,
  Star,
} from "lucide-react"

// Import chart component as a separate client component
import { PriceHistoryChart } from "@/app/components/neighborhood-report/PriceHistoryChart"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Neighborhood Report | VIP-OS",
  description: "Detailed neighborhood intelligence report for listing",
}

// ============================================================================
// Main Page Component
// ============================================================================

export default async function NeighborhoodReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: listingId } = await params
  const { report, listing, priceHistory, dataSources } = await getNeighborhoodReport(listingId)

  if (!listing) {
    notFound()
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Back Navigation */}
        <Link
          href={`/dashboard/listings/${listingId}`}
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Listing
        </Link>

        {report ? (
          <NeighborhoodReportContent
            report={report}
            listing={listing}
            priceHistory={priceHistory}
            dataSources={dataSources}
            listingId={listingId}
          />
        ) : (
          <EmptyState listingId={listingId} listing={listing} />
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Report Content Component
// ============================================================================

interface ReportContentProps {
  report: {
    id: string
    neighborhood_name: string
    generated_at: string
    expires_at: string | null
    median_home_price: number | null
    price_per_sqft: number | null
    avg_days_on_market: number | null
    list_to_sale_ratio: number | null
    school_ratings: SchoolRating[] | null
    walk_score: number | null
    transit_score: number | null
    crime_index: number | null
    amenities_json: AmenitiesData | null
    ai_summary: string | null
    market_trend: string | null
    data_source: string | null
  }
  listing: { address: string; city: string; state: string; zip_code: string }
  priceHistory: PriceHistoryPoint[]
  dataSources: DataSource[]
  listingId: string
}

function NeighborhoodReportContent({
  report,
  listing,
  priceHistory,
  dataSources,
  listingId,
}: ReportContentProps) {
  const generatedDate = new Date(report.generated_at)
  const now = new Date()
  const daysSinceGenerated = Math.floor((now.getTime() - generatedDate.getTime()) / (1000 * 60 * 60 * 24))
  
  const freshnessColor = daysSinceGenerated > 30 ? "destructive" : daysSinceGenerated > 7 ? "secondary" : "default"
  const freshnessLabel = daysSinceGenerated === 0 ? "Today" : `${daysSinceGenerated} days ago`

  const isExpired = report.expires_at ? new Date(report.expires_at) < now : false

  return (
    <div className="space-y-6">
      {/* Section 1: Report Header */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-2xl flex items-center gap-2">
                <Home className="h-6 w-6" />
                {listing.address}
              </CardTitle>
              <CardDescription className="text-lg">
                {report.neighborhood_name}
              </CardDescription>
              <p className="text-sm text-muted-foreground">
                {listing.city}, {listing.state} {listing.zip_code}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Badge variant={freshnessColor} className="w-fit">
                Updated {freshnessLabel}
              </Badge>
              <RefreshButton listingId={listingId} isExpired={isExpired} />
              <EmbedButton listingId={listingId} />
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Section 2: Market Stats Row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          label="Median Home Price"
          value={report.median_home_price ? `$${report.median_home_price.toLocaleString()}` : "N/A"}
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Price Per Sq Ft"
          value={report.price_per_sqft ? `$${report.price_per_sqft.toFixed(0)}` : "N/A"}
        />
        <StatCard
          icon={<Clock className="h-5 w-5" />}
          label="Avg Days on Market"
          value={report.avg_days_on_market?.toString() || "N/A"}
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="List-to-Sale Ratio"
          value={report.list_to_sale_ratio ? `${(report.list_to_sale_ratio * 100).toFixed(1)}%` : "N/A"}
        />
      </div>

      {/* Section 3: Price Per Sqft Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Price Per Sq Ft Trend</CardTitle>
          <CardDescription>Historical pricing data for this area</CardDescription>
        </CardHeader>
        <CardContent>
          {priceHistory.length > 1 ? (
            <div className="h-64">
              <PriceHistoryChart data={priceHistory} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No historical price data available</p>
          )}
        </CardContent>
      </Card>

      {/* Section 4: Schools Section */}
      {report.school_ratings && report.school_ratings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Schools
            </CardTitle>
            <CardDescription>Nearby schools sorted by rating</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[...report.school_ratings]
                .sort((a, b) => b.rating - a.rating)
                .map((school, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="capitalize">
                        {school.level}
                      </Badge>
                      <span className="font-medium">{school.school_name}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-1">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        <span className="font-semibold">{school.rating}/10</span>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {school.distance.toFixed(1)} mi
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section 5: Livability Scores Row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <LivabilityCard
          icon={<MapPin className="h-5 w-5" />}
          label="Walk Score"
          score={report.walk_score}
          getLabel={getWalkScoreLabel}
        />
        <LivabilityCard
          icon={<Bus className="h-5 w-5" />}
          label="Transit Score"
          score={report.transit_score}
          getLabel={getTransitScoreLabel}
        />
        <CrimeIndexCard crimeIndex={report.crime_index} />
      </div>

      {/* Section 6: Amenities */}
      {report.amenities_json && Object.keys(report.amenities_json).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Nearby Amenities</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              <AmenityGroup
                icon={<Utensils className="h-4 w-4" />}
                label="Restaurants"
                items={report.amenities_json.restaurants}
              />
              <AmenityGroup
                icon={<ShoppingCart className="h-4 w-4" />}
                label="Grocery"
                items={report.amenities_json.grocery}
              />
              <AmenityGroup
                icon={<Trees className="h-4 w-4" />}
                label="Parks"
                items={report.amenities_json.parks}
              />
              <AmenityGroup
                icon={<GraduationCap className="h-4 w-4" />}
                label="Schools"
                items={report.amenities_json.schools}
              />
              <AmenityGroup
                icon={<Train className="h-4 w-4" />}
                label="Transit"
                items={report.amenities_json.transit}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section 7: AI Summary Block */}
      {report.ai_summary && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg">AI-Generated Market Analysis</CardTitle>
                <CardDescription>Powered by advanced language models</CardDescription>
              </div>
              {report.market_trend && (
                <MarketTrendBadge trend={report.market_trend} />
              )}
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground leading-relaxed whitespace-pre-line">
              {report.ai_summary}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Section 8: Data Sources Footer */}
      {dataSources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Data Sources</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              {dataSources.map((source) => (
                <div key={source.id} className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  <span className="text-sm font-medium">{source.source_name}</span>
                  {source.last_synced_at && (
                    <span className="text-xs text-muted-foreground">
                      (synced {new Date(source.last_synced_at).toLocaleDateString()})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ============================================================================
// Helper Components
// ============================================================================

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-xl font-semibold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LivabilityCard({
  icon,
  label,
  score,
  getLabel,
}: {
  icon: React.ReactNode
  label: string
  score: number | null
  getLabel: (score: number) => { label: string; color: string }
}) {
  if (score === null) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted text-muted-foreground">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-lg font-medium">N/A</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { label: scoreLabel, color } = getLabel(score)

  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>{icon}</div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <div className="flex items-center gap-2">
            <p className="text-2xl font-bold">{score}</p>
            <Badge variant="outline">{scoreLabel}</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CrimeIndexCard({ crimeIndex }: { crimeIndex: number | null }) {
  if (crimeIndex === null) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted text-muted-foreground">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Crime Index</p>
            <p className="text-lg font-medium">N/A</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { label, color, bgColor } = getCrimeIndexLabel(crimeIndex)

  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-lg ${bgColor}`}>
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Crime Index</p>
          <Badge className={color}>{label}</Badge>
        </div>
      </CardContent>
    </Card>
  )
}

function AmenityGroup({
  icon,
  label,
  items,
}: {
  icon: React.ReactNode
  label: string
  items?: { name: string; distance: number }[]
}) {
  if (!items || items.length === 0) return null

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="font-medium">{label}</span>
        <Badge variant="secondary" className="ml-auto">
          {items.length}
        </Badge>
      </div>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {items.slice(0, 5).map((item, index) => (
          <li key={index} className="flex justify-between">
            <span className="truncate">{item.name}</span>
            <span>{item.distance.toFixed(1)} mi</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MarketTrendBadge({ trend }: { trend: string }) {
  const trendConfig: Record<string, { color: string; label: string }> = {
    hot: { color: "bg-red-500 text-white", label: "Hot" },
    warm: { color: "bg-orange-500 text-white", label: "Warm" },
    cooling: { color: "bg-blue-400 text-white", label: "Cooling" },
    cold: { color: "bg-blue-700 text-white", label: "Cold" },
  }

  const config = trendConfig[trend.toLowerCase()] || { color: "bg-gray-500 text-white", label: trend }

  return <Badge className={config.color}>{config.label}</Badge>
}

// ============================================================================
// Interactive Components (Client)
// ============================================================================

function RefreshButton({ listingId, isExpired }: { listingId: string; isExpired: boolean }) {
  async function handleRefresh() {
    "use server"
    await refreshNeighborhoodReport(listingId)
    redirect(`/dashboard/listings/${listingId}/neighborhood-report`)
  }

  return (
    <form action={handleRefresh}>
      <Button type="submit" variant="outline" size="sm" className="gap-2">
        <RefreshCw className="h-4 w-4" />
        Refresh Data
      </Button>
    </form>
  )
}

function EmbedButton({ listingId }: { listingId: string }) {
  async function handleCopyEmbed() {
    "use server"
    const snippet = await generateEmbedSnippet(listingId)
    // Note: Server actions can't access clipboard, this would need client component
    console.log("Embed snippet:", snippet)
  }

  return (
    <form action={handleCopyEmbed}>
      <Button type="submit" variant="outline" size="sm" className="gap-2">
        <Copy className="h-4 w-4" />
        Embed on Landing Page
      </Button>
    </form>
  )
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({
  listingId,
  listing,
}: {
  listingId: string
  listing: { address: string; city: string; state: string; zip_code: string }
}) {
  async function handleGenerate() {
    "use server"
    await refreshNeighborhoodReport(listingId)
    redirect(`/dashboard/listings/${listingId}/neighborhood-report`)
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Neighborhood report not yet generated</h2>
        <p className="text-muted-foreground mb-6 max-w-md">
          Generate a comprehensive neighborhood report for {listing.address}, {listing.city},{" "}
          {listing.state} {listing.zip_code}
        </p>
        <form action={handleGenerate}>
          <Button type="submit" size="lg" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Generate Report
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-4">
          Report generation may take a moment. Check back shortly.
        </p>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Score Label Helpers
// ============================================================================

function getWalkScoreLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Walker's Paradise", color: "bg-green-100 text-green-700" }
  if (score >= 70) return { label: "Very Walkable", color: "bg-green-50 text-green-600" }
  if (score >= 50) return { label: "Somewhat Walkable", color: "bg-yellow-50 text-yellow-700" }
  if (score >= 25) return { label: "Car-Dependent", color: "bg-orange-50 text-orange-700" }
  return { label: "Almost All Errands Require a Car", color: "bg-red-50 text-red-700" }
}

function getTransitScoreLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Excellent Transit", color: "bg-green-100 text-green-700" }
  if (score >= 70) return { label: "Great Transit", color: "bg-green-50 text-green-600" }
  if (score >= 50) return { label: "Good Transit", color: "bg-yellow-50 text-yellow-700" }
  if (score >= 25) return { label: "Some Transit", color: "bg-orange-50 text-orange-700" }
  return { label: "Minimal Transit", color: "bg-red-50 text-red-700" }
}

function getCrimeIndexLabel(index: number): { label: string; color: string; bgColor: string } {
  if (index <= 25) return { label: "Low", color: "bg-green-500 text-white", bgColor: "bg-green-100 text-green-700" }
  if (index <= 50) return { label: "Medium", color: "bg-yellow-500 text-white", bgColor: "bg-yellow-100 text-yellow-700" }
  if (index <= 75) return { label: "High", color: "bg-orange-500 text-white", bgColor: "bg-orange-100 text-orange-700" }
  return { label: "Very High", color: "bg-red-500 text-white", bgColor: "bg-red-100 text-red-700" }
}
