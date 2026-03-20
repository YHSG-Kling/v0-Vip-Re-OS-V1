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
import { getMarketPosition, getSellerVendors } from "@/app/actions/portal-seller"
import { ListingStatsCard } from "@/app/components/portal/ListingStatsCard"
import { ShowingActivityStrip, ShowingFeedbackCard } from "@/app/components/portal/ShowingsFeedCard"
import { SellerOfferCard } from "@/app/components/portal/SellerOfferCard"
import { MarketPositionCard } from "@/app/components/portal/MarketPositionCard"
import { MilestoneProgressBar } from "@/app/components/portal/MilestoneProgressBar"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import {
  MessageSquare,
  BookOpen,
  Briefcase,
  ArrowRight,
  FileText,
  Eye,
  BarChart3,
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
          .select("id, milestone_name, milestone_type, milestone_date, completed_date, status")
          .eq("transaction_id", context.transactionId)
          .order("milestone_date", { ascending: true, nullsFirst: false })
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
    // Education - completed lessons from contact_education_progress
    supabase
      .from("contact_education_progress")
      .select("lesson_key, completed_at")
      .eq("contact_id", contactId),
  ])

  // Filter milestones to client-visible only
  const milestones = (milestonesResult.data ?? []).filter((m: any) =>
    CLIENT_VISIBLE_MILESTONES.includes(m.milestone_name as any)
  )

  const dealTeamMembers = dealTeamResult.data ?? []
  const primaryAgent = agentResult.data
  const messages = messagesResult.data ?? []
  const completedLessonKeys = educationResult.data?.map((p: any) => p.lesson_key) ?? []
  const hasCompletedLessons = completedLessonKeys.length > 0
  const vendorAssignments = vendorData.assignments ?? []

  // Computed values
  const unreadMessageCount = messages.filter((m: any) => m.direction === "inbound" && !m.read_at).length

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

      {/* 2. SHOWING ACTIVITY STRIP */}
      {context.listing && (
        <ShowingActivityStrip
          thisWeek={showingStats.thisWeek}
          total={showingStats.total}
          avgRating={showingStats.avgRating}
          contactId={contactId}
        />
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

        {/* 10. VENDORS PREVIEW */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Briefcase className="h-4 w-4" />
                Vendors
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
    </div>
  )
}
