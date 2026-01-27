import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { CollaborativeSearchDashboard } from "@/components/portal/CollaborativeSearchDashboard"

// Personas that support family/collaborative search
const FAMILY_SEARCH_PERSONAS = [
  "first_time_buyer",
  "military_buyer",
  "upsizing",
  "relocating",
  "repeat_buyer",
]

export default async function CollaborativeSearchPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

  if (!contact) {
    redirect("/")
  }

  // Redirect non-family personas to their properties page
  const persona = contact.contact_persona || "first_time_buyer"
  if (!FAMILY_SEARCH_PERSONAS.includes(persona)) {
    redirect(`/portal/${contactId}/properties`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Family Home Search</h1>
        <p className="text-muted-foreground mt-1">Collaborate with family members to find your perfect home together</p>
      </div>

      <CollaborativeSearchDashboard contactId={contactId} contactEmail={contact.email} />
    </div>
  )
}
