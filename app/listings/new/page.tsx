import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export default async function NewListingPage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")
  redirect("/dashboard/listings?action=new")
}
