import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getMyOpenCharges } from "@/app/actions/brokerage-fees"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ArrowLeft, DollarSign } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export const dynamic = "force-dynamic"
export const metadata = { title: "My Brokerage Fees" }

const STATUS_COLOR: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  waived: "bg-gray-100 text-gray-600",
  disputed: "bg-orange-100 text-orange-800",
}

// Each charge carries its own currency (agent_fee_charges.currency, stamped from
// the fee type). Hardcoding USD here was reading a number and ignoring its unit.
function fmt(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n)
}

export default async function AgentFeesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const charges = await getMyOpenCharges()

  const open = charges.filter((c) => c.status === "open" || c.status === "overdue")
  const paid = charges.filter((c) => c.status === "paid")
  // Waived charges were filtered out entirely, so a fee the broker forgave
  // simply vanished from the agent's ledger — along with the reason the broker
  // wrote into agent_fee_charges.notes for the agent to see.
  const waived = charges.filter((c) => c.status === "waived")
  const totalOwed = open.reduce((s, c) => s + c.amount, 0)
  const totalPaid = paid.reduce((s, c) => s + c.amount, 0)

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/financials/agent">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="h-6 w-6 text-amber-600" />
            My Brokerage Fees
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recurring + one-time fees you owe the brokerage. (Commissions are paid separately at closing via the CDA.)
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-600">{fmt(totalOwed)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Currently Owed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{fmt(totalPaid)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Paid (Last 60 Days)</p>
          </CardContent>
        </Card>
      </div>

      {open.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Open Charges</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {open.map((c) => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{c.feeTypeName}</p>
                    <p className="text-xs text-muted-foreground">
                      Period: {new Date(c.periodStart).toLocaleDateString()}
                      {c.dueDate && ` · due ${new Date(c.dueDate).toLocaleDateString()}`}
                    </p>
                  </div>
                  <span className="font-semibold">{fmt(c.amount, c.currency)}</span>
                  <Badge className={`text-xs capitalize ${STATUS_COLOR[c.status]}`}>{c.status}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {paid.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Payment History</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {paid.map((c) => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{c.feeTypeName}</p>
                    <p className="text-xs text-muted-foreground">
                      Paid {c.paidAt ? new Date(c.paidAt).toLocaleDateString() : "—"}
                      {c.paymentMethod && ` · ${c.paymentMethod}`}
                    </p>
                  </div>
                  <span className="font-semibold">{fmt(c.amount, c.currency)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {waived.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Waived Charges</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {waived.map((c) => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{c.feeTypeName}</p>
                    <p className="text-xs text-muted-foreground">
                      Period: {new Date(c.periodStart).toLocaleDateString()}
                      {c.notes && ` · ${c.notes}`}
                    </p>
                  </div>
                  <span className="font-semibold line-through text-muted-foreground">{fmt(c.amount, c.currency)}</span>
                  <Badge className={`text-xs capitalize ${STATUS_COLOR.waived}`}>waived</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {charges.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No fees on file. Your brokerage hasn't assessed any fees yet.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
