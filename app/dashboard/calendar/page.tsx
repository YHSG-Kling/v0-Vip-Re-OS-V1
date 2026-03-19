import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { CalendarShell } from "./components/os"

export const metadata = {
  title: "Calendar OS | Dashboard",
  description: "Unified scheduling across all domains - showings, tours, transactions, and more",
}

export default async function CalendarPage() {
  const supabase = await createClient()

  // Get authenticated user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user profile for brokerage context
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile) {
    redirect("/onboarding")
  }

  const agentId = user.id
  const brokerageId = profile.brokerage_id

  return (
    <main className="min-h-screen bg-background p-6">
      <CalendarShell
        agentId={agentId}
        brokerageId={brokerageId}
        defaultRole="agent"
      />
    </main>
  )
}
