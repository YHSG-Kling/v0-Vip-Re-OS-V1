import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  pending: "bg-yellow-100 text-yellow-700",
  closed: "bg-blue-100 text-blue-700",
  cancelled: "bg-red-100 text-red-700",
}

export default async function TransactionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch transactions for this agent
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id, 
      property_address, 
      transaction_type,
      status, 
      contract_price, 
      close_date,
      created_at
    `)
    .eq("agent_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Transactions</h1>
          <p className="text-muted-foreground">View and manage your active transactions</p>
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Property</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Type</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Price</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Close Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {transactions && transactions.length > 0 ? (
              transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Link 
                      href={`/dashboard/transactions/${tx.id}`}
                      className="text-sm font-medium text-foreground hover:text-primary"
                    >
                      {tx.property_address || "Pending Address"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground capitalize">
                    {tx.transaction_type || "purchase"}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    ${tx.contract_price?.toLocaleString() || "TBD"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_COLORS[tx.status] || "bg-gray-100 text-gray-700"}>
                      {tx.status || "active"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {tx.close_date ? new Date(tx.close_date).toLocaleDateString() : "TBD"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No transactions found. Transactions will appear here once created.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
