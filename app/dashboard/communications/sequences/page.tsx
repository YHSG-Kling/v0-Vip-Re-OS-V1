import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import SequencesClient from "./SequencesClient"

export const metadata = {
  title: "Sequences | VIP Real Estate OS",
  description: "AI-powered drip sequences and automated follow-up campaigns.",
}

export default async function SequencesPage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const params  = await searchParams

  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId = profile.brokerage_id

  const { data: agentRow } = await service
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId = agentRow?.id ?? user.id

  // Fetch existing drip campaigns / sequences for this brokerage
  const [campaignsRes, contactRes] = await Promise.all([
    service
      .from("drip_campaigns")
      .select(`
        id,
        name,
        status,
        trigger_event,
        target_lifecycle_state,
        total_steps,
        enrolled_count,
        created_at,
        updated_at
      `)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(50),

    // Optionally pre-load contact if contactId passed (from quick-action link)
    params.contactId
      ? service
          .from("contacts")
          .select("id, first_name, last_name, email, phone, lifecycle_state")
          .eq("id", params.contactId)
          .single()
      : Promise.resolve({ data: null }),
  ])

  const campaigns    = campaignsRes.data ?? []
  const preContact   = contactRes.data ?? null

  return (
    <SequencesClient
      campaigns={campaigns}
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      role={profile.user_type ?? "agent"}
      preContact={preContact}
    />
  )
}
