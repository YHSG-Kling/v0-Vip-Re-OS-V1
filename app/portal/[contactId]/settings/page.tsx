import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PortalSettingsPage from "@/components/portal/PortalSettingsPage"

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contactId).single()

  if (error || !contact) {
    redirect("/")
  }

  return <PortalSettingsPage contact={contact} contactId={contactId} />
}
