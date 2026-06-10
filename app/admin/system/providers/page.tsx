import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ProvidersClient } from "./providers-client"

export const dynamic = "force-dynamic"

// Super-admin-only page for system-level provider API credentials
// (scraping + AI media + property data). These credentials are
// platform-wide, not per-agent.
export default async function SystemProvidersPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()

  const resolvedType = profile?.user_type ?? profile?.role ?? ""
  if (resolvedType !== "superadmin") {
    redirect("/dashboard")
  }

  // Determine which provider env vars are configured (server-only check —
  // the value itself is never sent to the client).
  const configured: Record<string, boolean> = {
    zenrows: !!process.env.ZENROWS_API_KEY,
    batchdata: !!process.env.BATCHDATA_API_KEY,
    apify: !!process.env.APIFY_API_KEY,
    did: !!process.env.DID_API_KEY,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    housecanary: !!(
      process.env.HOUSECANARY_API_KEY || process.env.HOUSECANARY_API_SECRET
    ),
  }

  return <ProvidersClient configured={configured} />
}
