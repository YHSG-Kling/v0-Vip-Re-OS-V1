import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { resolveSellerContext, getShowingStats, getRecentFeedback, getOfferSummary } from "@/lib/portal/resolve-seller-context"
import { getOpenHouseDashboard } from "@/app/actions/seller-open-house"
import { getSellerDocuments } from "@/app/actions/portal-seller"
import { resolvePersonaContext } from "@/lib/agents/persona-context"
import { buildListingMarketingChannels } from "@/lib/listings/marketing-channels"
import { FileText, Download, ExternalLink } from "lucide-react"
import {
  SellerJourneyMeaningCard,
  ListingActivityCard,
  SellerMarketingLiveCard,
  ShowingFeedbackSummaryCard,
  OfferPostureCard,
  NextStepCard,
  AgentUpdateVideoCard,
  EquityEstimateCard,
  SellerWeeklyReportCard,
  SellerTeamActivityCard,
  SellerMarketPulseCard,
} from "../components/seller-mode"
import { composeRenovationScenarios, RENOVATION_DISCLAIMER } from "@/lib/intelligence/renovation-simulator"
import { buildSellerTeamActivity, narrateSignalsForClient } from "@/lib/listings/seller-team-activity"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Home, ArrowLeft, MapPin, DollarSign, Calendar } from "lucide-react"

export default async function ListingPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify contact exists and get seller context
  const context = await resolveSellerContext(supabase, contactId)

  if (!context.listing) {
    redirect(`/portal/${contactId}`)
  }

  const listing = context.listing

  // Seller access verification: ensure this contact is the seller_contact_id.
  // Also pull the REAL signals the marketing card grounds its channel statuses in (the MLS number +
  // the public slug) instead of inferring "live" from listing.status.
  const { data: listingOwnerCheck } = await supabase
    .from("listings")
    .select("contact_id, seller_contact_id, mls_number, slug")
    .eq("id", listing.id)
    .single()

  // Verify seller identity (contact_id or seller_contact_id must match)
  const isVerifiedSeller =
    listingOwnerCheck?.contact_id === contactId ||
    listingOwnerCheck?.seller_contact_id === contactId

  if (!isVerifiedSeller) {
    redirect(`/portal/${contactId}?error=unauthorized`)
  }

  // Resolve the seller's self-disclosed persona so the status copy softens to an empathy-forward
  // register for sensitive contexts (probate / divorce / foreclosure / major transition).
  const { data: personaRow } = await supabase
    .from("contacts").select("contact_persona").eq("id", contactId).maybeSingle()
  const sellerPersona = resolvePersonaContext(
    (personaRow as { contact_persona: string | null } | null)?.contact_persona ?? null, "seller",
  )

  // Parallel data fetches for listing details
  const [
    showingStats,
    recentFeedback,
    offerSummary,
    openHouseData,
    metricsResult,
    mediaResult,
    socialPostsResult,
    agentResult,
    nextMilestoneResult,
    updatesResult,
    documentsResult,
  ] = await Promise.all([
    // Showing statistics
    getShowingStats(supabase, listing.id),
    // Recent feedback
    getRecentFeedback(supabase, listing.id, 10),
    // Offer summary
    getOfferSummary(supabase, listing.id),
    // Open house data
    getOpenHouseDashboard(listing.id),
    // Listing metrics
    supabase
      .from("listing_metrics")
      .select("total_views:views, showing_count:showings, inquiry_count:inquiries, favorite_count:saves")
      .eq("listing_id", listing.id)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Media count
    supabase
      .from("listing_media")
      .select("id", { count: "exact" })
      .eq("listing_id", listing.id)
      .eq("media_type", "photo"),
    // Social posts / marketing
    supabase
      .from("social_posts")
      .select("id, platform, status, published_at")
      .eq("listing_id", listing.id)
      .eq("status", "published"),
    // Agent info
    context.agentId
      ? supabase
          .from("agents")
          .select("id, users(first_name, last_name)")
          .eq("id", context.agentId)
          .single()
      : Promise.resolve({ data: null }),
    // Next milestone if under contract
    context.transactionId
      ? supabase
          .from("transaction_milestones")
          .select("milestone_name, target_date, status")
          .eq("transaction_id", context.transactionId)
          .neq("status", "completed")
          .order("target_date", { ascending: true })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Latest seller update
    supabase
      .from("seller_updates")
      .select("id, subject, body, video_url, thumbnail_url, created_at")
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Seller documents
    getSellerDocuments(contactId, context.transactionId ?? null),
  ])

  // Seller documents — merge client_documents + transaction_documents
  const sellerDocs = [
    ...(documentsResult?.clientDocuments ?? []),
    ...(documentsResult?.transactionDocuments ?? []),
  ]

  // Compute metrics
  const metrics = metricsResult.data ?? { total_views: 0, showing_count: 0, inquiry_count: 0, favorite_count: 0 }
  const photoCount = mediaResult.count ?? 0
  const socialPosts = socialPostsResult.data ?? []
  const agent = agentResult.data
  const agentName = agent
    ? [(agent.users as any)?.first_name, (agent.users as any)?.last_name].filter(Boolean).join(" ") || null
    : null
  const nextMilestone = nextMilestoneResult.data
  const latestUpdate = updatesResult.data

  // Calculate days on market
  const listingDate = listing.listing_date ? new Date(listing.listing_date) : null
  const daysOnMarket = listingDate
    ? Math.floor((Date.now() - listingDate.getTime()) / (1000 * 60 * 60 * 24))
    : null

  // Marketing channels — statuses grounded ONLY in verifiable signals (a real MLS number, a hosted
  // slug, published posts, active campaigns), never inferred from listing.status. See marketing-channels.ts.
  const { count: activeCampaignCount } = await supabase
    .from("marketing_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listing.id)
    .eq("status", "active")
  // The seller's weekly digest (seller_weekly_reports, written by runSellerWeeklyReports). Latest week.
  const { data: weeklyReportRow } = await supabase
    .from("seller_weekly_reports")
    .select("report_content")
    .eq("listing_id", listing.id)
    .order("report_week_start", { ascending: false })
    .limit(1)
    .maybeSingle()
  const weeklyReport = (weeklyReportRow?.report_content as Record<string, unknown> | null) ?? null

  // National "Market Pulse" — what buyers are prioritizing now (market_pulse, written weekly).
  const { data: pulseRow } = await supabase
    .from("market_pulse")
    .select("insights")
    .eq("scope", "national")
    .order("pulse_week", { ascending: false })
    .limit(1)
    .maybeSingle()
  const marketPulse = (pulseRow?.insights as Record<string, unknown> | null) ?? null

  const marketingChannels = buildListingMarketingChannels({
    mlsNumber: (listingOwnerCheck?.mls_number as string | null) ?? null,
    listingSlug: (listingOwnerCheck?.slug as string | null) ?? null,
    instagramLive: socialPosts.some((p) => p.platform === "instagram"),
    facebookLive: socialPosts.some((p) => p.platform === "facebook"),
    activeCampaignCount: activeCampaignCount ?? 0,
  })

  // "Your AI Team" — the named managers working this sale, grounded in real activity (D7 differentiator).
  const { count: videosDelivered } = await supabase
    .from("ai_video_projects")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("status", "completed")
  const sellerTeam = buildSellerTeamActivity({
    listingLive: listing.status === "active" || (listing as any).lifecycle_stage === "MLS_ACTIVE",
    marketingChannelsLive: marketingChannels.filter((c) => c.status === "live").length,
    showingsTotal: showingStats.total,
    videosDelivered: videosDelivered ?? 0,
    offersCount: offerSummary.total,
  })
  // This-month team timeline — WHITELIST-narrated manager handoffs for this
  // listing (client-safe copy is fixed in the narrator; raw bus text never shown).
  const { data: teamSignals } = await supabase
    .from("manager_signals")
    .select("signal_type, created_at")
    .eq("entity_type", "listing").eq("entity_id", listing.id)
    .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(50)
  const sellerTeamTimeline = narrateSignalsForClient((teamSignals ?? []) as any[])

  // Build feedback summary
  const feedbackSummary = {
    positivePatterns: extractPositivePatterns(recentFeedback),
    commonConcerns: extractConcerns(recentFeedback),
    pricingSignal: derivePricingSignal(recentFeedback),
    averageRating: calculateAverageRating(recentFeedback),
    totalFeedback: recentFeedback.length,
  }

  // Open house visibility
  const upcomingOpenHouse = openHouseData?.events?.find((e: any) => new Date(e.event_date) > new Date())

  // Under contract check
  const isUnderContract = listing.status === "pending" || listing.status === "under_contract"

  // Transaction close date
  const { data: transaction } = context.transactionId
    ? await supabase
        .from("transactions")
        .select("close_date")
        .eq("id", context.transactionId)
        .single()
    : { data: null }

  // Seller EQUITY & NET-PROCEEDS inputs — the estimated value is sourced from the MOST ACCURATE
  // valuation available, in order: a comps-adjusted CMA (runAiCma → cma_reports.recommended_price,
  // built on comparable sales + STATE appraiser adjustment guidelines) → the marketed list price →
  // the AVM estimate on file. The mortgage balance is the seller's OWN figure (contacts.metadata),
  // never fabricated. The card recomputes live and persists the balance.
  const [{ data: sellerContactRow }, { data: cmaRow }] = await Promise.all([
    supabase.from("contacts").select("metadata, home_value_estimate, engagement_score").eq("id", contactId).maybeSingle(),
    supabase.from("cma_reports")
      .select("recommended_price, comparable_count, status")
      .eq("listing_id", listing.id).not("recommended_price", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  const sellerMeta: Record<string, any> = (() => {
    const m = (sellerContactRow as any)?.metadata
    if (!m) return {}
    if (typeof m === "string") { try { return JSON.parse(m) } catch { return {} } }
    return m
  })()
  const cma = cmaRow as { recommended_price: number | null; comparable_count: number | null } | null
  const cmaValue = cma?.recommended_price ?? null
  const equityEstimatedValue =
    cmaValue ?? (listing.list_price as number | null) ?? ((sellerContactRow as any)?.home_value_estimate as number | null) ?? null
  // Transparency: tell the seller WHERE the value came from (comps-adjusted CMA is the gold standard).
  const equityValuationNote = cmaValue
    ? `Based on a comps-adjusted CMA${cma?.comparable_count ? ` of ${cma.comparable_count} comparable sales` : ""} (state appraiser guidelines applied)`
    : (listing.list_price ? "Based on your current list price" : "Based on your latest home-value estimate")
  const equityMortgageBalance = typeof sellerMeta?.mortgage_balance === "number" ? sellerMeta.mortgage_balance : null

  // MOVE-READINESS — where the seller stands at a glance. Equity ratio from their own balance (when
  // known); engagement from contacts.engagement_score; market timing left to the agent (null → the
  // engine weights over the signals we actually have, never fabricating). PURE.
  const { computeMoveReadiness } = await import("@/lib/seller-equity/move-readiness")
  const mrEquityRatio = equityEstimatedValue && equityMortgageBalance != null && equityEstimatedValue > 0
    ? Math.max(0, Math.min(1, (equityEstimatedValue - equityMortgageBalance) / equityEstimatedValue))
    : null
  const mrEngagement = typeof (sellerContactRow as any)?.engagement_score === "number"
    ? Math.max(0, Math.min(1, (sellerContactRow as any).engagement_score / 100))
    : null
  const moveReadiness = (mrEquityRatio !== null || mrEngagement !== null)
    ? computeMoveReadiness({ equityRatio: mrEquityRatio, marketTightness: null, engagement: mrEngagement })
    : null

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-gradient-to-br from-emerald-700 via-teal-700 to-emerald-800 text-white px-6 pt-6 pb-10">
        <div className="max-w-2xl mx-auto">
          <Link href={`/portal/${contactId}`} className="inline-flex items-center gap-1 text-emerald-200 hover:text-white text-sm mb-4">
            <ArrowLeft className="h-4 w-4" />
            Back to Portal
          </Link>
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
              <Home className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">{listing.address || listing.property_address}</h1>
              <p className="text-emerald-200 text-sm flex items-center gap-1 mt-0.5">
                <MapPin className="h-3.5 w-3.5" />
                {listing.city}, {listing.state}
              </p>
              {listing.list_price && (
                <p className="text-lg font-semibold mt-1 flex items-center gap-1">
                  <DollarSign className="h-4 w-4" />
                  {listing.list_price.toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-2xl mx-auto px-4 -mt-4 pb-12 space-y-5">
        {/* Journey Meaning Card */}
        <SellerJourneyMeaningCard
          listingStatus={listing.status}
          offerCount={offerSummary.total}
          showingCount={showingStats.total}
          daysOnMarket={daysOnMarket}
          agentName={agentName}
          sensitive={sellerPersona.sensitive}
        />

        {/* Your AI Team — the named managers working this sale (the "team, not a CRM" differentiator) */}
        <SellerTeamActivityCard team={sellerTeam} timeline={sellerTeamTimeline} />

        {/* Weekly digest — this week's real activity, client-safe */}
        <SellerWeeklyReportCard report={weeklyReport as any} />

        {/* Market Pulse — what buyers are prioritizing now (the novel buyer-sentiment differentiator) */}
        <SellerMarketPulseCard pulse={marketPulse as any} />

        {/* Open House Alert if upcoming */}
        {upcomingOpenHouse && (
          <Card className="border-purple-200 bg-purple-50">
            <CardContent className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-purple-900">Open House Scheduled</p>
                <p className="text-xs text-purple-700">
                  {new Date(upcomingOpenHouse.event_date).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                  {upcomingOpenHouse.start_time && ` at ${upcomingOpenHouse.start_time}`}
                </p>
              </div>
              <Badge className="bg-purple-600 text-white">Upcoming</Badge>
            </CardContent>
          </Card>
        )}

        {/* Next Step Card */}
        <NextStepCard
          listingStatus={listing.status}
          hasOffers={offerSummary.total > 0}
          isUnderContract={isUnderContract}
          nextMilestone={nextMilestone ? { name: nextMilestone.milestone_name, date: nextMilestone.target_date, status: nextMilestone.status } : null}
          closeDate={transaction?.close_date}
        />

        {/* Two Column Grid */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* Listing Activity */}
          <ListingActivityCard
            contactId={contactId}
            listingStatus={listing.status}
            showingsThisWeek={showingStats.thisWeek}
            totalShowings={showingStats.total}
            totalViews={metrics.total_views}
            photoCount={photoCount}
            isPublished={listing.status === "active"}
            launchDate={listing.listing_date}
          />

          {/* Marketing Live */}
          <SellerMarketingLiveCard
            channels={marketingChannels}
            marketingTier={null}
            // No fabricated reach — we don't have a verified per-listing reach number, so we don't
            // invent one (the old `views * 10` heuristic showed sellers a made-up figure).
            totalReach={undefined}
          />
        </div>

        {/* Offer Posture */}
        <OfferPostureCard
          contactId={contactId}
          totalOffers={offerSummary.total}
          pendingOffers={offerSummary.pending}
          highestOffer={offerSummary.highest}
          listPrice={listing.list_price}
          hasAcceptedOffer={!!offerSummary.accepted}
          needsAction={offerSummary.pending > 0}
        />

        {/* Equity & Net Proceeds — what the seller actually walks away with (their #1 question) */}
        {equityEstimatedValue && equityEstimatedValue > 0 && (
          <EquityEstimateCard
            contactId={contactId}
            estimatedValue={equityEstimatedValue}
            initialMortgageBalance={equityMortgageBalance}
            valuationNote={equityValuationNote}
            moveReadiness={moveReadiness}
          />
        )}

        {/* Renovation Outcome Simulator — honest industry ranges scaled to THIS
            home (typical ranges, never a promise; the agent brings real quotes). */}
        {equityEstimatedValue && equityEstimatedValue > 0 && (() => {
          const scenarios = composeRenovationScenarios(equityEstimatedValue).slice(0, 3)
          if (scenarios.length === 0) return null
          const usd = (n: number) => `$${n.toLocaleString("en-US")}`
          return (
            <div className="rounded-lg border bg-card p-6 space-y-3">
              <h2 className="text-lg font-semibold">Thinking about small improvements before you sell?</h2>
              <ul className="space-y-3">
                {scenarios.map((s) => (
                  <li key={s.key} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        typically {usd(s.costRange[0])}–{usd(s.costRange[1])} → often worth {usd(s.effectRange[0])}–{usd(s.effectRange[1])} at sale
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{s.note}</p>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{RENOVATION_DISCLAIMER}</p>
            </div>
          )
        })()}

        {/* Showing Feedback Summary */}
        <ShowingFeedbackSummaryCard
          contactId={contactId}
          summary={feedbackSummary}
        />

        {/* Agent Update Video */}
        <AgentUpdateVideoCard
          contactId={contactId}
          latestUpdate={latestUpdate ? {
            id: latestUpdate.id,
            title: latestUpdate.subject || "Weekly Update",
            videoUrl: latestUpdate.video_url,
            thumbnailUrl: latestUpdate.thumbnail_url,
            createdAt: latestUpdate.created_at,
            summary: latestUpdate.body?.substring(0, 200),
          } : null}
          agentName={agentName}
        />

        {/* Documents */}
        {sellerDocs.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Your Documents
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {sellerDocs.map((doc: any, i: number) => {
                const label = doc.document_type
                  ? doc.document_type.replace(/_/g, " ")
                  : doc.doc_type
                  ? doc.doc_type.replace(/_/g, " ")
                  : doc.file_name ?? "Document"
                const url = doc.file_url ?? doc.storage_url ?? null
                const status = doc.status ?? null
                return (
                  <div
                    key={doc.id ?? i}
                    className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <p className="text-sm capitalize truncate">{label}</p>
                      {status && status !== "active" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border capitalize shrink-0">
                          {status}
                        </span>
                      )}
                    </div>
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-primary hover:text-primary/80"
                        aria-label={`Open ${label}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )}

        {/* Quick Actions */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap gap-3 justify-center">
              <Button variant="outline" asChild>
                <Link href={`/portal/${contactId}/showings`}>
                  <Calendar className="h-4 w-4 mr-2" />
                  View Showings
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/portal/${contactId}/offers`}>
                  <DollarSign className="h-4 w-4 mr-2" />
                  View Offers
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/portal/${contactId}/messages`}>
                  Message Agent
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// Helper functions for feedback analysis
function extractPositivePatterns(feedback: any[]): string[] {
  const patterns: string[] = []
  const patternCounts: Record<string, number> = {}

  for (const fb of feedback) {
    if (fb.buyer_favorite_features) {
      const features = fb.buyer_favorite_features.split(",").map((f: string) => f.trim())
      for (const feature of features) {
        patternCounts[feature] = (patternCounts[feature] || 0) + 1
      }
    }
    if (fb.overall_impression === "loved_it" || fb.overall_impression === "liked_it") {
      if (fb.presentation_rating >= 4) patternCounts["Great presentation"] = (patternCounts["Great presentation"] || 0) + 1
      if (fb.cleanliness_rating >= 4) patternCounts["Clean & well-maintained"] = (patternCounts["Clean & well-maintained"] || 0) + 1
    }
  }

  return Object.entries(patternCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([pattern]) => pattern)
}

function extractConcerns(feedback: any[]): string[] {
  const concerns: string[] = []
  const concernCounts: Record<string, number> = {}

  for (const fb of feedback) {
    if (fb.specific_concerns) {
      concernCounts[fb.specific_concerns] = (concernCounts[fb.specific_concerns] || 0) + 1
    }
    if (fb.price_opinion === "too_high") {
      concernCounts["Price perception"] = (concernCounts["Price perception"] || 0) + 1
    }
  }

  return Object.entries(concernCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([concern]) => concern)
}

function derivePricingSignal(feedback: any[]): "priced_right" | "too_high" | "good_value" | null {
  if (feedback.length === 0) return null

  const opinions = feedback
    .filter(fb => fb.price_opinion)
    .map(fb => fb.price_opinion)

  if (opinions.length === 0) return null

  const counts = {
    priced_right: opinions.filter(o => o === "priced_right").length,
    too_high: opinions.filter(o => o === "too_high").length,
    good_value: opinions.filter(o => o === "good_value").length,
  }

  const max = Math.max(counts.priced_right, counts.too_high, counts.good_value)
  if (counts.priced_right === max) return "priced_right"
  if (counts.too_high === max) return "too_high"
  if (counts.good_value === max) return "good_value"

  return null
}

function calculateAverageRating(feedback: any[]): number | null {
  const ratings = feedback
    .filter(fb => fb.sentiment_score !== null)
    .map(fb => fb.sentiment_score)

  if (ratings.length === 0) return null

  return ratings.reduce((sum, r) => sum + r, 0) / ratings.length
}
