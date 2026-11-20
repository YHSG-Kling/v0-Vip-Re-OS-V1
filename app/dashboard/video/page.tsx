import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { mayUseFeature } from "@/lib/billing/billing-access"

export default async function VideoHubRedirect() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const access = await mayUseFeature(user.id, "video_generation")
  if (!access.allowed) {
    redirect("/dashboard?upgrade=video_generation")
  }

  redirect("/dashboard/videos/library")
}
