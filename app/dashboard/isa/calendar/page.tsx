import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { CalendarShell } from "@/app/dashboard/calendar/components/os"

export const metadata = {
  title: "ISA Calendar | Dashboard",
  description: "ISA appointments and follow-ups - filtered view of Calendar OS",
}

/**
 * ISA Calendar - A filtered view of the unified Calendar OS
 * 
 * This page is now a thin wrapper around Calendar OS with the ISA role pre-selected.
 * The unified calendar aggregates all time-sensitive items into one surface.
 * ISA-specific events (appointments, follow-ups) are filtered automatically.
 */
export default async function ISACalendarPage() {
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
        defaultRole="isa"
      />
    </main>
  )
}
