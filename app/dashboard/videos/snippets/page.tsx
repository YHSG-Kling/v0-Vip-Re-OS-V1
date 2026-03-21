import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Scissors } from "lucide-react"
import { getVideoSnippets } from "@/app/actions/video-repurposing"
import SnippetsPageClient from "./snippets-page-client"

export const metadata = {
  title: "Video Snippets | VIP Re OS",
  description: "Create and manage platform-optimized video clips",
}

export default async function VideoSnippetsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Resolve brokerage_id from users table
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  const snippets = await getVideoSnippets({ brokerageId: profile.brokerage_id })

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-purple-100 rounded-lg p-2">
            <Scissors className="h-6 w-6 text-purple-600" />
          </div>
          <h1 className="text-3xl font-bold">Video Snippets</h1>
        </div>
        <p className="text-muted-foreground">
          Create platform-optimized clips from your videos to repurpose across social media
        </p>
      </div>

      <SnippetsPageClient
        snippets={snippets}
        brokerageId={profile.brokerage_id}
        userId={user.id}
      />
    </div>
  )
}
