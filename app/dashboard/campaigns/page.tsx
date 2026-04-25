import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"

export default async function CampaignsHubRedirect() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userRow?.brokerage_id) redirect("/dashboard/onboarding")

  redirect("/dashboard/marketing/studio?tab=campaigns")
}
