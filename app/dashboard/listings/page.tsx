import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MarketIntelligencePanel } from "./components/market-intelligence-panel"
import { 
  Plus, 
  Home, 
  DollarSign, 
  Clock, 
  TrendingUp,
  Eye,
  Share2,
  BarChart3,
  MapPin,
  Sparkles,
  ArrowRight,
} from "lucide-react"

export const dynamic = "force-dynamic"

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  active: { label: "Active", color: "text-green-700", bgColor: "bg-green-100" },
  pending: { label: "Pending", color: "text-amber-700", bgColor: "bg-amber-100" },
  under_contract: { label: "Under Contract", color: "text-blue-700", bgColor: "bg-blue-100" },
  sold: { label: "Sold", color: "text-purple-700", bgColor: "bg-purple-100" },
  expired: { label: "Expired", color: "text-red-700", bgColor: "bg-red-100" },
  withdrawn: { label: "Withdrawn", color: "text-gray-700", bgColor: "bg-gray-100" },
  coming_soon: { label: "Coming Soon", color: "text-purple-700", bgColor: "bg-purple-100" },
}

export default async function ListingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch listings with expanded data
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, state, price, status, lifecycle_stage, beds, baths, sqft, created_at, days_on_market, views_count")
    .eq("agent_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50)

  // Calculate stats
  const activeListings = listings?.filter(l => l.status === "active") || []
  const pendingListings = listings?.filter(l => l.status === "pending" || l.status === "under_contract") || []
  const comingSoonListings = listings?.filter(
    l => l.lifecycle_stage === "COMING_SOON_PREP" || l.lifecycle_stage === "COMING_SOON_ACTIVE"
  ) || []
  const totalVolume = activeListings.reduce((sum, l) => sum + (l.price || 0), 0)
  const avgDaysOnMarket = activeListings.length > 0 
    ? Math.round(activeListings.reduce((sum, l) => sum + (l.days_on_market || 0), 0) / activeListings.length)
    : 0

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/listings?action=new">
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            New Listing
          </Button>
        </Link>
        <Link href="/dashboard/listings/analytics">
          <Button variant="outline" size="sm" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Button>
        </Link>
        <Link href="/dashboard/listings/marketing">
          <Button variant="outline" size="sm" className="gap-2">
            <Share2 className="h-4 w-4" />
            Marketing Hub
          </Button>
        </Link>
        <div className="flex-1" />
        <Link href="/dashboard/listings/ai-pricing">
          <Button variant="ghost" size="sm" className="gap-2 text-primary">
            <Sparkles className="h-4 w-4" />
            AI Price Analysis
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Listing Command Center</h1>
          <p className="text-muted-foreground">Manage your property inventory and market performance</p>
        </div>

        {/* Status Radar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Listings</p>
                  <p className="text-2xl font-bold text-foreground">{activeListings.length}</p>
                </div>
                <Home className="h-8 w-8 text-green-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pending/Contract</p>
                  <p className="text-2xl font-bold text-foreground">{pendingListings.length}</p>
                </div>
                <Clock className="h-8 w-8 text-amber-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Volume</p>
                  <p className="text-2xl font-bold text-foreground">
                    ${(totalVolume / 1000000).toFixed(1)}M
                  </p>
                </div>
                <DollarSign className="h-8 w-8 text-blue-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-purple-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg Days on Market</p>
                  <p className="text-2xl font-bold text-foreground">{avgDaysOnMarket}</p>
                </div>
                <TrendingUp className="h-8 w-8 text-purple-500 opacity-50" />
              </div>
            </CardContent>
          </Card>

          {comingSoonListings.length > 0 && (
            <Card className="border-l-4 border-l-violet-500 md:col-span-4">
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-violet-500" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {comingSoonListings.length} listing{comingSoonListings.length !== 1 ? "s" : ""} in Coming Soon mode
                    </p>
                    <p className="text-xs text-muted-foreground">Building buyer anticipation before going active</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Listings Grid */}
        <Card>
          <CardHeader className="border-b border-border">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">My Listings</CardTitle>
              <Badge variant="secondary">{listings?.length || 0} total</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {listings && listings.length > 0 ? (
              <div className="divide-y divide-border">
                {listings.map((listing) => {
                    const isComingSoon =
                      listing.lifecycle_stage === "COMING_SOON_PREP" ||
                      listing.lifecycle_stage === "COMING_SOON_ACTIVE"
                    const statusConfig = isComingSoon
                      ? STATUS_CONFIG.coming_soon
                      : STATUS_CONFIG[listing.status] || STATUS_CONFIG.active
                    return (
                      <Link key={listing.id} href={isComingSoon ? `/dashboard/listings/${listing.id}/lifecycle` : `/listings/${listing.id}`}>
                      <div className="p-4 hover:bg-muted/50 transition-colors flex items-center gap-4">
                        <div className="flex-shrink-0 w-16 h-16 bg-muted rounded-lg flex items-center justify-center">
                          <Home className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-medium text-foreground truncate">{listing.address}</h3>
                            <Badge className={`${statusConfig.bgColor} ${statusConfig.color} text-xs flex items-center gap-1`}>
                              {isComingSoon && (
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
                                </span>
                              )}
                              {statusConfig.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            <span>{listing.city}, {listing.state}</span>
                            {listing.beds && <span className="ml-2">{listing.beds} bd</span>}
                            {listing.baths && <span>{listing.baths} ba</span>}
                            {listing.sqft && <span>{listing.sqft.toLocaleString()} sqft</span>}
                          </div>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <p className="text-lg font-bold text-foreground">
                            ${listing.price?.toLocaleString() || "N/A"}
                          </p>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {listing.views_count !== undefined && (
                              <span className="flex items-center gap-1">
                                <Eye className="h-3 w-3" />
                                {listing.views_count}
                              </span>
                            )}
                            {listing.days_on_market !== undefined && (
                              <span>{listing.days_on_market} DOM</span>
                            )}
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <div className="p-8 text-center">
                <Home className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground mb-4">No listings found. Create your first listing to get started.</p>
<Link href="/dashboard/listings?action=new">
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Listing
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Market Intelligence — city/state from first active listing, falls back to first any listing */}
        {(() => {
          const refListing = activeListings[0] ?? listings?.[0]
          if (!refListing?.city || !refListing?.state) return null
          return (
            <MarketIntelligencePanel
              city={refListing.city}
              state={refListing.state}
              agentId={user.id}
            />
          )
        })()}
      </div>
    </div>
  )
}
