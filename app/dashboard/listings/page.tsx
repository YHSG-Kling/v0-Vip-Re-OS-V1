import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MarketIntelligencePanel } from "@/app/components/dashboard/listings/market-intelligence-panel"
import { CmaHistorySheet } from "@/app/components/dashboard/listings/cma-history-sheet"
import { ListingCreateSheet } from "@/app/components/dashboard/listings/listing-create-sheet"
import { ListingStatusSelect } from "@/app/components/dashboard/listings/listing-status-select"
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

export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
    contactId?: string
  }>
}) {
  const resolvedSearchParams = await searchParams
  const showCreateSheet = resolvedSearchParams?.action === "new"

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Load agent record + user profile for sheet pre-fill (agent_id = agents.id, not users.id)
  const [{ data: agentRecord }, { data: userProfile }] = await Promise.all([
    supabase.from("agents").select("id").eq("user_id", user.id).maybeSingle(),
    supabase.from("users").select("first_name, last_name, brokerage_id").eq("id", user.id).maybeSingle(),
  ])

  // Build query — if no agent record found, fall back to user.id for brokers/admins
  const agentId = agentRecord?.id ?? user.id
  const brokerageId = userProfile?.brokerage_id ?? ""
  const agentName = [userProfile?.first_name, userProfile?.last_name].filter(Boolean).join(" ")
  const agentEmail = user.email ?? ""

  // Contact prefill values passed from CRM quick-action links
  const prefillContact = showCreateSheet ? {
    firstName:   resolvedSearchParams?.firstName  ?? "",
    lastName:    resolvedSearchParams?.lastName   ?? "",
    email:       resolvedSearchParams?.email      ?? "",
    phone:       resolvedSearchParams?.phone      ?? "",
    contactId:   resolvedSearchParams?.contactId  ?? "",
    agentUserId: user.id,
    agentName,
    agentEmail,
    brokerageId,
  } : undefined

  // Fetch listings with correct schema columns
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, city, state, list_price, status, lifecycle_stage, bedrooms, bathrooms, sqft, created_at, stage_updated_at, showing_count")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(50)

  // Fetch pending offer counts per listing (for badge)
  const listingIds = listings?.map(l => l.id) ?? []
  const { data: offerCounts } = listingIds.length > 0
    ? await supabase
        .from("offers")
        .select("listing_id")
        .in("listing_id", listingIds)
        .in("status", ["submitted", "pending", "received"])
    : { data: [] }

  const offerCountByListing: Record<string, number> = {}
  for (const offer of offerCounts ?? []) {
    offerCountByListing[offer.listing_id] = (offerCountByListing[offer.listing_id] ?? 0) + 1
  }

  // Calculate stats
  const activeListings = listings?.filter(l => l.status === "active") || []
  const pendingListings = listings?.filter(l => l.status === "pending" || l.status === "under_contract") || []
  const comingSoonListings = listings?.filter(
    l => l.lifecycle_stage === "COMING_SOON_PREP" || l.lifecycle_stage === "COMING_SOON_ACTIVE"
  ) || []
  const totalVolume = activeListings.reduce((sum, l) => sum + (l.list_price || 0), 0)
  // Derive DOM from stage_updated_at as a proxy (no days_on_market column)
  const avgDaysOnMarket = activeListings.length > 0
    ? Math.round(
        activeListings.reduce((sum, l) => {
          const entered = l.stage_updated_at ? new Date(l.stage_updated_at) : null
          const dom = entered ? Math.floor((Date.now() - entered.getTime()) / 86_400_000) : 0
          return sum + dom
        }, 0) / activeListings.length
      )
    : 0

  return (
    <div className="space-y-6">
      {/* Command Strip — wraps cleanly on mobile */}
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/listings?action=new">
          <Button size="sm" className="gap-2 min-h-[44px] sm:min-h-0">
            <Plus className="h-4 w-4" />
            New Listing
          </Button>
        </Link>
        <Link href="/dashboard/listings/analytics">
          <Button variant="outline" size="sm" className="gap-2 min-h-[44px] sm:min-h-0">
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Button>
        </Link>
        <Link href="/dashboard/listings/marketing">
          <Button variant="outline" size="sm" className="gap-2 min-h-[44px] sm:min-h-0">
            <Share2 className="h-4 w-4" />
            Marketing Hub
          </Button>
        </Link>
        <div className="flex-1 hidden sm:block" />
        <Link href="/dashboard/listings/ai-pricing">
          <Button variant="ghost" size="sm" className="gap-2 text-primary min-h-[44px] sm:min-h-0">
            <Sparkles className="h-4 w-4" />
            AI Price Analysis
          </Button>
        </Link>
      </div>

      <div className="px-4 sm:px-6 space-y-6">
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
                    {totalVolume >= 1_000_000
                      ? `$${(totalVolume / 1_000_000).toFixed(1)}M`
                      : totalVolume >= 1_000
                      ? `$${(totalVolume / 1_000).toFixed(0)}K`
                      : totalVolume > 0 ? `$${totalVolume.toLocaleString()}` : "—"}
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
              <div>
                {listings.map((listing) => {
                    const isComingSoon =
                      listing.lifecycle_stage === "COMING_SOON_PREP" ||
                      listing.lifecycle_stage === "COMING_SOON_ACTIVE"
                    const statusConfig = isComingSoon
                      ? STATUS_CONFIG.coming_soon
                      : STATUS_CONFIG[listing.status] || STATUS_CONFIG.active
                    const pendingOffers = offerCountByListing[listing.id] ?? 0
                    const dom = listing.stage_updated_at
                      ? Math.floor((Date.now() - new Date(listing.stage_updated_at).getTime()) / 86_400_000)
                      : null
                    return (
                      <div key={listing.id} className="flex items-stretch border-b last:border-b-0 border-border hover:bg-muted/50 transition-colors">
                        <Link
                          href={`/dashboard/listings/${listing.id}/lifecycle`}
                          className="flex-1 p-4 flex items-center gap-4 min-w-0"
                        >
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
                              {/* Offer received badge */}
                              {pendingOffers > 0 && (
                                <Badge className="bg-blue-100 text-blue-700 text-xs">
                                  {pendingOffers} Offer{pendingOffers !== 1 ? "s" : ""}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                              <MapPin className="h-3 w-3" />
                              <span>{listing.city}, {listing.state}</span>
                              {listing.bedrooms && <span className="ml-2">{listing.bedrooms} bd</span>}
                              {listing.bathrooms && <span>{listing.bathrooms} ba</span>}
                              {listing.sqft && <span>{listing.sqft.toLocaleString()} sqft</span>}
                            </div>
                          </div>
                          <div className="flex-shrink-0 text-right">
                            <p className="text-lg font-bold text-foreground">
                              ${listing.list_price?.toLocaleString() || "N/A"}
                            </p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                              {listing.showing_count != null && listing.showing_count > 0 && (
                                <span className="flex items-center gap-1">
                                  <Eye className="h-3 w-3" />
                                  {listing.showing_count} showings
                                </span>
                              )}
                              {dom != null && (
                                <span>{dom} DOM</span>
                              )}
                            </div>
                          </div>
                          <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        </Link>
                        <div className="flex items-center gap-1 pr-3">
                          <ListingStatusSelect
                            listingId={listing.id}
                            currentStatus={listing.status}
                          />
                          <CmaHistorySheet
                            listingId={listing.id}
                            agentId={agentId}
                            listingAddress={listing.address}
                          />
                        </div>
                      </div>
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
              agentId={agentId}
            />
          )
        })()}
      </div>

      {/* Listing create sheet — opened by ?action=new, optionally prefilled from CRM */}
      <ListingCreateSheet open={showCreateSheet} prefillContact={prefillContact as any} />
    </div>
  )
}
