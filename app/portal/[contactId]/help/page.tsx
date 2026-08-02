import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import HelpPageContent from "@/components/portal/HelpPageContent"

export default async function HelpPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // `agents` carries NO name, email, or `phone` column — only phone_mobile /
  // phone_office, with the human's name and email on `users` via agents.user_id.
  // The help card read contact.agents?.name / .phone / .email off this row, so
  // all three were undefined on every load: the heading always said "Your Agent"
  // and the call button always rendered the hardcoded placeholder
  // "(555) 123-4567" — a fake phone number shipped to a real client, on the page
  // whose whole job is telling them how to reach their agent. Resolve the real
  // values here, the way the portal's messages page already does.
  const { data: contact } = await supabase
    .from("contacts")
    .select("*, agents:agent_id(id, user_id, phone_mobile, phone_office)")
    .eq("id", contactId)
    .single()

  if (!contact) {
    redirect("/")
  }

  const agentRow: any = Array.isArray(contact.agents) ? contact.agents[0] : contact.agents

  let agentName: string | null = null
  let agentEmail: string | null = null
  if (agentRow?.user_id) {
    const { data: agentUser } = await supabase
      .from("users")
      .select("first_name, last_name, email")
      .eq("id", agentRow.user_id)
      .maybeSingle()
    if (agentUser) {
      agentName = [agentUser.first_name, agentUser.last_name].filter(Boolean).join(" ") || null
      agentEmail = agentUser.email ?? null
    }
  }

  const agentPhone: string | null = agentRow?.phone_mobile ?? agentRow?.phone_office ?? null

  // The "urgent help" line was hardcoded to (800) 555-0199 — another invented
  // number on a client-facing page. The brokerage's own number is the real
  // answer, and the dashboard help centre already resolves it exactly this way.
  const { data: brokerage } = contact.brokerage_id
    ? await supabase.from("brokerages").select("name, phone").eq("id", contact.brokerage_id).maybeSingle()
    : { data: null }

  return (
    <Suspense fallback={null}>
      <HelpPageContent
        contact={contact}
        contactId={contactId}
        agentName={agentName}
        agentEmail={agentEmail}
        agentPhone={agentPhone}
        brokerageName={(brokerage?.name as string | null) ?? null}
        brokeragePhone={(brokerage?.phone as string | null) ?? null}
      />
    </Suspense>
  )
}
