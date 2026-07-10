import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadShowingBriefing } from "../actions"
import { ShowingBriefClient } from "./brief-client"

interface PageProps { params: Promise<{ showingId: string }> }

export const metadata = {
  title: "Showing Brief",
}

export default async function ShowingBriefPage({ params }: PageProps) {
  const { showingId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadShowingBriefing(showingId)
  if ("error" in result) redirect("/dashboard/showings/prep")

  return (
    <ShowingBriefClient
      showingId={showingId}
      briefing={result.briefing}
      showingScheduledAt={result.showingScheduledAt}
    />
  )
}
