import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { getLenderDashboard } from "@/app/actions/multi-persona"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Building2, FileCheck, Clock, AlertCircle, DollarSign } from "lucide-react"
import { LenderLoanList } from "@/components/lender/loan-list"

export default async function LenderPortalDashboard({ searchParams }: { searchParams: Promise<{ lenderId?: string }> }) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let lenderId = params.lenderId
  if (!lenderId) {
    const { data: lender } = await supabase.from("lender_portal_users").select("id").eq("user_id", user.id).single()
    lenderId = lender?.id
  }

  if (!lenderId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No lender profile found. Please contact your administrator.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { lender, loans } = await getLenderDashboard(lenderId)

  const activeLoanCount = loans?.filter((l: any) => !["funded", "denied", "withdrawn"].includes(l.underwriting_status))?.length || 0
  const clearToCloseCount = loans?.filter((l: any) => l.underwriting_status === "clear_to_close")?.length || 0
  const pendingConditionsCount = loans?.filter((l: any) => l.underwriting_status === "pending_conditions")?.length || 0
  const totalLoanVolume = loans?.reduce((sum: number, l: any) => sum + (l.transactions?.contract_price || 0), 0) || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lender Portal</h1>
          <p className="text-muted-foreground">{lender?.company_name || "Loan Pipeline Dashboard"}</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {activeLoanCount} Active Loans
        </Badge>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileCheck className="h-4 w-4" />
              Active Loans
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeLoanCount}</div>
            <p className="text-xs text-muted-foreground">In pipeline</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Clear to Close
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{clearToCloseCount}</div>
            <p className="text-xs text-muted-foreground">Ready for closing</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Pending Conditions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{pendingConditionsCount}</div>
            <p className="text-xs text-muted-foreground">Awaiting docs</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Loan Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(totalLoanVolume / 1000000).toFixed(2)}M</div>
            <p className="text-xs text-muted-foreground">Active pipeline</p>
          </CardContent>
        </Card>
      </div>

      {/* Loan List */}
      <LenderLoanList loans={loans || []} />
    </div>
  )
}
