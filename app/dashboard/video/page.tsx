import { redirect } from "next/navigation"
import { createServerClient } from "@/lib/supabase/server"
import { VideoProjectList } from "@/app/components/features/video/VideoProjectList"
import { ScriptEditor } from "@/app/components/features/video/ScriptEditor"
import { GenerationSettings } from "@/app/components/features/video/GenerationSettings"
import { VideoPreview } from "@/app/components/features/video/VideoPreview"
import { DistributionControls } from "@/app/components/features/video/DistributionControls"

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

  return (
    <div className="container mx-auto py-8">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-2">Video Generation Hub</h1>
        <p className="text-muted-foreground">Create, customize, and distribute AI-powered property videos</p>
      </div>

      <div className="grid gap-8">
        <VideoProjectList brokerageId={profile.brokerage_id} />
        <ScriptEditor projectId="sample-project-id" />
        <GenerationSettings projectId="sample-project-id" />
        <VideoPreview projectId="sample-project-id" />
        <DistributionControls projectId="sample-project-id" />
      </div>
    </div>
  )
}
