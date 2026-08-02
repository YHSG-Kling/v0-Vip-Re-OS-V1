import { createClient } from "@/lib/supabase/server"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { notFound, redirect } from "next/navigation"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { getAllStages, getStageDefinition, getEnabledSystemGates } from "@/lib/listing-lifecycle/lifecycle-definitions"
import type { ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { StagePipeline }       from "@/app/components/dashboard/listings/lifecycle/stage-pipeline"
import { TasksPanel }           from "@/app/components/dashboard/listings/lifecycle/tasks-panel"
import { StageTimeline }        from "@/app/components/dashboard/listings/lifecycle/stage-timeline"
import { SellerCoachingCard }   from "@/app/components/dashboard/listings/lifecycle/seller-coaching-card"
import { ListingHealthRadarPanel } from "@/app/components/features/listings/listing-health-radar-panel"
import { getListingMedia, getVideoProjects } from "@/app/actions/listing-media"
import { getOpenHouseDashboard, getPostEventIntelligence } from "@/app/actions/seller-open-house"
import {
  LaunchReadinessChecklist,
  LaunchActionsPanel,
} from "../components/launch"
import { OpenHousePostEventPanel } from "../components/open-house-post-event-panel"
import { VendorBookingsPanel } from "@/app/dashboard/components/vendor-bookings-panel"
import { VendorBookingButton } from "@/app/components/dashboard/listings/lifecycle/vendor-booking-button"
import { DecisionHistoryPanel } from "@/app/components/dashboard/listings/lifecycle/decision-history-panel"
import { ComingSoonCommandCard } from "@/app/components/dashboard/listings/lifecycle/coming-soon-command-card"
import { PreListingWorkflowPanel } from "@/app/components/dashboard/listings/lifecycle/pre-listing-workflow-panel"
import { MatchingBuyersPanel } from "@/app/components/dashboard/listings/lifecycle/matching-buyers-panel"
import { PriceReductionSheet } from "../components/price-reduction-sheet"
import { NeighborNotificationCard } from "../components/neighbor-notification-card"
import { ListingPacketPanel } from "@/app/components/dashboard/listings/lifecycle/listing-packet-panel"
import { AiOptimizationPanel, type AiListingOptimizationRow } from "../components/ai-optimization-panel"
import { ListingFormsPanel } from "@/app/components/dashboard/listings/lifecycle/listing-forms-panel"
import { CheckCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingLifecyclePage({ params }: PageProps) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) redirect("/dashboard")

  // Load listing — auth scope: agent=own, team_lead=team, broker/admin=any.
  // Default to the restrictive ("agent") path when user_type is absent.
  let listingQuery = supabase
    .from("listings")
    .select("id, address, city, state, zip, lifecycle_stage, go_live_date, open_house_marketing_date, open_house_event_date, agent_id, brokerage_id, list_price, seller_contact_id, marketing_tier_id, status, mls_number, mls_link")
    .eq("id", listingId)
    .eq("brokerage_id", userRow.brokerage_id)

  if ((userRow.user_type ?? "agent") === "agent") {
    // IDENTITY CLASS. listings.agent_id FKs AGENTS, and user.id is a USERS id —
    // filtering one by the other matches nothing, so an agent could never open
    // the lifecycle page for their own listing. Resolved through the canonical
    // resolver; a caller with no agents row keeps the restrictive path and is
    // given an id that matches nothing on purpose rather than being widened to
    // the whole brokerage.
    const agentRecordId = await resolveUserIdToAgentRecord(user.id, userRow.brokerage_id)
    listingQuery = listingQuery.eq("agent_id", agentRecordId ?? "00000000-0000-0000-0000-000000000000")
  }

  const { data: listing } = await listingQuery.single()
  if (!listing) notFound()

  // Fetch seller contact (needed for closed celebration card + forms pre-fill)
  const sellerContact = listing.seller_contact_id
    ? await supabase
        .from("contacts")
        .select("id, first_name, last_name, contact_type, email")
        .eq("id", listing.seller_contact_id)
        .maybeSingle()
        .then(r => r.data)
    : null

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
    .select("id, title, description, status, priority, due_date, owner_role:assignee_type, auto_generated, completed_at")
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

  // Coming soon state — media approved gate + transaction ID for email campaigns
  const [mediaApprovedResult, transactionResult] = await Promise.all([
    supabase
      .from("activities")
      .select("id")
      .eq("listing_id", listingId)
      .eq("activity_type", "seller.media.approved")
      .maybeSingle(),
    supabase
      .from("transactions")
      .select("id")
      .eq("listing_id", listingId)
      .maybeSingle(),
  ])

  const mediaApproved = !!mediaApprovedResult.data
  const transactionId = transactionResult.data?.id ?? null

  // AI listing optimization recommendations — written one row per category by
  // app/actions/marketing-package-automation.ts, keyed on transaction_id (the
  // table has no listing_id column). Latest batch first.
  let aiOptimizations: AiListingOptimizationRow[] = []
  if (transactionId) {
    const { data: optRows, error: optError } = await supabase
      .from("ai_listing_optimizations")
      .select("id, optimization_category, recommendation, reasoning, priority, estimated_impact, status, generated_at")
      .eq("transaction_id", transactionId)
      .order("generated_at", { ascending: false })
      .limit(5)

    if (!optError && optRows) {
      aiOptimizations = optRows as AiListingOptimizationRow[]
    }
  }

  // Listing Health Radar data — runs in parallel with the launch-readiness
  // fetches below. All three queries are gated by RLS to this brokerage.
  const [healthScoreRes, openInterventionsRes, scoreHistoryRes] = await Promise.all([
    supabase
      .from("listing_health_scores")
      .select("id, overall_score, risk_level, flags, ai_narrative, previous_score, score_delta, days_on_market, scored_at, recommended_actions")
      .eq("listing_id", listingId)
      .order("scored_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("listing_health_interventions")
      .select("id, issue_detected, severity, ai_recommendation, category, created_at")
      .eq("listing_id", listingId)
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("listing_health_scores")
      .select("overall_score, risk_level, scored_at")
      .eq("listing_id", listingId)
      .order("scored_at", { ascending: false })
      .limit(7),
  ])
  const healthScore = healthScoreRes.data ?? null
  const openInterventions = openInterventionsRes.data ?? []
  const scoreHistory = scoreHistoryRes.data ?? []

  // Parallel fetch for launch readiness data
  const [mediaResult, videosResult, openHouseResult, tierResult, neighborhoodResult, packetResult] =
    await Promise.all([
      getListingMedia(listingId),
      getVideoProjects(listingId),
      getOpenHouseDashboard(listingId),
      listing.marketing_tier_id
        ? supabase
            .from("listing_marketing_tiers")
            .select("id, tier_name, description")
            .eq("id", listing.marketing_tier_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
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
  // Spec: minimum 5 photos to launch
  const mediaReady = photoCount >= 5

  const currentTier = tierResult.data
  // Gate: check if this user's plan includes listing_marketing_tiers.
  // The superadmin controls which tier plan each brokerage is on; features are
  // determined by that plan. canAccessFeature handles trial overrides, disabled
  // overrides, and per-tier access columns from the feature_flags table.
  const marketingAccess = await canAccessFeature(user.id, "listing_marketing_tiers")
  const marketingReady = marketingAccess.allowed

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

  // Past/completed open houses with their attendees attached.
  //
  // Sourced from getPostEventIntelligence rather than re-derived from the
  // dashboard payload. Two reasons, both defects the inline derivation caused:
  //   · the dashboard's attendee select omits feedback_collected_at, so the panel's
  //     "awaiting feedback" list counted EVERY attendee forever;
  //   · getPostEventIntelligence returns attendees ordered by ai_lead_score, which
  //     is the order the hot-prospect section is meant to be read in.
  // It was a complete, tenant-scoped action with no caller.
  const postEvent = await getPostEventIntelligence(listingId)
  const postEventAttendees = postEvent?.attendees ?? []
  const pastOpenHouses = (postEvent?.events ?? []).map((e: any) => ({
    ...e,
    attendees: postEventAttendees.filter((a: any) => a.event_id === e.id),
  }))
  const openHousePromotionStatus: "not_started" | "scheduled" | "published" =
    openHouseData?.socialPosts?.some((p: any) => p.status === "published") ? "published" :
    openHouseData?.socialPosts?.some((p: any) => p.status === "scheduled") ? "scheduled" : "not_started"
  const rsvpCount = openHouseData?.invitations?.filter((i: any) => i.rsvp_response === "yes").length ?? 0

// Fetch vendors for the "Assign Vendor" modal
const { data: listingVendors } = await supabase
  .from("vendors")
  .select("id, name, category, rating")
  .eq("brokerage_id", userRow.brokerage_id)
  .order("name", { ascending: true })
  .limit(100)

// Fetch vendor bookings directly by listing_id (column now exists after migration)
const { data: listingVendorBookings } = await supabase
  .from("vendor_bookings")
  .select("id, service_type, status, scheduled_date, notes, contact_id, listing_id, vendors(name)")
    .eq("listing_id", listingId)
    .not("status", "in", "(cancelled,no_show)")
    .order("scheduled_date", { ascending: true })

  const canOverride = ["broker", "broker_owner", "admin", "team_lead", "superadmin"].includes(userRow.user_type ?? "")
  const isSuperAdmin = userRow.user_type === "superadmin"

  // MLS NUMBER — the kernel's launch gate blocks on it (validateListingLaunchReadiness),
  // but this page never read the column, so the checklist showed "ready to launch"
  // while the kernel refused. The blocker the agent hits was invisible until they
  // hit it. It is readable from three places, in this order of authority:
  //   1. listings.mls_number — entered by the agent or stamped by launchListing.
  //   2. a RentCast property search that matched this address (mlsNumber/mlsName).
  //   3. an IDX feed the brokerage connected (raw field mlsID).
  // Only (1) is stored. (2) and (3) are SUGGESTIONS surfaced at launch time —
  // never auto-written, because matching an address to a feed row is a fuzzy
  // key and syndicating the wrong MLS number is not a recoverable mistake.
  const mlsNumber = ((listing as any).mls_number as string | null)?.trim() || null
  const mlsLink = ((listing as any).mls_link as string | null)?.trim() || null
  const hasMlsNumber = !!mlsNumber

  // ── COMPLIANCE BLOCKERS ────────────────────────────────────────────────────
  //
  // This was `complianceBlockers={[]}` — a hardcoded empty array — so the launch
  // checklist ALWAYS reported "0 compliance issues" and the compliance gate could
  // never block a launch. The capability was already there: auditListingDocuments
  // resolves the seller-side required-document checklist for the brokerage/team/
  // state and reports what is missing, splitting BLOCKING from warning.
  //
  // Only `missing_blocking` becomes a launch blocker. A `missing_warning` is a
  // document the brokerage wants but has explicitly not made a stop condition —
  // promoting it to a blocker here would be the OS inventing a rule the broker
  // did not set.
  //
  // A brokerage with no required-document config produces zero required docs and
  // therefore zero blockers, which is correct rather than a silent pass: it means
  // nothing has been declared required, not that everything is present.
  let complianceBlockers: string[] = []
  try {
    const { auditListingDocuments } = await import("@/lib/compliance/required-documents")
    const audit = await auditListingDocuments(supabase, {
      brokerageId:     userRow.brokerage_id,
      sellerContactId: listing.seller_contact_id ?? null,
      agentUserId:     user.id,
      stateCode:       listing.state ?? null,
      listingId:       listingId,
    })
    complianceBlockers = audit.missing_blocking.map(
      (c) => `Missing required document: ${String(c).replace(/_/g, " ")}`,
    )
  } catch (err) {
    // A failed audit must NOT read as "compliant". Surface it as a blocker so a
    // launch is held rather than waved through on an error — the whole point of
    // the gate is that silence is not consent.
    console.error("[listing lifecycle] compliance audit failed:", err)
    complianceBlockers = ["Compliance check could not run — resolve before launching"]
  }

  // Blockers
  const blockers: string[] = []
  if (!mediaReady) blockers.push(`Need at least 5 photos (${photoCount} uploaded)`)
  if (!publishReady) blockers.push("Missing required listing fields")
  if (!hasMlsNumber) blockers.push("No MLS number entered")
  blockers.push(...complianceBlockers)
  // Marketing tier is superadmin-controlled — only surface the blocker to superadmins
  if (!marketingReady && isSuperAdmin) blockers.push("No marketing tier selected")

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

        {/* Closed: Seller-to-Lifetime Celebration Card */}
        {currentStage === "CLOSED" && (
          <div className="rounded-lg border border-green-300 bg-green-50 p-4 mb-6">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="h-5 w-5 text-green-600 shrink-0" />
              <p className="font-semibold text-green-900">Listing Closed!</p>
            </div>
            <p className="text-sm text-green-700">
              {sellerContact?.first_name
                ? `${sellerContact.first_name} has been converted to a lifetime customer.`
                : "The seller has been converted to a lifetime customer."}{" "}
              Post-close touchpoints scheduled (3-day, 30-day, 6-month).
            </p>
            <div className="flex gap-2 mt-3 flex-wrap">
              {sellerContact?.id && (
                <Button size="sm" asChild>
                  <Link href={`/crm?contact=${sellerContact.id}`}>
                    View in CRM as Lifetime
                  </Link>
                </Button>
              )}
              <Button size="sm" variant="outline" asChild>
                <Link href="/lifetime-customers">Lifetime Customers</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Matching Buyers — on-demand listing→buyer smart match (System 5.1A) */}
        <div className="mb-4">
          <MatchingBuyersPanel listingId={listingId} />
        </div>

        {/* Listing Health Radar — daily-scored health for this active listing */}
        <div className="mb-4">
          <ListingHealthRadarPanel
            listingId={listingId}
            healthScore={healthScore as unknown as Parameters<typeof ListingHealthRadarPanel>[0]["healthScore"]}
            openInterventions={openInterventions as unknown as Parameters<typeof ListingHealthRadarPanel>[0]["openInterventions"]}
            scoreHistory={scoreHistory as unknown as Parameters<typeof ListingHealthRadarPanel>[0]["scoreHistory"]}
          />
        </div>

        {/* AI optimization recommendations. The panel owns its own generate
            control (it needs the transaction id — the table keys on it), and
            hides itself when there is neither a transaction nor a row. */}
        {(aiOptimizations.length > 0 || transactionId) && (
          <div className="mb-4">
            <AiOptimizationPanel optimizations={aiOptimizations} transactionId={transactionId} />
          </div>
        )}

        {/* Consolidated Launch Readiness Checklist (replaces strip + 6 cards) */}
        <div className="mb-6">
          <LaunchReadinessChecklist
            listingId={listingId}
            currentStage={currentStage}
            photoCount={photoCount}
            videoCount={videoCount}
            hasBranded={media.some((m: any) => m.is_branded)}
            hasUnbranded={media.some((m: any) => !m.is_branded)}
            requiredFields={requiredFields}
            complianceBlockers={complianceBlockers}
            packetReady={packetReady}
            currentTier={currentTier}
            isSuperAdmin={isSuperAdmin}
            sellerUpdateHasPendingDraft={false}
            openHouseEvent={scheduledEvent}
            openHousePromotionStatus={openHousePromotionStatus}
            openHouseRsvpCount={rsvpCount}
            hasNeighborhoodReport={hasNeighborhoodReport}
            neighborhoodName={neighborhoodReport?.neighborhood_name}
            pricingNarrativeReady={pricingNarrativeReady}
            hasListingAgreement={!!listingAgreement}
            agreementFullyExecuted={!!listingAgreement?.fully_executed_at}
            mlsNumber={mlsNumber}
            mlsLink={mlsLink}
            listingAddress={`${listing.address}${listing.city ? `, ${listing.city}` : ""}`}
            mediaReady={mediaReady}
            publishReady={publishReady}
            marketingReady={marketingReady}
            blockers={blockers}
          />
        </div>

        {/* Listing Forms Panel — loads listing-context forms for e-sign flow */}
        <div className="mb-6">
          <ListingFormsPanel
            listingId={listingId}
            state={listing.state ?? undefined}
            sellerName={sellerContact
              ? `${sellerContact.first_name ?? ""} ${sellerContact.last_name ?? ""}`.trim()
              : undefined}
            sellerEmail={(sellerContact as any)?.email ?? undefined}
          />
        </div>

        {/* Post-event action centers for completed open houses */}
        {pastOpenHouses.length > 0 && (
          <div className="space-y-4 mb-6">
            {pastOpenHouses.map((event: any) => (
              <OpenHousePostEventPanel
                key={event.id}
                event={event}
                attendees={event.attendees ?? []}
                listingId={listingId}
              />
            ))}
          </div>
        )}

        {/* Vendor section: assign button + bookings list */}
        <div className="mb-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Vendors
            </h3>
            <VendorBookingButton
              listingId={listingId}
              brokerageId={userRow.brokerage_id}
              vendors={listingVendors ?? []}
            />
          </div>
          {(listingVendorBookings ?? []).length > 0 && (
            <VendorBookingsPanel bookings={(listingVendorBookings ?? []) as any} />
          )}
        </div>

        {(currentStage === "COMING_SOON_PREP" ||
          currentStage === "COMING_SOON_ACTIVE" ||
          currentStage === "MEDIA_APPROVED" ||
          (currentStage as string) === "PRE_LISTING") && (
          <div className="mb-6">
            <ComingSoonCommandCard
              listingId={listingId}
              userId={user.id}
              brokerageId={userRow.brokerage_id}
              role={(userRow.user_type ?? "agent") as "agent" | "team_lead" | "admin" | "broker"}
              currentStage={currentStage}
              listingAddress={`${listing.address}, ${listing.city}, ${listing.state}`}
              listingStatus={(listing as any).status ?? ""}
              mediaApproved={mediaApproved}
              transactionId={transactionId}
            />
          </div>
        )}

        {/* Pre-listing workflow panel — shown for pre-active stages */}
        <PreListingWorkflowPanel
          listingId={listingId}
          currentStage={currentStage}
          vendorBookings={(listingVendorBookings ?? []).map((b: any) => ({
            service_type: b.service_type,
            status: b.status,
          }))}
          tasks={(tasks ?? []).map((t: any) => ({ title: t.title, status: t.status }))}
          goLiveDate={listing.go_live_date ?? null}
        />

        <DecisionHistoryPanel listingId={listingId} />

        <div className="mb-6">
          <ListingPacketPanel
            listingId={listingId}
            agentId={user.id}
            brokerageId={userRow.brokerage_id}
            listing={listing}
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
          canLaunch={mediaReady && publishReady && marketingReady && hasMlsNumber && complianceBlockers.length === 0}
          blockers={blockers}
          isSuperAdmin={isSuperAdmin}
        />
        <PriceReductionSheet
          listingId={listingId}
          currentPrice={listing.list_price ?? 0}
          listingAddress={`${listing.address}, ${listing.city}`}
          agentId={user.id}
          brokerageId={userRow.brokerage_id}
          status={(listing as any).status ?? null}
        />
        <NeighborNotificationCard
          listingId={listingId}
          brokerageId={userRow.brokerage_id}
          agentUserId={user.id}
          sellerContactId={listing.seller_contact_id ?? null}
        />
        <StageTimeline
          listing={listing}
          lifecycleEvents={lifecycleEvents ?? []}
        />
      </aside>
    </div>
  )
}
