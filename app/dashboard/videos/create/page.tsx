// Server component wrapper — checks HeyGen config and passes it to the client wizard.
// Tables read: none (env-var check only).

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

  // Check HeyGen API key from server environment — never exposed to client
  const heygenConfigured = !!process.env.HEYGEN_API_KEY

  return <VideoCreatePage heygenConfigured={heygenConfigured} />
}
