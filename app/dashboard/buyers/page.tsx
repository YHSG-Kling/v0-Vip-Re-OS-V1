import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default async function BuyersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Fetch buyer contacts for this agent
  const { data: buyers } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, contact_type, stage, created_at")
    .eq("agent_id", user.id)
    .eq("contact_type", "buyer")
    .order("created_at", { ascending: false })
    .limit(50)

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Leads</h1>
          <p className="text-muted-foreground">Manage your buyer leads and prospects</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 p-4 bg-muted/30 border-b border-border mb-4 rounded-lg">
        <p className="text-sm font-semibold text-foreground">Buyer Operations</p>
        <div className="flex gap-2 flex-wrap">
          <Link href="/dashboard/isa/calendar">
            <Button size="sm" variant="outline" className="text-xs">ISA Calendar</Button>
          </Link>
          <Link href="/dashboard/buyers/fatigue">
            <Button size="sm" variant="outline" className="text-xs">Fatigue Monitor</Button>
          </Link>
          <Link href="/leads">
            <Button size="sm" variant="outline" className="text-xs">Lead Intelligence</Button>
          </Link>
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Email</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Stage</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Added</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {buyers && buyers.length > 0 ? (
              buyers.map((buyer) => (
                <tr key={buyer.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 text-sm text-foreground">
                    {buyer.first_name} {buyer.last_name}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{buyer.email}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs capitalize">
                      {buyer.stage || "new"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {new Date(buyer.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  No buyer leads found. Add your first lead to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
