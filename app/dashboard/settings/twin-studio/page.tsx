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
import Link from "next/link"
import { listMyTwins, listPendingApprovals } from "@/app/actions/twin-studio"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { TwinStudioClient } from "./twin-studio-client"
import { Skeleton } from "@/app/components/ui/skeleton"

export const dynamic = "force-dynamic"

// TRUE ADMIN GATE (operational approval surface, team_lead already included) —
// repointed to the ONE tenant roster below. 'superadmin' was dead: 0 live rows
// store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

async function loadData() {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return { ok: false as const, twins: [], pending: [], canApprove: false }
  }
  const canApprove = isAdminOrBroker({ user_type: ctx.userType })

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

      {/* YOUR TWIN IS NOT YOUR ASSISTANT. The twins above are the agent's own
          likeness and voice. The AI assistant is a separate persona with its
          own face and voice, and the agent chooses that one too — it just
          lives on its own pages. Both were unreachable from here, which is how
          an agent ends up believing the assistant has no options at all. */}
      <div className="mt-10 border-t pt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href="/dashboard/agent/ai-identity"
          className="rounded-lg border p-4 hover:bg-muted/40 transition-colors"
        >
          <p className="text-sm font-medium">Your AI assistant&apos;s face &amp; voice</p>
          <p className="text-xs text-muted-foreground mt-1">
            The assistant is its own persona, not your twin. Pick its voice from the stock library
            and generate its headshot.
          </p>
        </Link>
        <Link
          href="/dashboard/settings/assistant"
          className="rounded-lg border p-4 hover:bg-muted/40 transition-colors"
        >
          <p className="text-sm font-medium">What you hear and see</p>
          <p className="text-xs text-muted-foreground mt-1">
            Choose the voice your assistant uses when it talks to <em>you</em>, and which of your
            twins fronts your own brief.
          </p>
        </Link>
      </div>
    </div>
  )
}
