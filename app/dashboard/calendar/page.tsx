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

  // Get agent record for brokerage context
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agentRow) {
    redirect("/onboarding")
  }

  const agentId = agentRow.id
  const brokerageId = agentRow.brokerage_id

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
