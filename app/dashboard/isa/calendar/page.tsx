import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { CalendarShell } from "@/app/dashboard/calendar/components/os"

export const metadata = {
  title: "AI ISA Calendar | Dashboard",
  description: "Appointments the AI ISA booked, and follow-ups - filtered view of Calendar OS",
}

/**
 * AI ISA Calendar - A filtered view of the unified Calendar OS
 *
 * Lane 88B (owner, wave 88: "Isa is a system ai ai isa."): the ISA is the platform's AI ISA acting
 * through the brokerage's system identity (lib/auth/isa-actor.ts) — there is no human ISA seat whose
 * personal calendar this is. The page is the human staff's lens ON the AI ISA's bookings
 * (calendar_events isa_appointment / listing_appointment, read tenant-wide by getAppointments from
 * the SESSION) plus the viewer's own follow-ups.
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
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile || !profile.brokerage_id) {
    redirect("/dashboard/onboarding")
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
