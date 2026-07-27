import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowRight, Scale, TrendingUp, Receipt } from "lucide-react"
import Link from "next/link"
import type { AgentFeeCharge } from "@/app/actions/brokerage-fees"

/**
 * Net position — owned by finance_manager.
 *
 * Walkthrough [106]: "My fees — Recurring fees + one time fees own brokerage separate
 * from commissions (this should be under one umbrella)."
 *
 * The nav already grouped Earnings and My Fees under one Financials item, but that only
 * put the two screens next to each other. An agent still had to open both and do the
 * subtraction in their head to answer the question they actually care about: what do I
 * clear? This card answers it on the earnings page, reading the SAME source as the fees
 * detail page (agent_fee_charges via getMyOpenCharges) so the two can never disagree.
 *
 * The per-charge ledger stays where it is — this is a summary line with a way through
 * to the detail, not a second copy of it.
 */

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

export function AgentNetPositionCard({
  ytdNet,
  charges,
}: {
  ytdNet: number
  charges: AgentFeeCharge[]
}) {
  const open = charges.filter(c => c.status === "open" || c.status === "overdue")
  const overdue = charges.filter(c => c.status === "overdue")
  const disputed = charges.filter(c => c.status === "disputed")
  const owed = open.reduce((s, c) => s + c.amount, 0)
  const overdueAmount = overdue.reduce((s, c) => s + c.amount, 0)
  const net = ytdNet - owed

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">Net position</span>
          <Link
            href="/dashboard/financials/agent/fees"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            Fee detail <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              Earned YTD
            </div>
            <p className="text-xl font-bold mt-1">{usd(ytdNet)}</p>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Receipt className="h-3.5 w-3.5" />
              Owed to brokerage
            </div>
            <p className={`text-xl font-bold mt-1 ${owed > 0 ? "text-amber-600" : ""}`}>{usd(owed)}</p>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Net to you</div>
            <p className={`text-xl font-bold mt-1 ${net < 0 ? "text-red-600" : "text-emerald-600"}`}>
              {usd(net)}
            </p>
          </div>
        </div>

        {/* The read — only says something when there is something to say. */}
        {(overdue.length > 0 || disputed.length > 0 || owed > 0) && (
          <div className="border-t pt-3 text-sm text-muted-foreground space-y-1">
            {overdue.length > 0 && (
              <p>
                <Badge className="bg-red-100 text-red-800 text-xs mr-2">Overdue</Badge>
                {overdue.length} {overdue.length === 1 ? "charge is" : "charges are"} past due,
                totalling {usd(overdueAmount)} — settle these before your next disbursement.
              </p>
            )}
            {disputed.length > 0 && (
              <p>
                <Badge className="bg-orange-100 text-orange-800 text-xs mr-2">Disputed</Badge>
                {disputed.length} {disputed.length === 1 ? "charge is" : "charges are"} under dispute
                and excluded from the total above until resolved.
              </p>
            )}
            {overdue.length === 0 && disputed.length === 0 && owed > 0 && (
              <p>{open.length} open {open.length === 1 ? "charge" : "charges"}, none past due.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
