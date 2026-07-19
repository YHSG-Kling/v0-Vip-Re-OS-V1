"use client"

/**
 * LOAN CHECKLIST CARD — the buyer's read-only view of their lender's open
 * conditions (the other half of the lender-condition loop). Renders only
 * when there is real loan state to show; kills the "did they get my
 * statement?" call.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Circle, Landmark, GraduationCap } from "lucide-react"
import { loadBuyerLoanChecklist, type BuyerLoanChecklist } from "@/app/actions/portal-loan-checklist"

export function LoanChecklistCard({ contactId, transactionId }: { contactId: string; transactionId: string }) {
  const [data, setData] = useState<BuyerLoanChecklist | null>(null)

  useEffect(() => {
    loadBuyerLoanChecklist({ contactId, transactionId }).then(setData).catch(() => setData(null))
  }, [contactId, transactionId])

  if (!data) return null

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Landmark className="w-5 h-5 text-primary" />
          Your Loan Checklist
        </h2>
        {data.clearToClose ? (
          <Badge className="bg-green-100 text-green-700 border-0">Clear to close 🎉</Badge>
        ) : data.underwritingStatus ? (
          <Badge variant="outline" className="capitalize">{data.underwritingStatus.replace(/_/g, " ")}</Badge>
        ) : null}
      </div>
      {data.clearToClose ? (
        <p className="text-sm text-muted-foreground">
          {data.lenderName ?? "Your lender"} has everything they need — your loan is cleared to close.
        </p>
      ) : data.conditions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data.lenderName ?? "Your lender"} is working through your file — nothing is needed from you right now.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-3">
            {data.outstanding === 0
              ? `Everything you've sent is in — ${data.lenderName ?? "your lender"} is reviewing.`
              : `${data.lenderName ?? "Your lender"} still needs ${data.outstanding} item${data.outstanding === 1 ? "" : "s"} from you. Send them over and your agent will make sure they land.`}
          </p>
          <ul className="space-y-2">
            {data.conditions.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {c.cleared
                  ? <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />
                  : <Circle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />}
                <span className={c.cleared ? "line-through text-muted-foreground" : ""}>{c.condition}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.preApprovalNudge ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <GraduationCap className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            {data.preApprovalNudge}{" "}
            <Link href={`/portal/${contactId}/learn`} className="font-medium underline underline-offset-2">
              See &ldquo;Pre-qual vs pre-approval — which is stronger?&rdquo; in your lessons
            </Link>
          </span>
        </div>
      ) : null}
    </Card>
  )
}
