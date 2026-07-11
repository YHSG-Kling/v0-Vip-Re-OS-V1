"use client"

/**
 * EARNED AUTONOMY — the broker's grant ledger, beside the Trust Meter.
 * Every standing autonomy the AI team has EARNED (10 deal-file / 20
 * marketing consecutive approvals, zero declines), with the evidence it
 * was earned on, every act it has taken since, and a one-click revoke.
 * You can't fully trust what you can't see and take back — this is the
 * visibility half of the graduated-autonomy story.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShieldCheck, Loader2, Undo2 } from "lucide-react"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { revokeAutonomyGrantAction, type EarnedGrant } from "@/app/actions/document-kernel-review"

function describeShape(shape: string): string {
  if (shape.startsWith("social_post:")) return `Publish ${shape.split(":")[1]?.replace(/_/g, " ")} social posts on schedule`
  if (shape.startsWith("newsletter:")) return "Send AI newsletters on schedule"
  if (shape.startsWith("blog:")) return "Publish AI blog posts on schedule"
  if (shape.startsWith("deadline_correction:")) return `Correct the ${shape.split(":")[1]?.replace(/_/g, " ")} deadline from scanned documents`
  if (shape.startsWith("deadline_propose:")) return `Track the ${shape.split(":")[1]?.replace(/_/g, " ")} deadline from scanned documents`
  return shape.replace(/_/g, " ")
}

export function EarnedAutonomyPanel({ grants: initial }: { grants: EarnedGrant[] }) {
  const [grants, setGrants] = useState<EarnedGrant[]>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const revoke = (shape: string) => {
    setBusy(shape)
    startTransition(async () => {
      try {
        const r = await revokeAutonomyGrantAction({ shape })
        if (r.ok) setGrants((prev) => prev.filter((g) => g.shape !== shape))
      } finally {
        setBusy(null)
      }
    })
  }

  return (
    <Card className="border-l-4 border-l-emerald-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Earned autonomy</CardTitle>
            <CardDescription>
              Standing moves you granted from your own approval history — every act stays on the policy ledger; revoke any time
            </CardDescription>
          </div>
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
        </div>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing granted yet. When the team earns a move (10 straight deal-file approvals, 20 straight marketing approvals — zero declines), it proposes the grant on the feed.
          </p>
        ) : (
          <ul className="space-y-2">
            {grants.map((g) => {
              const label = g.managerKey in MANAGERS ? MANAGERS[g.managerKey as ManagerKey].label : g.managerKey
              return (
                <li key={g.shape} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{describeShape(g.shape)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {label}
                      {g.grantedAt ? ` · granted ${new Date(g.grantedAt).toLocaleDateString()}` : ""}
                      {g.earnedOn != null ? ` · earned on ${g.earnedOn}/${g.earnedOn} approvals` : ""}
                    </p>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">
                        {g.actsSince} autonomous act{g.actsSince === 1 ? "" : "s"} since
                      </Badge>
                    </div>
                  </div>
                  <Button
                    size="sm" variant="outline" className="h-7 shrink-0 text-xs gap-1"
                    disabled={busy !== null}
                    onClick={() => revoke(g.shape)}
                  >
                    {busy === g.shape ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                    Revoke
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
