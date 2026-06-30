import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CongratsCard } from "@/app/components/portal/lifetime/CongratsCard"
import { MyHomeCard } from "@/app/components/portal/lifetime/MyHomeCard"
import { EquityEstimateCard } from "@/app/components/portal/lifetime/EquityEstimateCard"
import { ReferralAskCard } from "@/app/components/portal/lifetime/ReferralAskCard"
import { TestimonialCard } from "@/app/components/portal/lifetime/TestimonialCard"
import { NextMoveCard } from "@/app/components/portal/lifetime/NextMoveCard"
import { AskYourHomeCard } from "@/app/components/portal/lifetime/AskYourHomeCard"
import { HomeMaintenanceCard } from "@/app/components/portal/lifetime/HomeMaintenanceCard"
import { NeighborhoodActivityCard } from "@/app/components/portal/lifetime/NeighborhoodActivityCard"
import { RefinanceIndicatorCard } from "@/app/components/portal/lifetime/RefinanceIndicatorCard"
import { ContactVendorToolkitCard } from "@/app/components/portal/ContactVendorToolkitCard"
import { DealTeamCard } from "@/app/components/portal/DealTeamCard"
import { getLifetimeContext } from "@/app/actions/portal-lifetime"
import { createClient } from "@/lib/supabase/server"
import { RecentUpdatesFeed } from "./components/RecentUpdatesFeed"
import { PortalLiveFeed } from "@/app/components/portal/PortalLiveFeed"
import { MilestoneEducationPanel } from "@/app/components/portal/milestone-education-panel"
import { LifetimeMilestoneLine } from "./components/LifetimeMilestoneLine"
import { computeHomeWealthStory } from "@/lib/portal/home-wealth"
import { maintenanceDeck } from "@/lib/portal/home-maintenance"
import {
  Bell,
  BookOpen,
  Wrench,
  ArrowRight,
  Clock,
  FileText,
  Star,
} from "lucide-react"

interface LifetimeHomeProps {
  contactId: string
}

// Lifetime customers receive ongoing transparency_updates on home value
// changes, anniversaries, market events. Loaded here so the feed surfaces
// at the top of the page.
async function loadRecentUpdates(contactId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("transparency_updates")
    .select("id, title, plain_language_summary, message, next_step, next_step_date, responsible_party, responsible_party_name, update_type, is_visible_to_client, created_at, transaction_id")
    .eq("contact_id", contactId)
    .eq("is_visible_to_client", true)
    .order("created_at", { ascending: false })
    .limit(20)
  return data ?? []
}

export default async function LifetimeHome({ contactId }: LifetimeHomeProps) {
  const [context, recentUpdates] = await Promise.all([
    getLifetimeContext(contactId),
    loadRecentUpdates(contactId),
  ])

  if (!context) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Unable to load your portal. Please try again.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { contact, agent, transaction, homeValueEstimate, homeValueSeries, touchpoints, preferredVendors, neighborhoodListings, vendorCategories } = context

  // Wealth story drives both the equity card and the "Your Next Move" radar
  // (equity/tenure only — the compliant, client-facing re-transaction surface).
  const wealth = computeHomeWealthStory({
    purchasePrice: transaction?.sale_price ?? null,
    closeDate: transaction?.close_date ?? null,
    estimatedValueMid: homeValueEstimate?.estimated_value_mid,
    estimatedValueLow: homeValueEstimate?.estimated_value_low,
    estimatedValueHigh: homeValueEstimate?.estimated_value_high,
    latestGeneratedAt: homeValueEstimate?.generated_at,
    series: homeValueSeries,
  })

  // Seasonal + tenure-based home-care suggestions. Month resolved here (server
  // render) so the pure engine stays deterministic. Each suggestion ties to a
  // vendor category for a marketplace "request an intro".
  const maintenance = maintenanceDeck({
    month: new Date().getMonth() + 1,
    yearsHeld: wealth.yearsHeld,
    availableVendorCategories: vendorCategories,
  })
  const firstName = contact.first_name || "Homeowner"
  // getLifetimeContext returns `agent: agentInfo` (from resolveContactOwnerAgent).
  // Previous code read (contact as any).agents?.name which doesn't exist on the
  // contact row — agentName was always undefined.
  const agentName = agent?.full_name ?? null

  // Deal team — common-area visibility (who was/is part of this client's journey).
  const lifetimeSupabase = await createClient()
  let dealTeamMembers: any[] = []
  let primaryAgent: any = null
  if (transaction?.id) {
    const { data: dt } = await lifetimeSupabase
      .from("deal_team_members")
      .select("id, member_type, external_name:name, external_company:company, external_phone:phone, external_email:email")
      .eq("transaction_id", transaction.id)
    // deal_team_members has no agent_id/FK to agents — members render as external contacts.
    dealTeamMembers = (dt ?? []).map((m: any) => ({ ...m, agent: null }))
  }
  if (contact.agent_id) {
    const { data: pa } = await lifetimeSupabase
      .from("agents")
      .select("id, profile_image_url, users(first_name, last_name, phone, email)")
      .eq("id", contact.agent_id)
      .maybeSingle()
    primaryAgent = pa
      ? {
          id: pa.id,
          profile_photo_url: (pa as any).profile_image_url,
          first_name: (pa.users as any)?.first_name ?? null,
          last_name: (pa.users as any)?.last_name ?? null,
          phone: (pa.users as any)?.phone ?? null,
          email: (pa.users as any)?.email ?? null,
        }
      : null
  }

  // Get last market update touchpoint
  const lastMarketUpdate = touchpoints.find(
    (t: any) => t.touchpoint_type === "market_update" || t.touchpoint_type === "anniversary"
  )
  const hasUnreadUpdate = lastMarketUpdate && !lastMarketUpdate.opened_at

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Milestone-gated education for post-close contacts. Lifetime
          customers see wealth + home-care lessons (set_refi_alerts,
          home_value_tracking, annual_market_update, etc.). Hides on empty. */}
      <MilestoneEducationPanel contactId={contactId} />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Welcome Home, {firstName}</h1>
          <p className="text-muted-foreground mt-1">
            {"Your home is your greatest investment. Here's everything in one place."}
          </p>
        </div>
        {agentName && (
          <div className="text-right shrink-0">
            <p className="text-sm text-muted-foreground">Your Agent</p>
            <p className="font-medium">{agentName}</p>
          </div>
        )}
      </div>

      {/* 0a. WHAT'S NEW — kernel fan-out feeds (anniversary, equity changes,
            agent market updates). Hidden when nothing client-visible. */}
      <RecentUpdatesFeed contactId={contactId} updates={recentUpdates} hideWhenEmpty />

      {/* 0a-bis. Live event stream — every actionable kernel event the
                  customer is allowed to see, translated to friendly copy. */}
      <PortalLiveFeed contactId={contactId} limit={15} />

      {/* 0b. Lifetime milestone line — gives the homeowner the same "where am
            I" signal that buyer/seller portals have. Driven by close-date
            deltas (settling-in / anniversary / multi-year). Surfaces a
            refinance lane when an opportunity is flagged on the equity card. */}
      {transaction?.close_date && (
        <LifetimeMilestoneLine
          contactId={contactId}
          closeDate={transaction.close_date}
          currentEstimate={homeValueEstimate?.estimated_value_mid}
          purchasePrice={transaction?.sale_price ?? null}
        />
      )}

      {/* 1. Congrats Card (dismissible) */}
      {transaction && (
        <CongratsCard
          contactId={contactId}
          firstName={firstName}
          propertyAddress={transaction.property_address}
          closeDate={transaction.close_date}
          salePrice={transaction.sale_price}
        />
      )}

      {/* Ask your home anything — self-serve AI scoped to this home, compliance-
          railed (no legal/tax/lending advice, no value guarantees, defers to the
          agent). A marquee differentiator no client portal offers. */}
      <AskYourHomeCard contactId={contactId} agentFirstName={agentName ? agentName.split(" ")[0] : null} />

      {/* Main Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* 2. My Home Card */}
        {transaction && (
          <MyHomeCard
            contactId={contactId}
            propertyAddress={transaction.property_address}
            closeDate={transaction.close_date}
            closePrice={transaction.sale_price}
            currentEstimate={homeValueEstimate?.estimated_value_mid}
            agentName={agentName ?? undefined}
          />
        )}

        {/* 3. Equity Estimate Card */}
        <EquityEstimateCard
          estimatedValueMid={homeValueEstimate?.estimated_value_mid}
          estimatedValueLow={homeValueEstimate?.estimated_value_low}
          estimatedValueHigh={homeValueEstimate?.estimated_value_high}
          purchasePrice={transaction?.sale_price || 0}
          marketTrend={homeValueEstimate?.market_trend}
          generatedAt={homeValueEstimate?.generated_at}
          closeDate={transaction?.close_date}
          valueSeries={homeValueSeries}
        />

        {/* 4. Neighborhood Activity */}
        <NeighborhoodActivityCard
          listings={neighborhoodListings}
          propertyAddress={transaction?.property_address}
        />

        {/* 5. Refinance Opportunity */}
        {transaction?.sale_price && transaction.sale_price > 0 && (
          <RefinanceIndicatorCard
            purchasePrice={transaction.sale_price}
            closeDate={transaction.close_date}
          />
        )}

        {/* 6. Market Updates Preview */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="h-5 w-5 text-blue-600" />
                <CardTitle className="text-lg">Market Updates</CardTitle>
              </div>
              {hasUnreadUpdate && (
                <Badge variant="destructive" className="text-xs">New</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {lastMarketUpdate ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    Last update: {new Date(lastMarketUpdate.sent_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm capitalize">{lastMarketUpdate.touchpoint_type.replace("_", " ")}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No market updates yet</p>
            )}
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/market-updates`}>
                View Market Updates
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* 5. Referral Ask Card */}
        <ReferralAskCard contactId={contactId} />

        {/* 5b. Testimonial — a few words or a short video the agent can use in marketing */}
        <TestimonialCard contactId={contactId} agentFirstName={agentName ? agentName.split(" ")[0] : null} />

        {/* 5b. Homeowner Toolkit — persona-filtered vendor marketplace
                preview. Surfaces top curated forever-stage vendors with
                team scoping + audience filtering. */}
        <ContactVendorToolkitCard contactId={contactId} portalView="lifetime" />

        {/* 6. Preferred Vendors (compact) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-orange-600" />
              <CardTitle className="text-lg">Trusted Vendors</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {preferredVendors.length > 0 ? (
              <div className="space-y-2">
                {preferredVendors.slice(0, 3).map((v: any) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div>
                      <p className="font-medium text-sm">
                        {v.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {v.category}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {v.rating && (
                        <div className="flex items-center gap-1">
                          <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                          <span className="text-xs">{v.rating}</span>
                        </div>
                      )}
                      {v.preferred && !v.rating && (
                        <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Trusted service providers recommended by your agent for home maintenance and improvements.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/resources`}>
                    Browse Service Providers
                  </Link>
                </Button>
              </div>
            )}
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/resources`}>
                View All Resources
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* 7. Education Spotlight */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg">Homeowner Tips</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Learn how to maintain and protect your investment with our homeowner guides.
            </p>
            <Button variant="outline" className="w-full" asChild>
              <Link href={`/portal/${contactId}/learn`}>
                View Learning Center
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Deal Team — who was part of your home journey */}
      {(primaryAgent || dealTeamMembers.length > 0) && (
        <DealTeamCard
          primaryAgent={primaryAgent}
          teamMembers={dealTeamMembers as any}
          variant="full"
        />
      )}

      {/* Seasonal home-care — upkeep suggestions wired to the vendor marketplace */}
      <HomeMaintenanceCard
        contactId={contactId}
        season={maintenance.season}
        suggestions={maintenance.suggestions}
        availableVendorCategories={vendorCategories}
      />

      {/* Re-engagement: "Your Next Move" radar — replaces the old static
          "Thinking of moving?" CTA with a self-directed, equity-aware set of
          options. A tap is a client-INITIATED re-transaction intent that
          notifies the agent AND rides the manager bus (AI ISA -> Sphere ->
          the right next step). Equity/tenure only — fair-housing-safe. */}
      <NextMoveCard
        contactId={contactId}
        estimatedEquity={wealth.hasEstimate ? wealth.estimatedEquity : null}
        yearsHeld={wealth.yearsHeld}
      />

      {/* Quick Links */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-4 justify-center">
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/history`}>
                <FileText className="mr-2 h-4 w-4" />
                Transaction History
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/documents`}>
                <FileText className="mr-2 h-4 w-4" />
                My Documents
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href={`/portal/${contactId}/messages`}>
                <Bell className="mr-2 h-4 w-4" />
                Messages
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
