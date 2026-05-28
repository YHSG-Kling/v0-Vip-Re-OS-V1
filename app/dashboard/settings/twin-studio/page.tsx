/**
 * Twin Studio — agent's AI digital-twin library.
 *
 * Tier visibility:
 *   - solo agent: My Twins
 *   - team lead:  My Twins + Approval Queue (team-scoped)
 *   - broker / admin / superadmin: My Twins + Approval Queue (brokerage-scoped)
 *
 * No vendor names ever shown to the user — everything is "Twin", "Voice clone",
 * "Avatar". Internally backed by D-ID + ElevenLabs through platform keys.
 */

import { Suspense } from "react"
import { listMyTwins, listPendingApprovals } from "@/app/actions/twin-studio"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { TwinStudioClient } from "./twin-studio-client"
import { Skeleton } from "@/app/components/ui/skeleton"

export const dynamic = "force-dynamic"

const APPROVAL_ROLES = ["broker", "admin", "superadmin", "team_lead"]

async function loadData() {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return { ok: false as const, twins: [], pending: [], canApprove: false }
  }
  const canApprove = APPROVAL_ROLES.includes(ctx.userType)

  const [{ twins }, pendingRes] = await Promise.all([
    listMyTwins(),
    canApprove ? listPendingApprovals() : Promise.resolve({ twins: [] }),
  ])

  return {
    ok: true as const,
    twins,
    pending: pendingRes.twins,
    canApprove,
    userType: ctx.userType,
  }
}

export default async function TwinStudioPage() {
  const data = await loadData()

  if (!data.ok) {
    return <div className="p-6 text-sm text-muted-foreground">Sign in to manage your twins.</div>
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Twin Studio</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your AI digital twin shows up wherever your clients are — in their portal, on your
          embedded chat, in videos, and on calls. Set up several looks for different occasions.
        </p>
      </div>

      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <TwinStudioClient
          twins={data.twins}
          pending={data.pending}
          canApprove={data.canApprove}
        />
      </Suspense>
    </div>
  )
}
