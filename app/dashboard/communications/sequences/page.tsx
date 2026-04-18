import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
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

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = profile.brokerage_id

  const agentId = await resolveAgentId(service, user.id)
  if (!agentId) redirect("/dashboard/onboarding")

  // Nurture sequence types — buyer/seller journeys, lead follow-up, post-close, sphere
  const NURTURE_SEQUENCE_TYPES = [
    "buyer_nurture",
    "seller_nurture",
    "lead_followup",
    "post_close",
    "sphere_touchpoint",
    "credit_journey",
  ]

  // Fetch existing nurture sequences for this brokerage
  // Table: campaign_sequences (NOT drip_campaigns — that table does not exist)
  const [campaignsRes, contactRes] = await Promise.all([
    service
      .from("campaign_sequences")
      .select(`
        id,
        name,
        trigger_event,
        sequence_type,
        is_active,
        enrollments_total,
        completions_total,
        conversions_total,
        compliance_gated,
        created_at,
        updated_at
      `)
      .eq("brokerage_id", brokerageId)
      .in("sequence_type", NURTURE_SEQUENCE_TYPES)
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

  // Map campaign_sequences columns to Campaign shape for SequencesClient
  const campaigns = (campaignsRes.data ?? []).map((row: any) => ({
    id:                    row.id,
    name:                  row.name,
    status:                row.is_active ? "active" : "paused",
    trigger_event:         row.trigger_event,
    target_lifecycle_state: row.sequence_type,
    total_steps:           row.completions_total ?? 0,
    enrolled_count:        row.enrollments_total ?? 0,
    created_at:            row.created_at,
    updated_at:            row.updated_at,
  }))
  const preContact = contactRes.data ?? null

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
