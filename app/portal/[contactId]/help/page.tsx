import { Suspense } from "react"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import HelpPageContent from "@/components/portal/HelpPageContent"
import dynamic from "next/dynamic"

// Staff-only panel (wave 155, 155F) — a dynamic import, so a client's Help page load never carries it.
const QuestionReplies = dynamic(() => import("./question-replies").then((m) => m.QuestionReplies))

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

  // WAVE 155 (lane 155F, F1.6 / F1.7): a STAFF viewer of this client's portal (same tenant; never the client, never a vendor)
  // sees the client's open portal questions the assistant could not confirm, and records the outside party's reply here. The
  // read is the session client (RLS) pinned to the contact's tenant; the action re-gates the seat before anything is written.
  let openQuestions: Array<{ id: string; title: string; question: string | null }> = []
  const { data: { user: viewerAuth } } = await supabase.auth.getUser()
  if (viewerAuth && contact.brokerage_id) {
    const { data: viewer } = await supabase.from("users").select("user_type, brokerage_id").eq("id", viewerAuth.id).maybeSingle()
    if (viewer && !["contact", "vendor"].includes(String(viewer.user_type)) && viewer.brokerage_id === contact.brokerage_id) {
      const { data: qt, error: qtErr } = await supabase.from("tasks").select("id, title, description, tags")
        .eq("brokerage_id", contact.brokerage_id).eq("contact_id", contactId).eq("source", "portal_question").neq("status", "completed").limit(20)
      if (qtErr) console.error(`[portal/help] open client questions not read: ${qtErr.message}`)
      openQuestions = ((qt ?? []) as Array<{ id: string; title: string | null; description: string | null; tags: string[] | null }>)
        .filter((t) => (t.tags ?? []).some((x) => x.startsWith("pq_fact:")))
        .map((t) => ({ id: t.id, title: t.title ?? "Client question", question: t.description?.match(/Question \(exact\): "([\s\S]*?)"\n/)?.[1] ?? null }))
    }
  }

  return (
    <Suspense fallback={null}>
      {openQuestions.length > 0 && <QuestionReplies tasks={openQuestions} />}
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
