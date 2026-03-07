import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PersonaWelcomeHero from "@/components/portal/PersonaWelcomeHero"
import PersonaWidgetGrid from "@/components/portal/PersonaWidgetGrid"
import PersonaDashboardTabs from "@/components/portal/PersonaDashboardTabs"
import { getPersonaConfig, getPersonaJourneyStages, calculateJourneyProgress } from "@/lib/portal"

export default async function PortalHomePage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params

  const supabase = await createClient()

  const { data: contact, error } = await supabase
    .from("contacts")
    .select(`
      *,
      listings (*),
      transactions (
        *,
        transaction_milestones (*)
      )
    `)
    .eq("id", contactId)
    .single()

  if (!contact || error) {
    redirect("/")
  }

  // Fetch task completions and stage progress
  const [taskCompletionsResult, stageProgressResult] = await Promise.all([
    supabase
      .from("journey_task_completions")
      .select("*")
      .eq("contact_id", contactId)
      .order("completed_at", { ascending: false }),
    supabase
      .from("journey_stage_progress")
      .select("*")
      .eq("contact_id", contactId)
      .maybeSingle(),
  ])

  const taskCompletions = taskCompletionsResult.data || []
  const stageProgress = stageProgressResult.data

  const [showingsResult, documentsResult, messagesResult, savedPropertiesResult, offersResult] = await Promise.all([
    supabase
      .from("showing_requests")
      .select("*")
      .eq("contact_id", contactId)
      .order("confirmed_date", { ascending: true, nullsFirst: false })
      .limit(10),
    supabase
      .from("client_documents")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("client_portal_messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("saved_properties").select("*").eq("contact_id", contactId).limit(20),
    supabase.from("offers").select("*").eq("contact_id", contactId).order("created_at", { ascending: false }).limit(10),
  ])

  const showings = showingsResult.data || []
  const documents = documentsResult.data || []
  const messages = messagesResult.data || []
  const savedProperties = savedPropertiesResult.data || []
  const offers = offersResult.data || []
  const transactions = contact.transactions || []

  const persona = contact.contact_persona || "first_time_buyer"
  const config = getPersonaConfig(persona)
  const journeyStages = getPersonaJourneyStages(persona)

  const milestones = transactions
    .flatMap((t: { transaction_milestones?: unknown[] }) => t.transaction_milestones || [])
    .sort(
      (a: { milestone_date?: string }, b: { milestone_date?: string }) =>
        new Date(a.milestone_date || 0).getTime() - new Date(b.milestone_date || 0).getTime(),
    )

  // Use shared journey progress calculation
  const journeyProgress = calculateJourneyProgress(
    journeyStages,
    taskCompletions,
    stageProgress,
    milestones
  )

  return (
    <div className="space-y-6">
      {/* Personalized Welcome Hero */}
      <PersonaWelcomeHero 
        contact={contact} 
        journeyProgress={journeyProgress.progressPercent} 
        currentStageName={journeyProgress.currentStageName} 
      />

      {/* Persona-Specific Data Widgets */}
      <PersonaWidgetGrid
        contact={contact}
        transactions={transactions}
        milestones={milestones}
        showings={showings}
        savedProperties={savedProperties}
        offers={offers}
      />

      <PersonaDashboardTabs
        contact={contact}
        persona={persona}
        config={config}
        journeyStages={journeyProgress.stages}
        currentStageIndex={journeyProgress.currentStageIndex}
        pendingTasks={journeyProgress.pendingTasks}
        milestones={milestones}
        showings={showings}
        documents={documents}
        messages={messages}
        savedProperties={savedProperties}
        offers={offers}
        transactions={transactions}
        taskCompletions={taskCompletions}
      />
    </div>
  )
}
