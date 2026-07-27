// app/dashboard/settings/widget/page.tsx
// Agent / broker widget & AI identity configuration page.
// Loads real agent + ai_identity_profile rows and passes to client component.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import WidgetSettingsClient from "./widget-settings-client"
import { ChatWidgetScopeCard } from "@/app/components/settings/ChatWidgetScopeCard"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = { title: "Widget & AI Settings" }

export default async function WidgetSettingsPage() {
  const supabase = await createClient()
  const service = createServiceClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Resolve the user's profile
  const { data: profile } = await service
    .from("users")
    .select("id, user_type, brokerage_id, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) redirect("/dashboard")

  // Only internal staff can access this page
  const ALLOWED_TYPES = ["agent","broker","admin","superadmin","tc","team_lead","isa","compliance_officer"]
  if (!ALLOWED_TYPES.includes(profile.user_type ?? "")) redirect("/dashboard")

  const brokerageId = profile.brokerage_id

  // Load agent record (may not exist for non-agent roles)
  const { data: agent } = await service
    .from("agents")
    .select("id, widget_embed_enabled, widget_position, user_id")
    .eq("user_id", user.id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // Load AI identity profile scoped to this agent (scope_type = 'agent', scope_id = agent.id)
  let aiIdentity = null
  if (agent?.id) {
    const { data } = await service
      .from("ai_identity_profiles")
      .select("id, assistant_name, persona_label, tone, formality_level, welcome_message, followup_style, avatar_url, active")
      .eq("scope_type", "agent")
      .eq("scope_id", agent.id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    aiIdentity = data
  }

  // If no agent-scoped identity, try brokerage-scoped
  if (!aiIdentity) {
    const { data } = await service
      .from("ai_identity_profiles")
      .select("id, assistant_name, persona_label, tone, formality_level, welcome_message, followup_style, avatar_url, active")
      .eq("scope_type", "brokerage")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    aiIdentity = data
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? ""

  return (
    <div className="space-y-6">
      <WidgetSettingsClient
      userId={user.id}
      brokerageId={brokerageId}
      agentId={agent?.id ?? null}
      widgetEnabled={agent?.widget_embed_enabled ?? false}
      widgetPosition={(agent?.widget_position as "right" | "left") ?? "right"}
      aiIdentity={aiIdentity}
      appUrl={appUrl}
      />

      {/* Whose identity the conversation carries — moved off the orphaned
          /settings/global page, which was the only place this could be set.
          The client above owns the launcher's appearance and placement; this
          owns who is on the other end of it. */}
      <div className="rounded-lg border bg-card p-4">
        <ChatWidgetScopeCard />
      </div>
    </div>
  )
}
