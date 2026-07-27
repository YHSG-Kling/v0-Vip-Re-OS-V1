import { redirect, notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getCampaignSequence } from "@/app/actions/campaign-sequences"
import SequenceBuilderClient from "./SequenceBuilderClient"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const { sequence } = await getCampaignSequence(id)
  return {
    title: sequence ? `${sequence.name} | Sequence Builder` : "Sequence Builder",
    description: "Build and manage campaign sequence steps.",
  }
}

export default async function SequenceBuilderPage({ params, searchParams }: Props) {
  const { id }    = await params
  const { tab }   = await searchParams

  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()

  // User profile → role + brokerage
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId = profile.brokerage_id
  const role        = profile.user_type ?? "agent"

  // Fetch sequence, steps, enrollments
  const { sequence, steps, enrollments, error } = await getCampaignSequence(id)

  if (error || !sequence) notFound()

  // Verify brokerage ownership
  if (sequence.brokerage_id !== brokerageId) notFound()

  // Fetch email templates for template importer
  const { data: templates } = await service
    .from("email_templates")
    .select("id, name, subject, body, template_type")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("name")

  // Fetch feature flags for video + direct mail channel gating
  const { data: featureFlags } = await service
    .from("feature_flags")
    .select("feature_key, enabled, superadmin_only")
    .in("feature_key", ["video_campaigns", "direct_mail_campaigns"])

  const flagMap: Record<string, boolean> = {}
  for (const f of featureFlags ?? []) {
    flagMap[f.feature_key] = f.enabled === true && f.superadmin_only !== true
  }

  // Step executions for analytics (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: executions } = await service
    .from("sequence_step_executions")
    .select("step_id, status, channel, sent_at")
    .eq("sequence_id", id)
    .gte("sent_at", thirtyDaysAgo)

  return (
    <SequenceBuilderClient
      sequence={sequence}
      initialSteps={steps}
      enrollments={enrollments}
      executions={executions ?? []}
      emailTemplates={(templates ?? []).map((t: any) => ({
        id:            t.id,
        name:          t.name,
        subject:       t.subject ?? "",
        body:          t.body ?? "",
        template_type: t.template_type ?? "email",
      }))}
      featureFlags={flagMap}
      brokerageId={brokerageId}
      userId={user.id}
      role={role}
      defaultTab={tab === "analytics" ? "analytics" : "builder"}
    />
  )
}
