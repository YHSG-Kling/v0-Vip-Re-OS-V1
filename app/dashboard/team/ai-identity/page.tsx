import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AIIdentityEditor } from "@/app/components/ai-identity/AIIdentityEditor"
import { getAIIdentityProfile, getParentAIIdentityProfile } from "@/app/actions/ai-identity"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Identity | Team",
  description: "Configure your team's AI assistant voice and personality",
}

export default async function TeamAIIdentityPage() {
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
    .select("id, user_type, brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()

  // Role gate: team_lead + admin + broker
  if (!profile?.brokerage_id || !profile.team_id || !isAdminOrBroker({ user_type: profile.user_type || "" })) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id
  const teamId = profile.team_id

  // Get brokerage and team names
  const [{ data: brokerage }, { data: team }] = await Promise.all([
    supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
    supabase.from("teams").select("name").eq("id", teamId).maybeSingle(),
  ])

  // Load team profile + parent brokerage profile
  const [{ data: existingProfile }, { data: parentProfile }] = await Promise.all([
    getAIIdentityProfile("team", teamId),
    getParentAIIdentityProfile("team", brokerageId),
  ])

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">AI Identity Studio</h1>
        <p className="text-muted-foreground mt-1">
          Customize the AI assistant voice for {team?.name ?? "your team"}. Override brokerage
          defaults or add team-specific knowledge. Agents on your team can further customize their
          AI if needed.
        </p>
      </div>

      <AIIdentityEditor
        scope="team"
        scopeId={teamId}
        brokerageId={brokerageId}
        brokerageName={brokerage?.name ?? undefined}
        teamName={team?.name ?? undefined}
        initialProfile={existingProfile}
        parentProfile={parentProfile}
      />
    </div>
  )
}
