/**
 * DEALS LOST — the board for deal_autopsy_observations.
 *
 * The autopsy lane (lib/kernel/deal-autopsy.ts, triggered by closing
 * orchestration on every lost deal) classifies why each deal died and writes
 * failure_reason / confidence / evidence / purchase_price / days_under_contract
 * / deal_type — and until this board, the only reader of any of it was the
 * writer's own idempotency check. A shipped, registry-owned learning lane whose
 * output no human could see.
 *
 * Server component: the transactions list page is server-rendered and the board
 * has no controls, so the read happens once, gate-first, on the server.
 *
 * HONESTY: the empty state says "no completed autopsies" (the lane may simply
 * not have run), and a REFUSED read renders as the refusal — it never renders
 * as "no deals lost".
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, HeartCrack } from "lucide-react"
import Link from "next/link"
import { getDealAutopsiesAction } from "@/app/actions/deal-autopsies"

const REASON_LABEL: Record<string, string> = {
  financing: "Financing fell through",
  inspection: "Inspection issues",
  appraisal: "Appraisal contingency",
  low_appraisal: "Low appraisal",
  cold_feet: "Cold feet",
  title: "Title issues",
  competing_offer: "Competing offer",
  other: "Unclassified",
}

const REASON_STYLE: Record<string, string> = {
  financing: "bg-amber-100 text-amber-800",
  inspection: "bg-orange-100 text-orange-800",
  appraisal: "bg-purple-100 text-purple-800",
  low_appraisal: "bg-purple-100 text-purple-800",
  cold_feet: "bg-blue-100 text-blue-800",
  title: "bg-red-100 text-red-800",
  competing_offer: "bg-emerald-100 text-emerald-800",
  other: "bg-gray-100 text-gray-700",
}

export async function DealsLostBoard() {
  const res = await getDealAutopsiesAction()

  return (
    <Card>
      <CardHeader className="border-b border-border">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-lg flex items-center gap-2">
            <HeartCrack className="h-5 w-5 text-red-500" />
            Deals Lost — why they died
          </CardTitle>
          {res.success && <Badge variant="secondary">{res.observations.length} autopsied</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          Every lost deal gets a post-mortem: the failure reason is classified from the deal&apos;s
          real record (lender status, contingencies, appraisal gap, title issues) — never guessed.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {!res.success ? (
          // A gate refusal or a refused read is a refusal — NOT "no deals lost".
          <Alert variant="destructive" className="m-4 w-auto">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>The autopsy ledger could not be read</AlertTitle>
            <AlertDescription>{res.error}</AlertDescription>
          </Alert>
        ) : res.observations.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground text-center">
            No completed autopsies yet. The post-mortem runs when a deal is marked lost — an empty
            board means no autopsy has run, not necessarily that no deal was ever lost.
          </p>
        ) : (
          <>
            {res.addressLookupError && (
              <p className="px-4 pt-3 text-xs text-amber-700">
                Property labels unavailable — the transactions lookup was refused:{" "}
                {res.addressLookupError}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Deal</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Why it died</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Type</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Price</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Days under contract</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {res.observations.map((o) => {
                    const reason = o.failureReason ?? "other"
                    return (
                      <tr key={o.id} className="hover:bg-muted/50 align-top">
                        <td className="px-4 py-3">
                          <Link
                            href={`/dashboard/transactions/${o.transactionId}`}
                            className="text-sm font-medium text-foreground hover:text-primary"
                          >
                            {o.propertyAddress ?? o.dealName ?? "Lost deal"}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge className={REASON_STYLE[reason] ?? REASON_STYLE.other}>
                              {REASON_LABEL[reason] ?? reason}
                            </Badge>
                            {o.confidence != null && (
                              <span className="text-xs text-muted-foreground">
                                {Math.round(o.confidence * 100)}% confidence
                              </span>
                            )}
                          </div>
                          {o.evidence.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-1 max-w-md break-words">
                              {o.evidence.join(" · ")}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground capitalize">
                          {o.dealType ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-foreground">
                          {o.purchasePrice != null ? `$${o.purchasePrice.toLocaleString()}` : "—"}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {o.daysUnderContract != null ? `${o.daysUnderContract}d` : "—"}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {o.observedAt ? new Date(o.observedAt).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
