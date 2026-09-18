import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  ArrowLeft,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  Home,
  AlertTriangle,
  Clock,
} from "lucide-react"
import Link from "next/link"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export default async function ListingsAIPricingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const [listingsResult, predictionsResult, alertsResult] = await Promise.all([
    service
      .from("listings")
      .select("id, property_address:address, list_price, status, bedrooms, bathrooms, sqft, city, state")
      .eq("brokerage_id", profile.brokerage_id)
      .in("status", ["active", "coming_soon"])
      .order("created_at", { ascending: false })
      .limit(20),
    service
      .from("price_predictions")
      .select("listing_id, predicted_price, confidence_score, trend_direction, trend_percentage, days_to_sell_estimate, prediction_date")
      .eq("brokerage_id", profile.brokerage_id)
      .order("prediction_date", { ascending: false }),
    service
      .from("price_trend_alerts")
      .select("listing_id, alert_type, message")
      .eq("brokerage_id", profile.brokerage_id)
      .is("resolved_at", null),
  ])

  const listings = listingsResult.data ?? []
  const predByListing = Object.fromEntries(
    (predictionsResult.data ?? []).map((p) => [p.listing_id, p])
  )
  const alertsByListing = (alertsResult.data ?? []).reduce<Record<string, typeof alertsResult.data>>((acc, a) => {
    if (!acc[a.listing_id]) acc[a.listing_id] = []
    acc[a.listing_id]!.push(a)
    return acc
  }, {})

  const predictions = predictionsResult.data ?? []
  const listingsWithPrediction = listings.filter((l) => predByListing[l.id])
  const avgConfidence =
    predictions.length > 0
      ? Math.round(predictions.reduce((s, p) => s + (p.confidence_score ?? 0), 0) / predictions.length)
      : 0

  return (
    <div className="space-y-6">
      {/* Command strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/listings">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Listings
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-balance">AI Price Analysis</h1>
            <p className="text-muted-foreground">Predictions run nightly from comparable sales data.</p>
          </div>
        </div>

        {/* Summary strip */}
        {listings.length > 0 && (
          <div className="flex flex-wrap gap-4 p-4 rounded-lg border border-border bg-muted/20 text-sm">
            <span>
              <span className="font-semibold">{listingsWithPrediction.length}</span>
              {" of "}
              <span className="font-semibold">{listings.length}</span>
              {" listings have AI predictions"}
            </span>
            {predictions.length > 0 && (
              <span className="text-muted-foreground">
                Average confidence:{" "}
                <span className="font-semibold text-foreground">{avgConfidence}%</span>
              </span>
            )}
            <span className="text-muted-foreground">Predictions run nightly automatically.</span>
          </div>
        )}

        {/* Listing cards */}
        {listings.length > 0 ? (
          <div className="space-y-4">
            {listings.map((listing) => {
              const pred = predByListing[listing.id]
              const listingAlerts = alertsByListing[listing.id] ?? []
              const currentPrice = listing.list_price ?? 0

              return (
                <Card key={listing.id}>
                  <CardContent className="pt-6 space-y-4">
                    {/* Top row: address + price columns */}
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      {/* Property info */}
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="shrink-0 p-3 rounded-lg bg-muted">
                          <Home className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold truncate">
                            {listing.property_address || `Listing #${listing.id.slice(0, 8)}`}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {listing.bedrooms ?? 0} bed / {listing.bathrooms ?? 0} bath
                            {listing.sqft ? ` / ${listing.sqft.toLocaleString()} sqft` : ""}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {[listing.city, listing.state].filter(Boolean).join(", ")}
                          </p>
                        </div>
                      </div>

                      {pred ? (
                        /* ── Has prediction ── */
                        <div className="flex flex-wrap items-center gap-6 shrink-0">
                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">Current Price</p>
                            <p className="text-lg font-semibold">${currentPrice.toLocaleString()}</p>
                          </div>

                          {/* Trend icon */}
                          <div className="flex items-center">
                            {pred.trend_direction === "up" ? (
                              <TrendingUp className="h-5 w-5 text-green-500" />
                            ) : pred.trend_direction === "down" ? (
                              <TrendingDown className="h-5 w-5 text-red-500" />
                            ) : (
                              <Minus className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>

                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">AI Predicted Value</p>
                            <p className="text-2xl font-bold text-primary">
                              ${pred.predicted_price?.toLocaleString() ?? "—"}
                            </p>
                            {pred.predicted_price && currentPrice > 0 && (() => {
                              const diff = pred.predicted_price - currentPrice
                              const pct = ((diff / currentPrice) * 100).toFixed(1)
                              const positive = diff >= 0
                              return (
                                <p className={`text-xs ${positive ? "text-green-600" : "text-red-500"}`}>
                                  {positive ? "+" : ""}
                                  {pct}% ({positive ? "+" : ""}${Math.abs(diff).toLocaleString()})
                                </p>
                              )
                            })()}
                          </div>

                          <Link href={`/dashboard/listings/${listing.id}?suggestedPrice=${pred.predicted_price ?? ""}`}>
                            <Button size="sm" variant="outline" className="whitespace-nowrap">
                              Apply Price
                            </Button>
                          </Link>
                        </div>
                      ) : (
                        /* ── No prediction yet ── */
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="h-4 w-4 shrink-0" />
                          <span>Awaiting prediction — runs nightly from comparable sales data</span>
                        </div>
                      )}
                    </div>

                    {/* Prediction detail row */}
                    {pred && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-border">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Confidence</p>
                          <div className="flex items-center gap-2">
                            <Progress value={pred.confidence_score ?? 0} className="h-2 flex-1" />
                            <span className="text-xs font-medium tabular-nums">
                              {pred.confidence_score ?? 0}%
                            </span>
                          </div>
                        </div>

                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Trend</p>
                          <div className="flex items-center gap-1.5">
                            {pred.trend_direction === "up" ? (
                              <TrendingUp className="h-3.5 w-3.5 text-green-500" />
                            ) : pred.trend_direction === "down" ? (
                              <TrendingDown className="h-3.5 w-3.5 text-red-500" />
                            ) : (
                              <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="text-sm font-medium">
                              {pred.trend_percentage != null
                                ? `${pred.trend_percentage > 0 ? "+" : ""}${pred.trend_percentage}%`
                                : "—"}
                            </span>
                          </div>
                        </div>

                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Est. Days to Sell</p>
                          <p className="text-sm font-medium">
                            {pred.days_to_sell_estimate != null
                              ? `${pred.days_to_sell_estimate} days`
                              : "—"}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Unresolved alerts */}
                    {listingAlerts.length > 0 && (
                      <div className="space-y-1.5 pt-2 border-t border-border">
                        {listingAlerts.map((a, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            <span>{a.message}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Prediction date */}
                    {pred?.prediction_date && (
                      <p className="text-xs text-muted-foreground">
                        Last updated{" "}
                        {new Date(pred.prediction_date).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">No Active Listings</h3>
              <p className="text-muted-foreground mb-4">
                Add active or coming-soon listings to see AI price predictions.
              </p>
              <Link href="/dashboard/listings?action=new">
                <Button>Create Listing</Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
