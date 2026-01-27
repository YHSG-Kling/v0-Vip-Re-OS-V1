import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { ShowingsManager } from "@/components/portal/ShowingsManager"

export default async function ShowingsPage({
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">My Showings</h1>
        <p className="text-muted-foreground mt-1">Schedule property tours and provide feedback</p>
      </div>

      <ShowingsManager contactId={contactId} />
    </div>
  )
}
