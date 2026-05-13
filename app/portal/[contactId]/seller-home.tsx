// app/portal/[contactId]/seller-home.tsx
// Seller portal home page component with all 11 modules.

import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { CLIENT_VISIBLE_MILESTONES } from "@/lib/transactions/transaction-stages"
import { SELLER_MILESTONE_LABELS } from "@/lib/portal/resolve-education-context"
import {
  resolveSellerContext,
  getShowingStats,
  getRecentFeedback,
  getOfferSummary,
} from "@/lib/portal/resolve-seller-context"
import {
  getMarketPosition,
  getSellerVendors,
  getShowingInsights,
} from "@/app/actions/portal-seller"
import { SellerPortalViewTracker } from "./components/seller-mode/SellerPortalViewTracker"
import { RecentUpdatesFeed } from "./components/RecentUpdatesFeed"
import { ShareMyHomeCard } from "./components/seller-mode/ShareMyHomeCard"
import { ListingStatsCard } from "@/app/components/portal/ListingStatsCard"
import { ShowingActivityStrip, ShowingFeedbackCard } from "@/app/components/portal/ShowingsFeedCard"
import { SellerOfferCard } from "@/app/components/portal/SellerOfferCard"
import { MarketPositionCard } from "@/app/components/portal/MarketPositionCard"
import { MilestoneProgressBar } from "@/app/components/portal/MilestoneProgressBar"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { ContactVendorToolkitCard } from "@/app/components/portal/ContactVendorToolkitCard"
import { CustomerWelcomePanel } from "@/app/components/portal/customer-welcome-panel"
import { NegotiationMirrorPanel } from "@/app/components/negotiation/negotiation-mirror-panel"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Briefcase,
  Clock,
  Eye,
  FileText,
  MessageSquare,
  Minus,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react"

// ─── SELLER STAGE MEANING ─────────────────────────────────────────────────────

const SELLER_STAGE_MEANING: Record<
  string,
  { headline: string; whatMeans: string; whatNext: string; responsible: string }
> = {
  pre_listing: {
    headline: "Getting Your Home Ready",
    whatMeans:
      "Your agent is preparing everything needed to bring your home to market.",
    whatNext:
      "Media capture, pricing review, and launch preparations are underway.",
    responsible: "Your Agent",
  },
  active: {
    headline: "Your Home Is Live",
    whatMeans:
      "Your listing is active and buyers are seeing it. Showings may be requested soon.",
    whatNext:
      "Your agent will send updates after showings and when offers arrive.",
    responsible: "Your Agent + Market",
  },
  pending: {
    headline: "You Have an Accepted Offer!",
    whatMeans:
      "A buyer's offer has been accepted. Now comes inspections, appraisals, and closing prep.",
    whatNext:
      "Your agent and the transaction team are working through the contract milestones.",
    responsible: "Your Agent + Transaction Team",
  },
  under_contract: {
    headline: "You Have an Accepted Offer!",
    whatMeans:
      "A buyer's offer has been accepted. Now comes inspections, appraisals, and closing prep.",
    whatNext:
      "Your agent and the transaction team are working through the contract milestones.",
    responsible: "Your Agent + Transaction Team",
  },
  closed: {
    headline: "Congratulations — Sold!",
    whatMeans:
      "The sale is complete. Your proceeds have been distributed per the closing statement.",
    whatNext:
      "Your agent will follow up. You're now a valued lifetime customer.",
    responsible: "Completed",
  },
}

interface SellerHomeProps {
  contactId: string
}

export default async function SellerHome({ contactId }: SellerHomeProps) {
  const supabase = await createClient()

  // Get base seller context
  const context = await resolveSellerContext(supabase, contactId)

  // Fetch richer insight data — only when a listing exists, errors silently swallowed
  let showingInsights: Awaited<ReturnType<typeof getShowingInsights>> | null = null

  if (context.listing) {
    showingInsights = await getShowingInsights(contactId).catch(() => null)
  }

  // Parallel data fetches
  const [
    showingStats,
    recentFeedback,
    offerSummary,
    marketPosition,
    vendorData,
    milestonesResult,
    dealTeamResult,
    agentResult,
    messagesResult,
    educationResult,
    recentUpdatesResult,
  ] = await Promise.all([
    // Showing stats
    context.listing
      ? getShowingStats(supabase, context.listing.id)
      : Promise.resolve({ thisWeek: 0, total: 0, avgRating: null }),
    // Recent feedback
    context.listing
      ? getRecentFeedback(supabase, context.listing.id, 3)
      : Promise.resolve([]),
    // Offer summary
    context.listing
      ? getOfferSummary(supabase, context.listing.id)
      : Promise.resolve({ total: 0, highest: null, accepted: null, pending: 0 }),
    // Market position
    getMarketPosition(contactId),
    // Vendors
    getSellerVendors(contactId, context.transactionId),
    // Milestones
    context.transactionId
      ? supabase
          .from("transaction_milestones")
          .select("id, milestone_name, milestone_type, target_date, completed_at, status, is_client_visible")
          .eq("transaction_id", context.transactionId)
          .order("target_date", { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] }),
    // Deal team members
    context.transactionId
      ? supabase
          .from("deal_team_members")
          .select("id, member_type, agent_id, external_name, external_company, external_phone, external_email, scheduled_date, agent:agents(id, first_name, last_name, phone, email, profile_photo_url)")
          .eq("transaction_id", context.transactionId)
      : Promise.resolve({ data: [] }),
    // Primary agent
    context.agentId
      ? supabase
          .from("agents")
          .select("id, first_name, last_name, phone, email, profile_photo_url")
          .eq("id", context.agentId)
          .single()
      : Promise.resolve({ data: null }),
    // Messages
    supabase
      .from("client_portal_messages")
      .select("id, body, direction, read_at, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(3),
    // Post-1043: completed customer modules from learning_assignments.
    supabase
      .from("learning_assignments")
      .select("module_id, completed_at")
      .eq("contact_id", contactId)
      .eq("status", "completed"),
    // Recent transparency updates — kernel fan-out writes here when
    // listing milestones fire (LISTING_PUBLISHED, OFFER_ACCEPTED, etc.)
    supabase
      .from("transparency_updates")
      .select("id, title, plain_language_summary, message, next_step, next_step_date, responsible_party, responsible_party_name, update_type, is_visible_to_client, created_at, transaction_id")
      .eq("contact_id", contactId)
      .eq("is_visible_to_client", true)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  // Filter milestones to client-visible only
  const milestones = (milestonesResult.data ?? []).filter((m: any) =>
    CLIENT_VISIBLE_MILESTONES.includes(m.milestone_name as any)
  )

  const dealTeamMembers = dealTeamResult.data ?? []
  const primaryAgent = agentResult.data
  const messages = messagesResult.data ?? []
  const completedLessonKeys = educationResult.data?.map((p: any) => p.module_id) ?? []
  const recentUpdates = (recentUpdatesResult as any).data ?? []
  const hasCompletedLessons = completedLessonKeys.length > 0
  const vendorAssignments = vendorData.assignments ?? []

  // Computed values
  const unreadMessageCount = messages.filter((m: any) => m.direction === "inbound" && !m.read_at).length

  // Derived values — use already-fetched context (DOM is pre-computed from
  // go_live_date by resolveSellerContext; this is just the read).
  const daysOnMarket: number | null = context.listing?.dom ?? null
  const dashboardOfferCount: number = offerSummary?.total ?? 0

  // Derived values from getShowingInsights
  const sentimentBreakdown = showingInsights?.sentimentBreakdown ?? null
  const totalSentimentCount = sentimentBreakdown
    ? sentimentBreakdown.positive + sentimentBreakdown.neutral + sentimentBreakdown.negative
    : 0

  // Derive seller stage meaning from listing status
  const listingStatus = context.listing?.status ?? "pre_listing"
  const sellerStageCtx = SELLER_STAGE_MEANING[listingStatus] ?? {
    headline: "Your Listing",
    whatMeans: "Your agent is managing your listing and working to get you the best result.",
    whatNext: "Check in with your agent for the latest updates.",
    responsible: "Your Agent",
  }

  return (
    <div className="space-y-6">
      {/* Analytics: fires once on the client after mount — never during SSR/prefetch */}
      <SellerPortalViewTracker contactId={contactId} page="seller_home" />

      {/* Sprint 10 — Customer welcome panel (journey_type='seller'). Auto-
          starts the seller-specific 6-step onboarding (upload property
          details → review pricing strategy → market prep checklist).
          Hides on completion / dismissal. */}
      <CustomerWelcomePanel contactId={contactId} />

      {/* Sprint 8 — Negotiation mirror: when a strategy exists for an
          offer on this seller's listing, the customer-mirror panel
          renders here. Hides on empty. */}
      <NegotiationMirrorPanel contactId={contactId} />

      {/* 0. WHAT'S NEW — kernel fan-out feeds milestones from listing
           transitions (LISTING_PUBLISHED, OFFER_ACCEPTED, OPEN_HOUSE_SCHEDULED).
           Hidden when nothing client-visible yet. */}
      <RecentUpdatesFeed contactId={contactId} updates={recentUpdates} hideWhenEmpty />

      {/* 1. LISTING STATUS BANNER */}
      <ListingStatsCard
        listing={context.listing}
        metrics={context.metrics}
        contactId={contactId}
      />

      {/* 1b. WHAT THIS MEANS — seller plain-language stage card */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1">
              What This Means For You
            </p>
            <p className="text-base font-semibold text-foreground">{sellerStageCtx.headline}</p>
            <p className="text-sm text-muted-foreground leading-relaxed mt-1">
              {sellerStageCtx.whatMeans}
            </p>
          </div>
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              What Happens Next
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {sellerStageCtx.whatNext}
            </p>
            <Badge variant="outline" className="text-xs">
              Responsible: {sellerStageCtx.responsible}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* DAYS ON MARKET + OFFER COUNT STATS */}
      {context.listing && (daysOnMarket !== null || dashboardOfferCount > 0) && (
        <div className="grid grid-cols-2 gap-4">
          {daysOnMarket !== null && (
            <Card>
              <CardContent className="py-4 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-semibold">{daysOnMarket}</p>
                <p className="text-xs text-muted-foreground">Days on Market</p>
              </CardContent>
            </Card>
          )}
          {dashboardOfferCount > 0 && (
            <Card>
              <CardContent className="py-4 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-2xl font-semibold">{dashboardOfferCount}</p>
                <p className="text-xs text-muted-foreground">
                  {dashboardOfferCount === 1 ? "Offer" : "Offers"} Received
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Agent Next Actions — transparency for seller */}
      {milestones.filter((m: any) => m.status === 'pending').length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Your Agent Is Working On
            </p>
            {milestones.filter((m: any) => m.status === 'pending').slice(0, 3).map((m: any) => (
              <div key={m.id} className="flex items-center gap-2 text-sm py-1">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-foreground">{m.milestone_name?.replace(/_/g, ' ')}</span>
              </div>
            ))}
            <div className="mt-3">
              <Button size="sm" variant="outline" asChild>
                <Link href={`/portal/${contactId}/journey`}>
                  View Full Timeline
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2. SHOWING ACTIVITY STRIP */}
      {context.listing && (
        <ShowingActivityStrip
          thisWeek={showingStats.thisWeek}
          total={showingStats.total}
          avgRating={showingStats.avgRating}
          contactId={contactId}
        />
      )}

      {/* SHOWING INTELLIGENCE — from getShowingInsights */}
      {context.listing && showingInsights && totalSentimentCount > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Showing Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Sentiment breakdown */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Buyer Feedback Sentiment
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2 rounded-lg bg-green-50 border border-green-100">
                  <ThumbsUp className="h-4 w-4 text-green-600 mx-auto mb-1" />
                  <p className="text-lg font-semibold text-green-700">
                    {sentimentBreakdown!.positive}
                  </p>
                  <p className="text-xs text-green-600">Positive</p>
                </div>
                <div className="p-2 rounded-lg bg-amber-50 border border-amber-100">
                  <Minus className="h-4 w-4 text-amber-600 mx-auto mb-1" />
                  <p className="text-lg font-semibold text-amber-700">
                    {sentimentBreakdown!.neutral}
                  </p>
                  <p className="text-xs text-amber-600">Neutral</p>
                </div>
                <div className="p-2 rounded-lg bg-red-50 border border-red-100">
                  <ThumbsDown className="h-4 w-4 text-red-600 mx-auto mb-1" />
                  <p className="text-lg font-semibold text-red-700">
                    {sentimentBreakdown!.negative}
                  </p>
                  <p className="text-xs text-red-600">Needs Attention</p>
                </div>
              </div>
            </div>

            {/* Weekly trend mini-chart */}
            {showingInsights.weeklyStats.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Weekly Showing Activity
                </p>
                <div className="flex items-end gap-1 h-10">
                  {showingInsights.weeklyStats.map((wk, i) => {
                    const maxCount = Math.max(...showingInsights.weeklyStats.map((w) => w.count), 1)
                    const heightPct = wk.count === 0 ? 4 : Math.max(10, (wk.count / maxCount) * 100)
                    return (
                      <div
                        key={i}
                        className="flex-1 bg-emerald-200 rounded-sm"
                        style={{ height: `${heightPct}%` }}
                        title={`${wk.week}: ${wk.count} showing${wk.count !== 1 ? "s" : ""}`}
                      />
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Last 8 weeks</p>
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/insights`}>
                  Full Insights
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 3. SHOWING FEEDBACK SUMMARY */}
        <ShowingFeedbackCard
          feedback={recentFeedback}
          contactId={contactId}
        />

        {/* 4. OFFER STATUS CARD */}
        <SellerOfferCard
          total={offerSummary.total}
          highest={offerSummary.highest}
          accepted={offerSummary.accepted}
          pending={offerSummary.pending}
          contactId={contactId}
          listPrice={context.listing?.list_price}
        />

        {/* 7. MARKET POSITION CARD */}
        <MarketPositionCard
          report={marketPosition.report}
          comparison={marketPosition.comparison}
          listPrice={context.listing?.list_price ?? null}
        />
      </div>

      {/* 5. MILESTONE PROGRESS BAR */}
      {context.transactionId && milestones.length > 0 && (
        <MilestoneProgressBar
          milestones={milestones}
          contactId={contactId}
          labelMap={SELLER_MILESTONE_LABELS}
        />
      )}

      {/* 6. DEAL TEAM CARD */}
      <DealTeamCard
        primaryAgent={primaryAgent}
        teamMembers={dealTeamMembers as any}
        variant="full"
      />

      {/* Bottom Row */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 8. MESSAGES PREVIEW */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Messages
                {unreadMessageCount > 0 && (
                  <Badge variant="destructive" className="ml-1">{unreadMessageCount}</Badge>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/messages`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No messages yet
              </p>
            ) : (
              <div className="space-y-2">
                {messages.slice(0, 2).map((msg: any) => (
                  <div key={msg.id} className="p-2 rounded-lg bg-muted/50">
                    <p className="text-sm line-clamp-2">
                      {msg.body?.substring(0, 80)}{msg.body?.length > 80 ? "..." : ""}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(msg.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 9. EDUCATION SPOTLIGHT */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              Seller Resources
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                {hasCompletedLessons
                  ? "Continue learning about the selling process"
                  : "Tips and guides for selling your home"}
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/portal/${contactId}/learn`}>
                  <BookOpen className="h-4 w-4 mr-2" />
                  View Resources
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 10a. PRE-LISTING TOOLKIT — persona+stage-filtered marketplace
                  preview surfaces stagers, photographers, cleaners, and
                  prep pros the agent has curated for sellers. */}
        <ContactVendorToolkitCard contactId={contactId} portalView="seller" />

        {/* 10b. ACTIVE VENDOR ASSIGNMENTS — pros already engaged on this
                  listing/transaction (assignment-status focused). */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Briefcase className="h-4 w-4" />
                Active Vendor Team
              </CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/portal/${contactId}/vendors`}>
                  View All
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {vendorAssignments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Vendor assignments will appear here
              </p>
            ) : (
              <div className="space-y-2">
                {vendorAssignments.slice(0, 3).map((va: any) => (
                  <div key={va.id} className="flex items-center justify-between p-2 rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{va.vendor?.business_name || "Vendor"}</p>
                      <p className="text-xs text-muted-foreground">{va.vendor?.vendor_type || va.assignment_type}</p>
                    </div>
                    <Badge variant="secondary">{va.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 11. QUICK ACTIONS ROW */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-3 justify-center">
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/insights`}>
                <Eye className="h-4 w-4 mr-2" />
                View Showing Feedback
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/offers`}>
                <FileText className="h-4 w-4 mr-2" />
                See Offers
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/messages`}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Message Agent
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/documents`}>
                <FileText className="h-4 w-4 mr-2" />
                View Documents
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 12. SHARE MY HOME — social posts about this listing pushed by agent */}
      {context.listing?.id && (
        <ShareMyHomeCard
          listingId={context.listing.id}
          listingAddress={context.listing.address ?? "your home"}
        />
      )}
    </div>
  )
}
