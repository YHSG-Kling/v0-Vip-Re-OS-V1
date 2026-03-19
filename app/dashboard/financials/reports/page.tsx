import { redirect } from "next/navigation"
import { createClient, createServiceClient } from "@/utils/supabase/server"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Download, FileText, Calendar, DollarSign, TrendingUp } from "lucide-react"
import Link from "next/link"

export const dynamic = "force-dynamic"

export default async function FinancialReportsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, first_name, last_name")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // Get financial summary for reports
  const currentYear = new Date().getFullYear()
  const { data: transactions } = await service
    .from("transactions")
    .select("id, sale_price, commission_amount, close_date, status")
    .eq("brokerage_id", profile.brokerage_id)
    .gte("close_date", `${currentYear}-01-01`)
    .order("close_date", { ascending: false })

  const closedTransactions = transactions?.filter(t => t.status === "closed") || []
  const ytdCommissions = closedTransactions.reduce((sum, t) => sum + (t.commission_amount || 0), 0)
  const ytdVolume = closedTransactions.reduce((sum, t) => sum + (t.sale_price || 0), 0)

  const reports = [
    {
      title: "Commission Statement",
      description: "Detailed breakdown of all commissions earned",
      icon: DollarSign,
      color: "green",
      period: "Year-to-Date",
    },
    {
      title: "1099 Tax Document",
      description: "Annual tax document for independent contractors",
      icon: FileText,
      color: "blue",
      period: currentYear.toString(),
    },
    {
      title: "Transaction Summary",
      description: "Complete list of all closed transactions",
      icon: TrendingUp,
      color: "purple",
      period: "Year-to-Date",
    },
    {
      title: "Monthly Statement",
      description: "Month-by-month financial breakdown",
      icon: Calendar,
      color: "amber",
      period: "Last 12 Months",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Command Strip */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border bg-muted/30">
        <Link href="/dashboard/financials">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Financials
          </Button>
        </Link>
      </div>

      <div className="px-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Financial Reports</h1>
          <p className="text-muted-foreground">Download statements, 1099s, and transaction summaries</p>
        </div>

        {/* YTD Summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <DollarSign className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">${ytdCommissions.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">YTD Commissions</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <TrendingUp className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">${(ytdVolume / 1000000).toFixed(1)}M</p>
                  <p className="text-xs text-muted-foreground">YTD Volume</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <FileText className="h-5 w-5 text-purple-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{closedTransactions.length}</p>
                  <p className="text-xs text-muted-foreground">Closed Transactions</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Available Reports */}
        <Card>
          <CardHeader>
            <CardTitle>Available Reports</CardTitle>
            <CardDescription>Download or view your financial documents</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {reports.map((report) => {
                const Icon = report.icon
                return (
                  <div key={report.title} className="flex items-center justify-between p-4 border rounded-lg hover:border-primary/50 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-lg bg-${report.color}-500/10`}>
                        <Icon className={`w-5 h-5 text-${report.color}-500`} />
                      </div>
                      <div>
                        <p className="font-semibold">{report.title}</p>
                        <p className="text-sm text-muted-foreground">{report.description}</p>
                        <p className="text-xs text-muted-foreground mt-1">Period: {report.period}</p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="gap-2">
                      <Download className="h-4 w-4" />
                      Download PDF
                    </Button>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Recent Transactions for Reference */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Closed Transactions</CardTitle>
            <CardDescription>Included in your YTD reports</CardDescription>
          </CardHeader>
          <CardContent>
            {closedTransactions.length > 0 ? (
              <div className="space-y-2">
                {closedTransactions.slice(0, 5).map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between p-3 border rounded-lg text-sm">
                    <div>
                      <p className="font-medium">Transaction #{tx.id.slice(0, 8)}</p>
                      <p className="text-xs text-muted-foreground">
                        Closed: {tx.close_date ? new Date(tx.close_date).toLocaleDateString() : "N/A"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-green-600">+${(tx.commission_amount || 0).toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">${(tx.sale_price || 0).toLocaleString()} sale</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">No closed transactions this year</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
