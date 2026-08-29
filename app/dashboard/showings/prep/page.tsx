import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadUpcomingShowingsForAgent } from "./actions"
import { ShowingPrepListClient } from "./prep-list-client"

export const metadata = {
  title: "Showing Prep",
  description: "Every upcoming showing with an AI-generated 1-pager you can read in the car.",
}

export default async function ShowingPrepListPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await loadUpcomingShowingsForAgent()
  // /dashboard/agent/setup never had a page.tsx, so the recovery from "no agent
  // record" 404'd. Same destination as every other site with this branch:
  // the onboarding wizard (app/dashboard/communications/page.tsx:67).
  if ("error" in result) redirect("/dashboard/onboarding")

  return <ShowingPrepListClient rows={result.rows} />
}
