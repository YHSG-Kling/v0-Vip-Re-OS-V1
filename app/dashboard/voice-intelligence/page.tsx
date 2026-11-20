import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { VoiceIntelligenceClient, type CallRow } from "./voice-intelligence-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export default async function VoiceIntelligencePage() {
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
    .select("id, brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Resolve agent_id (the kernel sometimes uses a separate agents row)
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  // NOT `?? user.id` (m348) — voice_calls.agent_id FKs agents, so the users id
  // matched no calls and the page showed an empty call history as if it were real.
  const agentId = agentRow?.id ?? ""
  if (!agentId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Finishing your account setup — refresh in a moment to view your call intelligence.
      </div>
    )
  }

  // Recent calls — joined with the latest call_analyses row per call so
  // the list can show sentiment, intent, and outcome at a glance.
  const { data: callsRaw } = await supabase
    .from("voice_calls")
    .select(
      "id, brokerage_id, agent_id, contact_id, direction, status, call_type, phone_from, phone_to, duration_seconds, recording_url, transcription, summary, sentiment, outcome, started_at, ended_at, compliance_passed, compliance_flags",
    )
    .eq("brokerage_id", profile.brokerage_id)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(50)

  const calls = (callsRaw ?? []) as CallRow[]

  // Pull contact names in one batch.
  const contactIds = Array.from(new Set(calls.map((c) => c.contact_id).filter(Boolean) as string[]))
  let contactMap = new Map<string, { first_name: string | null; last_name: string | null }>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    for (const c of contacts ?? []) {
      contactMap.set(c.id, { first_name: c.first_name, last_name: c.last_name })
    }
  }
  const enrichedCalls = calls.map((c) => ({
    ...c,
    contact_name: c.contact_id
      ? `${contactMap.get(c.contact_id)?.first_name ?? ""} ${contactMap.get(c.contact_id)?.last_name ?? ""}`.trim() || null
      : null,
  }))

  return (
    <VoiceIntelligenceClient
      calls={enrichedCalls}
      agentId={agentId}
      brokerageId={profile.brokerage_id}
    />
  )
}
