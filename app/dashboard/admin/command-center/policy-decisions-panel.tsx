"use client"

/**
 * POLICY DECISIONS — the kernel's amber/red verdict ledger, beside Earned
 * Autonomy. Every decision the document kernel and the marketing/policy lanes
 * recorded that was NOT a clean green: what it judged, why, and who has to
 * approve. Grouped by deal; the no-transaction rows (newsletter / social_post
 * / autonomy_grant / ai_identity) share the "unattached" bucket.
 *
 * READ-ONLY BY DESIGN — no resolve buttons here. Resolution lives on the
 * Command Center signals feed, keyed by manager_signals ids; a
 * policy_decisions.id is a ledger entry, not a resolvable signal, so a button
 * on this panel would have nothing to act on.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Scale } from "lucide-react"
import type { PolicyDecisionGroup } from "@/app/actions/document-kernel-review"

// Verdict colors — the compliance-ledger palette (SEV_BADGE in
// app/dashboard/admin/compliance-ledger/page.tsx): amber = advisory, red = blocked.
const DECISION_BADGE: Record<string, string> = {
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
}

export function PolicyDecisionsPanel({ groups }: { groups: PolicyDecisionGroup[] }) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <Card className="border-l-4 border-l-amber-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Policy decisions</CardTitle>
            <CardDescription>
              Every amber/red verdict on the kernel&apos;s ledger — the reasons, the recommended move, and who has to approve
            </CardDescription>
          </div>
          <Scale className="h-5 w-5 text-amber-600" />
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No amber or red decisions on the ledger — everything the kernel judged recently came back clean.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.transactionId ?? "__unattached__"}>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </p>
                <ul className="space-y-2">
                  {g.rows.map((r) => (
                    <li key={r.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {(r.documentType ?? r.targetType).replace(/_/g, " ")}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(r.createdAt).toLocaleString()}
                            {r.recommendedAction ? ` · ${r.recommendedAction.replace(/_/g, " ")}` : ""}
                            {r.documentCreatedAt ? ` · document ${new Date(r.documentCreatedAt).toLocaleDateString()}` : ""}
                          </p>
                          {r.reasons.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                              {r.reasons.map((reason, i) => (
                                <li key={i}>· {reason}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <Badge className={DECISION_BADGE[r.decision] ?? "bg-slate-100 text-slate-700"}>
                            {r.decision}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {r.requiredApproverRole
                              ? `Approver: ${r.requiredApproverRole.toUpperCase()}`
                              : "No approval required"}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
