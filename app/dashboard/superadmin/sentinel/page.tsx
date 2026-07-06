import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { OsSentinelBoard } from "./os-sentinel-board"

export const dynamic = "force-dynamic"

// Platform-staff "state of the whole agentic OS" board.
export default async function OsSentinelPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isStaff = ["superadmin", "support"].includes((data as any)?.user_type) || ["superadmin", "support"].includes((data as any)?.platform_role)
  if (!isStaff) redirect("/dashboard")

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">OS Sentinel</h1>
        <p className="text-muted-foreground text-sm">One view of the whole agentic OS — every subsystem, the top open incidents, and the self-healing that keeps it running.</p>
      </div>
      <OsSentinelBoard />
    </div>
  )
}
