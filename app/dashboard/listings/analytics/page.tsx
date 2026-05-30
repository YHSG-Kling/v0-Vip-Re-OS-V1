import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, TrendingUp, Eye, Clock, DollarSign, BarChart3 } from "lucide-react"
import Link from "next/link"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

export const dynamic = "force-dynamic"

export default async function ListingsAnalyticsPage() {
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

  // Get listing analytics data. DOM is computed from go_live_date — the
  // `days_on_market` column does not exist on listings.
  const { data: listings } = await service
    .from("listings")
    .select("id, status, list_price, go_live_date, views_count, created_at")
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(50)

  const activeListings = listings?.filter(l => l.status === "active") || []
  const totalViews = listings?.reduce((sum, l) => sum + (l.views_count || 0), 0) || 0
  const activeDoms = activeListings
    .map(l => computeDaysOnMarket(l.go_live_date))
    .filter((d): d is number => typeof d === "number" && d >= 0)
  const avgDaysOnMarket = activeDoms.length > 0
    ? Math.round(activeDoms.reduce((sum, d) => sum + d, 0) / activeDoms.length)
    : 0
  const totalVolume = activeListings.reduce((sum, l) => sum + (l.list_price || 0), 0)

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
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Listing Analytics</h1>
          <p className="text-muted-foreground">Performance metrics for your active listings</p>
        </div>

        {/* Stats Radar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <BarChart3 className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{activeListings.length}</p>
                  <p className="text-xs text-muted-foreground">Active Listings</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Eye className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{totalViews.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Total Views</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{avgDaysOnMarket}</p>
                  <p className="text-xs text-muted-foreground">Avg Days on Market</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <DollarSign className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">${(totalVolume / 1000000).toFixed(1)}M</p>
                  <p className="text-xs text-muted-foreground">Total Volume</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Listings Performance Table */}
        <Card>
          <CardHeader>
            <CardTitle>Listing Performance</CardTitle>
            <CardDescription>Views and engagement by listing</CardDescription>
          </CardHeader>
          <CardContent>
            {listings && listings.length > 0 ? (
              <div className="space-y-3">
                {listings.slice(0, 10).map((listing) => (
                  <div key={listing.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${
                        listing.status === "active" ? "bg-green-500" : 
                        listing.status === "pending" ? "bg-amber-500" : "bg-muted"
                      }`} />
                      <div>
                        <p className="font-medium text-sm">Listing #{listing.id.slice(0, 8)}</p>
                        <p className="text-xs text-muted-foreground capitalize">{listing.status}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm">
                      <div className="text-right">
                        <p className="font-medium">{listing.views_count || 0}</p>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{computeDaysOnMarket(listing.go_live_date) ?? 0}</p>
                        <p className="text-xs text-muted-foreground">Days</p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">${((listing.list_price || 0) / 1000).toFixed(0)}K</p>
                        <p className="text-xs text-muted-foreground">Price</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No listings to analyze yet</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
