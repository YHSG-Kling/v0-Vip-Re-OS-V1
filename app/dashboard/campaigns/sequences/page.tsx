import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { listCampaignSequences } from "@/app/actions/campaign-sequences"
import SequencesListClient from "./SequencesListClient"
import { AiSequenceDrafterCard } from "./ai-sequence-drafter-card"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Campaign Sequences",
  description: "Build and manage multi-step outreach sequences across email, SMS, video, and direct mail.",
}

export default async function CampaignSequencesPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const { sequences } = await listCampaignSequences(profile.brokerage_id)
  const params = await searchParams
  const openCreate = params.action === "create"

  // Inputs for the AI sequence drafter (aiGenerateDripCampaign). It models the
  // draft on a real contact's persona and timeline, and files the sequence under
  // an agents-class id. Both reads destructure their error: rendering "no
  // contacts" over a refused query would be a claim about the agent's book.
  const { data: agentRow, error: agentRowError } = await service
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()
  if (agentRowError) console.error("[sequences] agent lookup failed:", agentRowError.message)

  const { data: contactRows, error: contactRowsError } = await service
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(200)
  if (contactRowsError) console.error("[sequences] contact list read failed:", contactRowsError.message)

  const drafterContacts = (contactRows ?? []).map((c) => ({
    id: c.id as string,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact",
  }))

  return (
    <>
      {/* THE GENERATOR, REACHABLE AND DELIVERABLE. aiGenerateDripCampaign had no
          caller and wrote its touchpoints into drip_campaigns.metadata at status
          "paused" — a row the only consuming cron never reads, and whose content
          that cron explicitly refuses to send. It now drafts a real
          campaign_sequences row with real steps, inactive, for a human to
          review and launch. */}
      <div className="px-4 pt-4 md:px-6">
        <AiSequenceDrafterCard
          agentId={(agentRow?.id as string | undefined) ?? ""}
          contacts={drafterContacts}
        />
      </div>
      <SequencesListClient
        sequences={sequences}
        brokerageId={profile.brokerage_id}
        userId={user.id}
        openCreate={openCreate}
        pageType="marketing"
      />
    </>
  )
}
