import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getConversations } from "@/app/actions/ai-communication-hub"
import { getLeadInboxThreads } from "@/app/actions/inbox"
import InboxClient from "./InboxClient"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Inbox",
  description: "Unified communications inbox — email, SMS, in-app, voice",
}

export default async function InboxPage() {
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
  // Resolve user profile → brokerageId, agentId, assistant_wake_name, role
  const service = createServiceClient()

  const [profileRes, agentRes] = await Promise.all([
    service
      .from("users")
      .select("id, brokerage_id, user_type, assistant_wake_name")
      .eq("id", user.id)
      .maybeSingle(),
    service
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  const profile = profileRes.data
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId: string  = profile.brokerage_id
  const assistantName: string = profile.assistant_wake_name ?? "VIP"
  const role: string          = profile.user_type ?? "agent"
  const agentId = await resolveAgentId(service, user.id)
  if (!agentId) redirect("/dashboard/onboarding")

  // Fetch conversations + AI-ISA lead threads + email_templates in parallel
  const [conversationsResult, leadThreadsResult, templatesRes] = await Promise.all([
    getConversations({ brokerageId, limit: 100 }),
    getLeadInboxThreads({ limit: 50 }),
    // email_templates: DB column is template_type (not channel)
    service
      .from("email_templates")
      .select("id, name, subject, body, template_type")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("name"),
  ])

  const conversations = conversationsResult.success
    ? (conversationsResult as any).conversations ?? []
    : []

  // AI-ISA LEAD threads ride the same list, keyed `lead:<leads.id>` — leads are
  // NOT contacts. The ISA nurtures them (email / direct mail; leads can call in)
  // until positive intent converts them to a contact.
  const leadConversations = (leadThreadsResult.success ? leadThreadsResult.threads ?? [] : [])
    .filter((t) => t.party === "lead" && t.lead_id)
    .map((t) => ({
      id: `lead:${t.lead_id}`,
      type: t.channel,
      unread_count: t.unread_count ?? 0,
      last_message_at: t.last_message_at,
      last_message_preview: t.last_message_body,
      contacts: null,
      party: "lead" as const,
      lead_id: t.lead_id as string,
      lead_name: t.contact_name,
    }))
  // Map template_type → channel so client components can filter by channel
  const emailTemplates = (templatesRes.data ?? []).map((t: any) => ({
    id:      t.id,
    name:    t.name,
    subject: t.subject ?? undefined,
    body:    t.body ?? undefined,
    // template_type values include "email", "sms", "all" — treat as channel
    channel: t.template_type ?? "all",
  }))

  return (
    <InboxClient
      conversations={[...conversations, ...leadConversations]}
      emailTemplates={emailTemplates}
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      role={role}
      assistantName={assistantName}
    />
  )
}
