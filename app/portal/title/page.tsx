import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getTitleDashboard } from "@/app/actions/title-portal"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Building, FileText, AlertTriangle, CheckCircle2, DollarSign, Calendar } from "lucide-react"
import { TitleTransactionList } from "@/components/title/transaction-list"

export default async function TitlePortalDashboard() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get title user profile
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, company_name")
    .eq("user_id", user.id)
    .single()

  if (!titleUser) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No title company profile found. Please contact your administrator.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { titleUser: profile, transactions, stats } = await getTitleDashboard(titleUser.id)

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Title & Escrow Portal</h1>
          <p className="text-muted-foreground">{profile.company_name}</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {stats.activeCount} Active Transactions
        </Badge>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Active Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeCount}</div>
            <p className="text-xs text-muted-foreground">In progress</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Closing This Week
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{stats.closingThisWeek}</div>
            <p className="text-xs text-muted-foreground">Next 7 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Pending EMD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{stats.pendingEarnestMoney}</div>
            <p className="text-xs text-muted-foreground">Awaiting deposit</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Title Issues
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.titleIssuesCount}</div>
            <p className="text-xs text-muted-foreground">Need resolution</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Ready to Close
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.readyToClose}</div>
            <p className="text-xs text-muted-foreground">Title clear</p>
          </CardContent>
        </Card>
      </div>

      {/* Transaction List */}
      <TitleTransactionList transactions={transactions as any} />
    </div>
  )
}
