import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import {
  HandoffsCockpitClient,
  type HandoffContact,
} from "./handoffs-cockpit-client"

export const metadata = {
  title: "Handoff Cockpit",
  description: "AI-to-human handoffs and conversation ownership",
}

// ── Derive handoff state from contact data ────────────────────────────────────

function getHandoffState(
  callStopFlag: boolean | null,
  lastAnalysis: HandoffContact["lastAnalysis"],
  pendingDraft: HandoffContact["pendingDraft"]
): HandoffContact["handoffState"] {
  if (callStopFlag) return "compliance_hold"

  if (lastAnalysis) {
    if (
      (lastAnalysis.urgency_score !== null && lastAnalysis.urgency_score >= 80) ||
      lastAnalysis.sentiment === "negative" ||
      lastAnalysis.suggested_next_action === "escalate_to_human"
    ) {
      return "human_required"
    }
  }

  if (pendingDraft) return "ai_waiting_approval"

  return "ai_handling"
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function HandoffCockpitPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

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
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId: string = profile.brokerage_id
  const role: string = profile.user_type ?? "agent"

  const agentId = await resolveAgentId(service, user.id)
  if (!agentId) redirect("/dashboard/onboarding")

  // ── Data load ────────────────────────────────────────────────────────────

  // Build base query — admins see all, agents see their own contacts
  let contactsQuery = service
    .from("contacts")
    .select(`
      id,
      first_name,
      last_name,
      contact_type,
      call_stop_flag,
      preferred_channel,
      voice_calls (
        id,
        call_analyses (
          urgency_score,
          sentiment,
          suggested_next_action
        )
      ),
      ai_message_drafts (
        id,
        draft_body,
        channel,
        status
      )
    `)
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(50)

  // Agents see only their own contacts
  if (role === "agent") {
    contactsQuery = contactsQuery.eq("agent_id", agentId)
  }

  const { data: rawContacts, error } = await contactsQuery

  if (error) {
    console.error("[HandoffCockpit] Failed to load contacts:", error.message)
  }

  // ── Shape data ────────────────────────────────────────────────────────────

  const contacts: HandoffContact[] = (rawContacts ?? []).map((c: any) => {
    // Get the most recent call's most recent analysis
    const sortedCalls: any[] = (c.voice_calls ?? []).sort(
      (a: any, b: any) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )
    const lastCall = sortedCalls[0]
    const lastAnalysis =
      lastCall?.call_analyses?.[0]
        ? {
            urgency_score: lastCall.call_analyses[0].urgency_score ?? null,
            sentiment: lastCall.call_analyses[0].sentiment ?? null,
            suggested_next_action: lastCall.call_analyses[0].suggested_next_action ?? null,
          }
        : null

    // Find the oldest pending AI draft
    const pendingDraft =
      (c.ai_message_drafts ?? []).find((d: any) => d.status === "pending") ?? null
    const shapedDraft = pendingDraft
      ? {
          id: pendingDraft.id,
          draft_body: pendingDraft.draft_body ?? null,
          channel: pendingDraft.channel ?? null,
        }
      : null

    const handoffState = getHandoffState(c.call_stop_flag, lastAnalysis, shapedDraft)

    return {
      id: c.id,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      contact_type: c.contact_type ?? null,
      preferred_channel: c.preferred_channel ?? null,
      call_stop_flag: c.call_stop_flag ?? null,
      lastAnalysis,
      pendingDraft: shapedDraft,
      handoffState,
    } satisfies HandoffContact
  })

  // Count contacts requiring human attention for the page heading
  const humanRequiredCount = contacts.filter((c) => c.handoffState === "human_required").length

  return (
    <main className="container mx-auto max-w-7xl px-4 py-6 space-y-6">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Handoff Cockpit</h1>
          {humanRequiredCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-bold text-white">
              {humanRequiredCount}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          AI-to-human handoffs and conversation ownership
        </p>
      </div>

      {/* Summary stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: "Needs Human",
            count: contacts.filter((c) => c.handoffState === "human_required").length,
            color: "text-red-600",
          },
          {
            label: "Awaiting Approval",
            count: contacts.filter((c) => c.handoffState === "ai_waiting_approval").length,
            color: "text-amber-600",
          },
          {
            label: "Compliance Hold",
            count: contacts.filter((c) => c.handoffState === "compliance_hold").length,
            color: "text-gray-600",
          },
          {
            label: "AI Handling",
            count: contacts.filter((c) => c.handoffState === "ai_handling").length,
            color: "text-blue-600",
          },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.count}</p>
          </div>
        ))}
      </div>

      {/* Interactive list */}
      <HandoffsCockpitClient
        contacts={contacts}
        agentId={agentId}
        brokerageId={brokerageId}
      />
    </main>
  )
}
