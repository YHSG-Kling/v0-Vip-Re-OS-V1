import { createClient } from "@/lib/supabase/server"
import { notFound, redirect } from "next/navigation"
import { getAllStages, getStageDefinition, getEnabledSystemGates } from "@/lib/listing-lifecycle/lifecycle-definitions"
import type { ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { StagePipeline }       from "./components/stage-pipeline"
import { TasksPanel }           from "./components/tasks-panel"
import { StageTimeline }        from "./components/stage-timeline"
import { SellerCoachingCard }   from "./components/seller-coaching-card"

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
        <SellerCoachingCard
          listingId={listingId}
          listingStage={currentStage}
          brokerageId={userRow.brokerage_id}
          agentUserId={user.id}
        />
        <TasksPanel tasks={tasks ?? []} listingId={listingId} />
      </main>

      {/* RIGHT — Timeline (300px) */}
      <aside className="w-[300px] flex-shrink-0 border-l border-border overflow-y-auto bg-card">
        <StageTimeline
          listing={listing}
          lifecycleEvents={lifecycleEvents ?? []}
        />
      </aside>
    </div>
  )
}
