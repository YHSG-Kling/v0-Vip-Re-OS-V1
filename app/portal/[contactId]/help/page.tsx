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

  const { data: contact } = await supabase.from("contacts").select("*, agents:agent_id(*)").eq("id", contactId).single()

  if (!contact) {
    redirect("/")
  }

  return (
    <Suspense fallback={null}>
      <HelpPageContent contact={contact} contactId={contactId} />
    </Suspense>
  )
}
