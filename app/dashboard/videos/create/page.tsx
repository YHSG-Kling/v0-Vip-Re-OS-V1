// Server component wrapper for the AI video wizard.
// The avatar/explainer video engine is D-ID + ElevenLabs ONLY.

import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import VideoCreatePage from "./video-create-client"

export const metadata = {
  title: "Create AI Video | Dashboard",
  description: "Generate professional avatar videos with AI script generation",
}

export default async function VideoCreateServerPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  return <VideoCreatePage />
}
