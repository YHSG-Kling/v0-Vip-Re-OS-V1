import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"

export default async function VideoHubRedirect() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const access = await canAccessFeature(user.id, "video_generation")
  if (!access.allowed) {
    redirect("/dashboard?upgrade=video_generation")
  }

  redirect("/dashboard/videos/library")
}
