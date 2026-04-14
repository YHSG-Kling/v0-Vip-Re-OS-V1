import { getListingById } from "@/app/actions/listings"
import { getListingMedia } from "@/app/actions/listing-media"
import { getOffersForListing } from "@/app/actions/seller-offers"
import { getListingShowings, getShowingFeedbackCards } from "@/app/actions/seller-showings"
import { getAIShowingInsights } from "@/app/actions/ai-showing-management"
import { createClient } from "@/lib/supabase/server"
import { ListingDetailTabs } from "@/components/listing/ListingDetailTabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, Share2, MoreVertical } from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  ListingCommandStrip,
  ListingLaunchReadiness,
  ListingMarketingStatus,
  ListingShowingIntelligence,
  ListingOfferPosture,
  ListingSellerCommunications,
  ListingMarketPosition,
  ListingWorkbenchRail,
} from "@/app/components/listing/command-center"
import { EmailCampaignPanel } from "@/app/components/email-campaign-panel"

interface ListingDetailPageProps {
  params: Promise<{
    listingId: string
  }>
}

export default async function ListingDetailPage({ params }: ListingDetailPageProps) {
  const { listingId } = await params
  const supabase = await createClient()

  // Fetch listing data with seller contact
  const result = await getListingById(listingId)

  if (!result.success || !result.listing) {
    notFound()
  }

  const listing = result.listing

  // Resolve current user role
  const { data: { user } } = await supabase.auth.getUser()
  let isSuperAdmin = false
  if (user) {
    const { data: userRow } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()
    isSuperAdmin = userRow?.role === "superadmin"
  }

  // Parallel fetch all real data
  const [
    mediaResult,
    offersResult,
    showingsResult,
    feedbackResult,
    documentsResult,
    sellerUpdatesResult,
    insightsResult,
    campaignsResult,
  ] = await Promise.all([
    getListingMedia(listingId),
    getOffersForListing(listingId),
    getListingShowings(listingId),
    getShowingFeedbackCards(listingId),
    supabase
      .from("transaction_documents")
      .select("id, doc_type, doc_label, status, file_url, uploaded_at")
      .eq("listing_id", listingId)
      .order("uploaded_at", { ascending: false }),
    supabase
      .from("seller_updates")
      .select("id, sent_at, message_body")
      .eq("listing_id", listingId)
      .order("sent_at", { ascending: false })
      .limit(5),
    getAIShowingInsights(listing.agent_id, {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      end: new Date().toISOString().split("T")[0],
    }),
    supabase
      .from("marketing_campaigns")
      .select("id, campaign_name, campaign_type, status, budget_total, budget_spent, created_at")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false })
      .limit(10),
  ])

  // Extract real data
  const photos = (mediaResult.data ?? [])
    .filter((m: any) => m.media_type === "photo")
    .map((m: any) => ({ id: m.id, url: m.file_url || m.thumbnail_url }))

  const offers = offersResult.offers ?? []
  const showings = showingsResult.showings ?? []
  const documents = (documentsResult.data ?? []).map((d: any) => ({
    id: d.id,
    name: d.doc_label || d.doc_type,
    type: d.doc_type,
    uploaded_at: d.uploaded_at,
  }))

  const emailCampaigns = (campaignsResult.data ?? []).map((c: any) => ({
    id: c.id,
    type: c.campaign_type ?? "general",
    recipients: c.budget_total ?? 0,
    status: c.status ?? "draft",
    sent_date: c.status === "live" || c.status === "ended" ? new Date(c.created_at).toLocaleDateString() : undefined,
    scheduled_date: c.status === "approved" || c.status === "pending_approval" ? new Date(c.created_at).toLocaleDateString() : undefined,
  }))

  const sellerUpdates = sellerUpdatesResult.data ?? []
  const lastUpdate = sellerUpdates[0]
  const daysSinceLastUpdate = lastUpdate
    ? Math.floor((Date.now() - new Date(lastUpdate.sent_at).getTime()) / (1000 * 60 * 60 * 24))
    : undefined

  // Build showing intelligence
  const feedbackCards = feedbackResult ?? []
  const upcomingShowings = showings.filter(
    (s: any) => new Date(s.scheduled_at) >= new Date() && s.status !== "cancelled"
  )
  const completedShowings = showings.filter(
    (s: any) => new Date(s.scheduled_at) < new Date() || s.status === "completed"
  )

  const insights = insightsResult.success ? (insightsResult as any).insights : null
  const feedbackTrends = insights
    ? {
        positivePatterns: insights.positivePatterns ?? [],
        objections: insights.objectionPatterns ?? [],
        pricingSignal: insights.pricingSignal,
      }
    : null

  // Build offer posture
  const activeOffers = offers.filter((o: any) => o.status === "pending" || o.status === "active")
  const bestOption = activeOffers.length > 0
    ? activeOffers.reduce((a: any, b: any) => (a.offer_price > b.offer_price ? a : b))
    : null
  const safestOption = activeOffers.find((o: any) => o.financing_type === "Cash") || bestOption

  // Build launch readiness items
  const readinessItems = [
    {
      id: "agreement",
      label: "Listing Agreement",
      status: listing.status !== "draft" ? "complete" : "incomplete",
      href: `/dashboard/listings/${listingId}/lifecycle`,
    },
    {
      id: "media",
      label: "Photos & Media",
      status: photos.length >= 5 ? "complete" : photos.length > 0 ? "warning" : "incomplete",
      href: `/dashboard/listings/${listingId}/media`,
      note: photos.length > 0 ? `${photos.length} photos` : "No photos uploaded",
    },
    {
      id: "description",
      label: "Property Description",
      status: listing.description ? "complete" : "incomplete",
    },
    {
      id: "pricing",
      label: "Pricing Set",
      status: listing.price ? "complete" : "incomplete",
    },
    {
      id: "marketing",
      label: "Marketing Tier",
      status: "incomplete",
      href: `/dashboard/listings/${listingId}/marketing-tier`,
    },
  ] as const

  // Build marketing assets
  const marketingAssets = [
    { type: "photos", status: photos.length >= 5 ? "live" : photos.length > 0 ? "ready" : "missing", label: "Photos" },
    { type: "video", status: "missing", label: "Video Tour" },
    { type: "mls", status: listing.mls_number ? "live" : "missing", label: "MLS" },
    { type: "flyer", status: "missing", label: "Flyer" },
    { type: "social", status: "missing", label: "Social Posts" },
    { type: "website", status: listing.status === "active" ? "live" : "ready", label: "Website" },
  ] as const

  // Compute AI priority
  const computePriority = () => {
    if (photos.length === 0) {
      return {
        action: "Fix Missing Media",
        reason: "Listings with photos get 10x more views. Add property photos to go live.",
        urgency: "critical" as const,
        ctaLabel: "Upload Photos",
        ctaHref: `/dashboard/listings/${listingId}/media`,
      }
    }
    if (activeOffers.length > 0) {
      return {
        action: "Review Offers",
        reason: `${activeOffers.length} active offer${activeOffers.length > 1 ? "s" : ""} awaiting response`,
        urgency: "high" as const,
        ctaLabel: "Review Offers",
        ctaHref: `/dashboard/listings/${listingId}/offers`,
      }
    }
    if (daysSinceLastUpdate !== undefined && daysSinceLastUpdate > 7) {
      return {
        action: "Send Seller Update",
        reason: `Last update was ${daysSinceLastUpdate} days ago. Keep your seller informed.`,
        urgency: "medium" as const,
        ctaLabel: "Send Update",
        ctaHref: `/dashboard/listings/${listingId}/seller-updates`,
      }
    }
    if (listing.status === "draft" || listing.status === "coming_soon") {
      return {
        action: "Launch Marketing",
        reason: "Your listing is ready to go live. Launch marketing to reach buyers.",
        urgency: "medium" as const,
        ctaLabel: "Launch Marketing",
        ctaHref: `/dashboard/listings/${listingId}/marketing-tier`,
      }
    }
    return {
      action: "Monitor Activity",
      reason: "Your listing is performing well. Keep an eye on showing feedback.",
      urgency: "low" as const,
      ctaLabel: "View Analytics",
      ctaHref: `/dashboard/listings/${listingId}`,
    }
  }

  const priority = computePriority()

  // Analytics from real data
  const analytics = {
    daysOnMarket: listing.created_at
      ? Math.floor((Date.now() - new Date(listing.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0,
    totalViews: 0,
    inquiries: showings.length,
    interestLevel: showings.length > 10 ? "High" : showings.length > 5 ? "Medium" : "Low",
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard/listings">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to Listings
                </Button>
              </Link>
              <div className="h-8 w-px bg-border" />
              <div>
                <h1 className="text-2xl font-bold text-foreground">{listing.address}</h1>
                <p className="text-sm text-muted-foreground">
                  {listing.city}, {listing.state} {listing.zip}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </Button>
              <Button variant="ghost" size="sm">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Command Center */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Command Strip - Above the fold */}
        <ListingCommandStrip listing={listing} priority={priority} />

        {/* Command Center Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          <ListingLaunchReadiness listingId={listingId} items={readinessItems as any} />
          <ListingMarketingStatus
            listingId={listingId}
            assets={marketingAssets as any}
            activeChannels={marketingAssets.filter((a) => a.status === "live").length}
            totalChannels={marketingAssets.length}
            isSuperAdmin={isSuperAdmin}
          />
          <ListingShowingIntelligence
            listingId={listingId}
            upcomingCount={upcomingShowings.length}
            totalShowings={completedShowings.length}
            feedbackTrends={feedbackTrends}
          />
          <ListingOfferPosture
            listingId={listingId}
            activeOffers={activeOffers}
            bestOption={bestOption}
            safestOption={safestOption}
            negotiationRecommended={activeOffers.length > 1}
          />
          <ListingSellerCommunications
            listingId={listingId}
            sellerId={listing.seller_contact?.id}
            lastUpdateSent={lastUpdate?.sent_at}
            nextUpdateReady={daysSinceLastUpdate !== undefined && daysSinceLastUpdate >= 7}
            daysSinceLastUpdate={daysSinceLastUpdate}
          />
          <ListingMarketPosition
            listingId={listingId}
            neighborhoodSummary={`${listing.city}, ${listing.state} market`}
            marketTrend="stable"
            competitorPressure="medium"
          />
          <div className="md:col-span-2">
            <EmailCampaignPanel transactionId={listingId} campaigns={emailCampaigns} />
          </div>
          <div className="md:col-span-2">
            <ListingWorkbenchRail
              listingId={listingId}
              agentId={listing.agent_id}
              sellerId={listing.seller_contact?.id}
              listing={listing}
            />
          </div>
        </div>

        {/* Listing Detail Tabs */}
        <div className="mt-8">
          <ListingDetailTabs
            listing={listing}
            offers={offers.map((o: any) => ({
              id: o.id,
              buyer_name: `Offer #${o.offer_number || o.id.slice(0, 6)}`,
              offer_price: o.offer_price,
              earnest_money: o.earnest_money_amount || o.earnest_money,
              financing_type: o.financing_type,
              close_date: o.closing_date,
              status: o.status,
            }))}
            photos={photos}
            documents={documents}
            showings={showings.map((s: any) => ({
              id: s.id,
              buyer_name: s.buyer_agent_name || "Buyer Agent",
              date: s.scheduled_date || s.scheduled_at?.split("T")[0],
              time: s.scheduled_time || new Date(s.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              duration: s.duration_minutes || 30,
              status: s.status,
            }))}
            analytics={analytics}
          />
        </div>
      </div>
    </div>
  )
}
