import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AIIdentityEditor } from "@/app/components/ai-identity/AIIdentityEditor"
import { getAIIdentityProfile, getParentAIIdentityProfile } from "@/app/actions/ai-identity"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Identity | Agent",
  description: "Personalize your AI assistant's voice and knowledge",
}

export default async function AgentAIIdentityPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id
  const teamId = profile.team_id

  // agents.id, NOT the auth user id. ai_identity_profiles.scope_id at scope_type
  // 'agent' is an agents.id everywhere that matters: the public profile page, the
  // widget, the Twilio voice greeting, video identity and the ISA brand voice all
  // resolve it that way, and saveAIIdentityProfile authorises the write by looking
  // the scopeId up in `agents`. This page passed user.id, so every save came back
  // "Forbidden" and — had one landed — none of those surfaces would have read it.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agentRow?.id) {
    // ensureAgentContextInPlace ran above, so this is an account that genuinely
    // cannot self-provision (pending invite, or staff whose seat is not an agent).
    redirect("/dashboard")
  }

  const agentId = agentRow.id

  // Get brokerage and team names (if available)
  const [{ data: brokerage }, { data: team }] = await Promise.all([
    supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
    teamId
      ? supabase.from("teams").select("name").eq("id", teamId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  // Load agent profile + parent (team or brokerage)
  const [{ data: existingProfile }, { data: parentProfile }] = await Promise.all([
    getAIIdentityProfile("agent", agentId),
    getParentAIIdentityProfile("agent", brokerageId, teamId),
  ])

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My AI Identity</h1>
        <p className="text-muted-foreground mt-1">
          Personalize how your AI assistant represents you. Override team or brokerage defaults to
          match your personal style, add custom knowledge, or adjust guardrails for your contacts.
        </p>
      </div>

      <AIIdentityEditor
        scope="agent"
        scopeId={agentId}
        brokerageId={brokerageId}
        brokerageName={brokerage?.name ?? undefined}
        teamName={team?.name ?? undefined}
        initialProfile={existingProfile}
        parentProfile={parentProfile}
      />
    </div>
  )
}
