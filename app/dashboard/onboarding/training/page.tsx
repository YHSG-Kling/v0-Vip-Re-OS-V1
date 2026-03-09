// ============================================================
// SYSTEM: L11-S04 — Training Video Library Page
// VIP Real Estate AI OS — Layer 11
// ============================================================
// ROUTE: app/dashboard/onboarding/training/page.tsx

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getTrainingVideos } from "@/app/actions/onboarding/training"
import { TrainingLibraryClient } from "./training-library-client"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: "Training Library | VIP Real Estate AI OS",
  description: "Complete your required training videos to unlock full platform access",
}

export default async function TrainingPage() {
  const supabase = await createClient()

  // Verify session
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  
  if (authError || !user) {
    redirect("/auth/login")
  }

  // Get user's brokerage context
  const { data: userData } = await supabase
    .from("users")
    .select("id, brokerage_id, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!userData?.brokerage_id) {
    redirect("/dashboard")
  }

  // Fetch training videos with progress
  const result = await getTrainingVideos()

  if (!result.success || !result.data) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          <p className="text-destructive">
            {result.error || "Failed to load training videos. Please try again."}
          </p>
        </div>
      </div>
    )
  }

  return (
    <TrainingLibraryClient
      videos={result.data.videos}
      requiredCount={result.data.requiredCount}
      completedRequiredCount={result.data.completedRequiredCount}
      progressPercent={result.data.progressPercent}
      userName={`${userData.first_name || ""} ${userData.last_name || ""}`.trim()}
    />
  )
}
