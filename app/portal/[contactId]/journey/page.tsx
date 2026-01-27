import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PersonalizedJourneyDashboard from "@/components/portal/PersonalizedJourneyDashboard"

export default async function PortalJourneyPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact with transactions and milestones
  const { data: contact, error } = await supabase
    .from("contacts")
    .select(`
      *,
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

  // Extract and flatten milestones from all transactions
  const milestones =
    contact.transactions
      ?.flatMap((t: { transaction_milestones?: unknown[] }) => t.transaction_milestones || [])
      .sort(
        (a: { milestone_date?: string }, b: { milestone_date?: string }) =>
          new Date(a.milestone_date || 0).getTime() - new Date(b.milestone_date || 0).getTime(),
      ) || []

  return (
    <PersonalizedJourneyDashboard 
      contact={contact} 
      milestones={milestones} 
      taskCompletions={taskCompletions}
      stageProgress={stageProgress}
    />
  )
}
