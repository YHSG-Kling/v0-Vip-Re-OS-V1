import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { CalendarShell } from "./components/os"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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

  // Get agent record for brokerage context
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  // Lane 90A (89D P1-4, owner ruling): a tenant-admin seat without an agents row
  // (live 2026-09-29: admin 2, compliance_officer 1, team_lead 1, tc 1 seats
  // carry none) is NOT bounced to onboarding and is NOT provisioned an agents
  // row — the calendar falls back to BROKERAGE scope (the shell's reads are
  // tenant-keyed and run on the browser client under RLS). Any other seat
  // without an agents row still lands on onboarding, which self-heals an agent.
  let agentId: string | null = agentRow?.id ?? null
  let brokerageId: string | null = agentRow?.brokerage_id ?? null
  if (!agentRow) {
    const { data: seat } = await supabase
      .from("users")
      .select("user_type, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    if (!seat?.brokerage_id || !isAdminOrBroker({ user_type: seat.user_type })) {
      redirect("/dashboard/onboarding")
    }
    brokerageId = seat.brokerage_id
  }
  if (!brokerageId) {
    redirect("/dashboard/onboarding")
  }

  return (
    <main className="min-h-screen bg-background p-6">
      <CalendarShell
        agentId={agentId}
        brokerageId={brokerageId}
        defaultRole={agentId ? "agent" : "all"}
      />
    </main>
  )
}
