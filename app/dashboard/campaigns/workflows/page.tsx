import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { WorkflowBuilderClient } from "./workflow-builder-client"

export const metadata = {
  title: "Workflow Builder | VIP Real Estate OS",
  description: "Build multi-step outreach workflows with email, SMS, direct mail, waits, and conditions.",
}

export default async function WorkflowBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>
}) {
  const { id } = await searchParams

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Load existing sequence if editing
  let sequence: any = null
  let steps: any[] = []
  if (id) {
    const { data: seq } = await service
      .from("campaign_sequences")
      .select("*")
      .eq("id", id)
      .eq("brokerage_id", profile.brokerage_id)
      .maybeSingle()
    sequence = seq

    const { data: stepRows } = await service
      .from("campaign_sequence_steps")
      .select("*")
      .eq("sequence_id", id)
      .order("step_number", { ascending: true })
    steps = stepRows ?? []
  }

  return (
    <WorkflowBuilderClient
      brokerageId={profile.brokerage_id}
      userId={user.id}
      userType={profile.user_type ?? "agent"}
      initialSequence={sequence}
      initialSteps={steps}
    />
  )
}
