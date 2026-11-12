import { Suspense } from "react"
import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { MailDashboard } from "./mail-dashboard"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Direct Mail | VIP Agents AI",
  description: "Manage direct mail campaigns, recipients, tracking, and responses",
}

export default async function DirectMailPage() {
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const brokerageId = ctx.brokerageId

  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={<MailLoadingSkeleton />}>
        <MailDashboard brokerageId={brokerageId} />
      </Suspense>
    </div>
  )
}

function MailLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-10 w-32 bg-muted rounded animate-pulse" />
      </div>
      <div className="h-10 w-full max-w-md bg-muted rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
