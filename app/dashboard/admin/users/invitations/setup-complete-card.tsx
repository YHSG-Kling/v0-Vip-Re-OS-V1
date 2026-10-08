"use client"

/**
 * "We're done setting up" — the only writer of
 * `brokerages.onboarding_status = 'completed'`.
 *
 * Wave 4 slice 2: `app/actions/admin/invitations.ts:markBrokerageSetupCompleteAction`
 * is the sole caller of `advanceBrokerageOnboarding(brokerageId, "completed")`
 * anywhere in the tree, and it had no caller of its own. The state machine could
 * therefore move a brokerage `pending → in_progress` (automatically, on the first
 * invited user's first login) and **never any further** — every real tenant sat
 * at `in_progress` forever, including in the superadmin brokerage console that
 * renders that column (`app/actions/superadmin/brokerage-management.ts`) and in
 * `v_brokerage_onboarding_progress`.
 *
 * This lives on the invitations page because that is the admin's onboarding hub:
 * it is already where you see who has been invited and who has actually landed.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Loader2, AlertTriangle, Flag } from "lucide-react"
import { markBrokerageSetupCompleteAction } from "@/app/actions/admin/invitations"

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: "Setup not started", cls: "bg-amber-100 text-amber-900" },
  in_progress: { label: "Setup in progress", cls: "bg-blue-100 text-blue-800" },
  completed: { label: "Setup complete", cls: "bg-emerald-100 text-emerald-800" },
  abandoned: { label: "Setup abandoned", cls: "bg-slate-100 text-slate-700" },
}

export function SetupCompleteCard({
  initialStatus,
  pendingCount,
}: {
  initialStatus: string | null
  pendingCount: number
}) {
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus ?? "pending")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const badge = STATUS_LABEL[status] ?? STATUS_LABEL.pending
  const done = status === "completed"

  function handleComplete() {
    setError(null)
    startTransition(async () => {
      // The fallback is annotated with the action's OWN return type. Without the
      // annotation TypeScript infers a narrower object for this arm, `r` becomes a
      // union whose second member has no `status`, and the read below stops
      // compiling — even though the action itself always returns one shape.
      const r = await markBrokerageSetupCompleteAction().catch(
        (): Awaited<ReturnType<typeof markBrokerageSetupCompleteAction>> => ({
          ok: false,
          error: "Could not reach the server",
        }),
      )
      if (!r.ok) {
        // The action refuses non-admin callers in words; show them rather than
        // flipping the badge on a write that did not happen.
        setError(r.error ?? "Could not mark setup complete")
        return
      }
      // Take the status the state machine actually returned, not "completed" —
      // the RPC decides what transition is legal.
      setStatus(r.status ?? status)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Flag className="h-4 w-4" />
              Brokerage setup
              <Badge className={badge.cls} variant="secondary">{badge.label}</Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              Declaring setup complete is what moves your brokerage out of onboarding.
              Until then your account reads as still being set up.
            </CardDescription>
          </div>
          {!done && (
            <Button size="sm" onClick={handleComplete} disabled={isPending}>
              {isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                <><CheckCircle2 className="h-4 w-4 mr-2" />Mark setup complete</>
              )}
            </Button>
          )}
        </div>
      </CardHeader>
      {(error || (!done && pendingCount > 0)) && (
        <CardContent className="pt-0 space-y-2 text-xs">
          {!done && pendingCount > 0 && (
            <p className="text-muted-foreground">
              {pendingCount} invitation{pendingCount === 1 ? " is" : "s are"} still pending. You
              can mark setup complete anyway — pending invites keep working.
            </p>
          )}
          {error && (
            <p className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 rounded p-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}
