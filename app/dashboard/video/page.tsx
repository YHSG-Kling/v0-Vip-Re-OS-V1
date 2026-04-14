import { redirect } from "next/navigation"
import { createServerClient } from "@/lib/supabase/server"
import { getVideoProjects } from "@/app/actions/video/create-video-project"
import VideoHubClient from "./VideoHubClient"

export const metadata = {
  title: "Video Generation Hub",
  description: "Create, customize, and distribute AI-generated videos",
}

export default async function VideoPage() {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/auth/login")
  }

  // Get user's brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    redirect("/onboarding")
  }

  // Check if user has video generation capability
  const { data: entitlement } = await supabase
    .from("feature_access_overrides")
    .select("*")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("feature_key", "video_generation")
    .maybeSingle()

  if (!entitlement) {
    return (
      <div className="container mx-auto py-12">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-3xl font-bold mb-4">Video Generation</h1>
          <p className="text-muted-foreground mb-6">
            Video generation is not available on your current plan. Upgrade to access this feature.
          </p>
        </div>
      </div>
    )
  }

  // Fetch real projects for this brokerage/user
  const projects = await getVideoProjects(profile.brokerage_id, user.id)

  return (
    <VideoHubClient
      initialProjects={projects}
      brokerageId={profile.brokerage_id}
      userId={user.id}
    />
  )
}
