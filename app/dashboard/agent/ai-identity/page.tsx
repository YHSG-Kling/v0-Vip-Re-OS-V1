import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { AIIdentityEditor } from "@/app/components/ai-identity/AIIdentityEditor"
import { getAIIdentityProfile, getParentAIIdentityProfile } from "@/app/actions/ai-identity"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "AI Identity | Agent",
  description: "Personalize your AI assistant's voice and knowledge",
}

export default async function AgentAIIdentityPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/dashboard")
  }

  const brokerageId = profile.brokerage_id
  const agentId = user.id
  const teamId = profile.team_id

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
