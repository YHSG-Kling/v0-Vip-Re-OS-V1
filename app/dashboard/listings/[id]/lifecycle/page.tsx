import { createClient } from "@/lib/supabase/server"
import { notFound, redirect } from "next/navigation"
import { getAllStages, getStageDefinition, getEnabledSystemGates } from "@/lib/listing-lifecycle/lifecycle-definitions"
import type { ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { StagePipeline }       from "./components/stage-pipeline"
import { TasksPanel }           from "./components/tasks-panel"
import { StageTimeline }        from "./components/stage-timeline"
import { SellerCoachingCard }   from "./components/seller-coaching-card"
import { getListingMedia, getVideoProjects } from "@/app/actions/listing-media"
import { getOpenHouseDashboard } from "@/app/actions/seller-open-house"
import {
  LaunchStateStrip,
  MediaReadinessCard,
  PublishReadinessCard,
  MarketingTierReadinessCard,
  SellerUpdateReadinessCard,
  OpenHouseReadinessCard,
  NeighborhoodStoryCard,
  LaunchActionsPanel,
} from "../components/launch"
import { ListingAgreementStatusCard } from "./components/listing-agreement-status-card"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingLifecyclePage({ params }: PageProps) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Load listing — auth scope: agent=own, team_lead=team, broker/admin=any
  let listingQuery = supabase
    .from("listings")
    .select("id, address, city, state, zip, lifecycle_stage, go_live_date, open_house_marketing_date, open_house_event_date, assigned_agent_id, brokerage_id, list_price")
    .eq("id", listingId)
    .eq("brokerage_id", userRow.brokerage_id)

  if (userRow.role === "agent") {
    listingQuery = listingQuery.eq("assigned_agent_id", user.id)
  }

  const { data: listing } = await listingQuery.single()
  if (!listing) notFound()

  // Load lifecycle events for completed stages + timeline
  const { data: lifecycleEvents } = await supabase
    .from("lifecycle_events")
    .select("id, event_type, metadata, actor_user_id, created_at")
    .eq("entity_type", "listing_stage_machine")
    .eq("entity_id", listingId)
    .order("created_at", { ascending: true })

  // Load tasks
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, description, status, priority, due_date, owner_role, auto_generated, completed_at")
    .eq("listing_id", listingId)
    .eq("auto_generated", true)
    .order("due_date", { ascending: true })

  // Fetch listing agreement esign status (most recent agreement for this listing)
  const { data: listingAgreement } = await supabase
    .from("listing_agreements")
    .select("id, agreement_type, esign_status, provider_name, provider_ref, seller_signed_at, agent_signed_at, fully_executed_at, document_url, document_name, effective_date")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Parallel fetch for launch readiness data
  const [mediaResult, videosResult, openHouseResult, tierResult, neighborhoodResult, packetResult] =
    await Promise.all([
      getListingMedia(listingId),
      getVideoProjects(listingId),
      getOpenHouseDashboard(listingId),
      supabase
        .from("listing_marketing_tiers")
        .select("id, tier_name, description")
        .eq("id", listing.marketing_tier_id ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle(),
      supabase
        .from("neighborhood_reports")
        .select("id, neighborhood_name, market_trend, median_home_price, ai_summary")
        .eq("listing_id", listingId)
        .maybeSingle(),
      supabase
        .from("listing_packet_jobs")
        .select("id, status")
        .eq("listing_id", listingId)
        .eq("status", "completed")
        .maybeSingle(),
    ])

  // Compute readiness signals
  const media = mediaResult.data ?? []
  const videos = videosResult.data ?? []
  const photoCount = media.filter((m: any) => m.media_type === "photo").length
  const videoCount = videos.length
  const mediaReady = photoCount >= 10

  const currentTier = tierResult.data
  const marketingReady = !!currentTier

  const neighborhoodReport = neighborhoodResult.data
  const hasNeighborhoodReport = !!neighborhoodReport
  const pricingNarrativeReady = !!neighborhoodReport?.ai_summary

  const packetReady = !!packetResult.data

  // Required fields check (simplified - based on listing data)
  const requiredFields = [
    { field: "Address", complete: !!listing.address },
    { field: "List Price", complete: !!listing.list_price },
    { field: "City", complete: !!listing.city },
    { field: "State", complete: !!listing.state },
    { field: "ZIP", complete: !!listing.zip },
  ]
  const publishReady = requiredFields.every(f => f.complete)

  // Open house data
  const openHouseData = openHouseResult
  const scheduledEvent = openHouseData?.events?.[0]
  const openHousePromotionStatus: "not_started" | "scheduled" | "published" =
    openHouseData?.posts?.some((p: any) => p.status === "published") ? "published" :
    openHouseData?.posts?.some((p: any) => p.status === "scheduled") ? "scheduled" : "not_started"
  const rsvpCount = openHouseData?.invitations?.filter((i: any) => i.rsvp_response === "yes").length ?? 0

  // Blockers
  const blockers: string[] = []
  if (!mediaReady) blockers.push("Need 10+ photos")
  if (!publishReady) blockers.push("Missing required fields")
  if (!marketingReady) blockers.push("No marketing tier")

  const currentStage = (listing.lifecycle_stage ?? "LEAD") as ListingStage
  const allStages = getAllStages()
  const currentStageDef = getStageDefinition(currentStage)
  const enabledGates = getEnabledSystemGates(currentStage)

  // Derive completed stages from lifecycle_events metadata.to_state
  const completedStages = new Set<string>(
    (lifecycleEvents ?? [])
      .map(e => e.metadata?.to_state as string)
      .filter(Boolean)
  )

  // Valid next stages from current stage definition
  const validNextStages = allStages
    .filter(s => s.allowedFrom.includes(currentStage))
    .map(s => s.stage)

  const canOverride = ["broker", "admin", "team_lead"].includes(userRow.role)

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-background">
      {/* LEFT — Stage Pipeline (280px) */}
      <aside className="w-[280px] flex-shrink-0 border-r border-border overflow-y-auto bg-card">
        <StagePipeline
          listingId={listingId}
          currentStage={currentStage}
          completedStages={completedStages}
          validNextStages={validNextStages}
          allStages={allStages}
          enabledGates={enabledGates}
          lifecycleEvents={lifecycleEvents ?? []}
          canOverride={canOverride}
          userId={user.id}
          brokerageId={userRow.brokerage_id}
        />
      </aside>

      {/* CENTER — Tasks (flex) */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-foreground">
            {listing.address}, {listing.city} {listing.state}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Stage: <span className="font-medium text-foreground">{currentStageDef?.label ?? currentStage}</span>
          </p>
        </div>

        {/* Launch State Strip */}
        <div className="mb-6">
          <LaunchStateStrip
            listingId={listingId}
            currentStage={currentStage}
            mediaReady={mediaReady}
            publishReady={publishReady}
            marketingReady={marketingReady}
            blockers={blockers}
          />
        </div>

        {/* Readiness Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          <MediaReadinessCard
            listingId={listingId}
            photoCount={photoCount}
            videoCount={videoCount}
            hasBranded={media.some((m: any) => m.is_branded)}
            hasUnbranded={media.some((m: any) => !m.is_branded)}
          />
          <PublishReadinessCard
            listingId={listingId}
            requiredFields={requiredFields}
            complianceBlockers={[]}
            packetReady={packetReady}
          />
          <MarketingTierReadinessCard
            listingId={listingId}
            currentTier={currentTier}
            campaignReady={!!currentTier}
            assetsCreated={media.length}
            assetsRequired={10}
          />
          <SellerUpdateReadinessCard
            listingId={listingId}
            agentId={user.id}
            hasPendingDraft={false}
          />
          <OpenHouseReadinessCard
            listingId={listingId}
            scheduledEvent={scheduledEvent}
            promotionStatus={openHousePromotionStatus}
            rsvpCount={rsvpCount}
          />
          <NeighborhoodStoryCard
            listingId={listingId}
            hasReport={hasNeighborhoodReport}
            neighborhoodName={neighborhoodReport?.neighborhood_name}
            pricingNarrativeReady={pricingNarrativeReady}
            marketTrend={neighborhoodReport?.market_trend}
            medianPrice={neighborhoodReport?.median_home_price}
          />
          <ListingAgreementStatusCard
            listingId={listingId}
            agreement={listingAgreement ?? null}
          />
        </div>

        <SellerCoachingCard
          listingId={listingId}
          listingStage={currentStage}
          brokerageId={userRow.brokerage_id}
          agentUserId={user.id}
        />
        <TasksPanel tasks={tasks ?? []} listingId={listingId} />
      </main>

      {/* RIGHT — Timeline + Actions (300px) */}
      <aside className="w-[300px] flex-shrink-0 border-l border-border overflow-y-auto bg-card p-4 space-y-4">
        <LaunchActionsPanel
          listingId={listingId}
          agentId={user.id}
          brokerageId={userRow.brokerage_id}
          canLaunch={mediaReady && publishReady && marketingReady}
        />
        <StageTimeline
          listing={listing}
          lifecycleEvents={lifecycleEvents ?? []}
        />
      </aside>
    </div>
  )
}
