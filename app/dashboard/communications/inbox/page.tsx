import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getConversations } from "@/app/actions/ai-communication-hub"
import InboxClient from "./InboxClient"

export const metadata = {
  title: "Inbox | VIP Real Estate OS",
  description: "Unified communications inbox — email, SMS, in-app, voice",
}

export default async function InboxPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Resolve user profile → brokerageId, agentId, assistant_wake_name, role
  const service = createServiceClient()

  const [profileRes, agentRes] = await Promise.all([
    service
      .from("users")
      .select("id, brokerage_id, user_type, assistant_wake_name")
      .eq("id", user.id)
      .single(),
    service
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  const profile = profileRes.data
  if (!profile?.brokerage_id) redirect("/onboarding")

  const brokerageId: string  = profile.brokerage_id
  const assistantName: string = profile.assistant_wake_name ?? "VIP"
  const role: string          = profile.user_type ?? "agent"
  const agentId = await resolveAgentId(service, user.id)
  if (!agentId) redirect("/onboarding")

  // Fetch conversations + email_templates in parallel
  const [conversationsResult, templatesRes] = await Promise.all([
    getConversations({ brokerageId, limit: 100 }),
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
      conversations={conversations}
      emailTemplates={emailTemplates}
      brokerageId={brokerageId}
      agentId={agentId}
      userId={user.id}
      role={role}
      assistantName={assistantName}
    />
  )
}
