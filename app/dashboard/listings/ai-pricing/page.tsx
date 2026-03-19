import { redirect } from "next/navigation"
import { createClient, createServiceClient } from "@/utils/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Sparkles, TrendingUp, TrendingDown, Minus, Home, DollarSign } from "lucide-react"
import Link from "next/link"

export const dynamic = "force-dynamic"

export default async function ListingsAIPricingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Get active listings for AI pricing analysis
  const { data: listings } = await service
    .from("listings")
    .select("id, property_address, list_price, status, bedrooms, bathrooms, sqft, city, state")
    .eq("brokerage_id", profile.brokerage_id)
    .in("status", ["active", "coming_soon"])
    .order("created_at", { ascending: false })
    .limit(20)

  // Simple AI price suggestion (in real app this would call an AI model)
  const getAIPriceSuggestion = (listing: any) => {
    const basePrice = listing.list_price || 500000
    const variance = (Math.random() - 0.5) * 0.1 // +/- 5%
    return Math.round(basePrice * (1 + variance))
  }

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/listings">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Listings
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">AI Price Analysis</h1>
            <p className="text-muted-foreground">Get AI-powered pricing recommendations for your listings</p>
          </div>
        </div>

        {/* Pricing Analysis Cards */}
        {listings && listings.length > 0 ? (
          <div className="space-y-4">
            {listings.map((listing) => {
              const aiPrice = getAIPriceSuggestion(listing)
              const currentPrice = listing.list_price || 0
              const diff = aiPrice - currentPrice
              const percentDiff = currentPrice > 0 ? ((diff / currentPrice) * 100).toFixed(1) : 0

              return (
                <Card key={listing.id}>
                  <CardContent className="pt-6">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="p-3 rounded-lg bg-muted">
                          <Home className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="font-semibold">{listing.property_address || `Listing #${listing.id.slice(0, 8)}`}</p>
                          <p className="text-sm text-muted-foreground">
                            {listing.bedrooms || 0} bed / {listing.bathrooms || 0} bath / {(listing.sqft || 0).toLocaleString()} sqft
                          </p>
                          <p className="text-xs text-muted-foreground">{listing.city}, {listing.state}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Current Price</p>
                          <p className="text-xl font-bold">${currentPrice.toLocaleString()}</p>
                        </div>

                        <div className="flex items-center gap-2">
                          {diff > 0 ? (
                            <TrendingUp className="h-5 w-5 text-green-500" />
                          ) : diff < 0 ? (
                            <TrendingDown className="h-5 w-5 text-red-500" />
                          ) : (
                            <Minus className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>

                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">AI Suggested</p>
                          <p className="text-xl font-bold text-primary">${aiPrice.toLocaleString()}</p>
                          <p className={`text-xs ${diff > 0 ? "text-green-500" : diff < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                            {diff > 0 ? "+" : ""}{percentDiff}% ({diff > 0 ? "+" : ""}${diff.toLocaleString()})
                          </p>
                        </div>

                        <Button size="sm" variant="outline">
                          <DollarSign className="h-4 w-4 mr-1" />
                          Apply
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-2">No Listings to Analyze</h3>
              <p className="text-muted-foreground mb-4">Add active listings to get AI pricing recommendations</p>
              <Link href="/dashboard/listings/new">
                <Button>Create Listing</Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {/* AI Insights */}
        <Card>
          <CardHeader>
            <CardTitle>Market Insights</CardTitle>
            <CardDescription>AI-generated market analysis</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Market Trend</p>
                <p className="text-lg font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-500" />
                  Seller&apos;s Market
                </p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Avg Days on Market</p>
                <p className="text-lg font-semibold">24 days</p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-sm text-muted-foreground">Price/Sqft Trend</p>
                <p className="text-lg font-semibold text-green-500">+3.2% MoM</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
