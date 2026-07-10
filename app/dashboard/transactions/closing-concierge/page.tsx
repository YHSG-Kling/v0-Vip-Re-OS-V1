import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { loadClosingConciergeBoard } from "./actions"
import { ClosingConciergeClient } from "./concierge-client"

export const metadata = {
  title: "Closing Concierge",
  description: "Every open transaction action across all your deals — AI draftss the email, you send it.",
}

/**
 * /dashboard/transactions/closing-concierge — the agent's "what's between
 * me and a clean close on every active deal" surface.
 *
 * Pulls from transaction_pending_actions (auto-populated every 6h by the
 * closing-orchestration cron). Each row is a typed orchestration event
 * with a suggested recipient + bucket-key idempotency.
 */
export default async function ClosingConciergePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const board = await loadClosingConciergeBoard()
  if ("error" in board) redirect("/dashboard/onboarding")

  return <ClosingConciergeClient board={board} />
}
