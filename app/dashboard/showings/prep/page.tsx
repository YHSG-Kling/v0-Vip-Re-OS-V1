import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadUpcomingShowingsForAgent } from "./actions"
import { ShowingPrepListClient } from "./prep-list-client"

export const metadata = {
  title: "Showing Prep · VIP Real Estate OS",
  description: "Every upcoming showing with an AI-generated 1-pager you can read in the car.",
}

export default async function ShowingPrepListPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadUpcomingShowingsForAgent()
  if ("error" in result) redirect("/dashboard/agent/setup")

  return <ShowingPrepListClient rows={result.rows} />
}
