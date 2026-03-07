import { Suspense } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle, Shield, TrendingUp, FileCheck } from "lucide-react"
import { getPendingApprovals, getComplianceViolations, generateComplianceReport } from "@/app/actions/compliance-monitoring"
import { getAllTransactionComplianceLogs } from "@/app/actions/transaction-compliance"
import { createClient } from "@/lib/supabase/server"
import SubmitContentForm from "@/components/compliance/submit-content-form"
import PendingApprovalsList from "@/components/compliance/pending-approvals-list"
import ViolationsDashboard from "@/components/compliance/violations-dashboard"
import ApprovedContentLibrary from "@/components/compliance/approved-content-library"
import { TransactionComplianceTab } from "@/app/components/compliance/transaction-compliance-tab"

export default async function ComplianceDashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [pendingApprovals, violations, monthlyReport, transactionComplianceLogs] = await Promise.all([
    getPendingApprovals(),
    getComplianceViolations(),
    generateComplianceReport({
      startDate: thirtyDaysAgo.toISOString(),
      endDate: today.toISOString(),
    }),
    getAllTransactionComplianceLogs({ limit: 100 }),
  ])

  const complianceRate =
    monthlyReport.totalCommunications > 0
      ? Math.round((monthlyReport.compliantCommunications / monthlyReport.totalCommunications) * 100)
      : 100

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Shield className="w-8 h-8 text-blue-600" />
            Compliance & Content Moderation
          </h1>
          <p className="text-muted-foreground mt-1">Ensure all communications meet real estate compliance standards</p>
        </div>
      </div>

      {/* Alert Banner */}
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Important:</strong> Cold leads can ONLY receive email or print mail communications. All marketing
          content must be approved before distribution.
        </AlertDescription>
      </Alert>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Approvals</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingApprovals.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting review</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Compliance Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${complianceRate >= 90 ? "text-green-600" : "text-red-600"}`}>
              {complianceRate}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">Last 30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Violations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${monthlyReport.totalViolations > 0 ? "text-red-600" : "text-green-600"}`}>
              {monthlyReport.totalViolations}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{monthlyReport.criticalViolations} critical</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cold Lead Compliance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {monthlyReport.coldLeadChannelCompliance ? (
                <>
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-2xl font-bold text-green-600">100%</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                  <span className="text-2xl font-bold text-red-600">Issues</span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Email/print only</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="submit" className="space-y-4">
        <TabsList>
          <TabsTrigger value="submit">Submit Content</TabsTrigger>
          <TabsTrigger value="pending">
            Pending Approvals
            {pendingApprovals.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {pendingApprovals.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="library">Approved Library</TabsTrigger>
          <TabsTrigger value="violations">Violations</TabsTrigger>
          <TabsTrigger value="transactions">
            Transaction Compliance
            {transactionComplianceLogs.logs.filter(l => l.status === "pending").length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {transactionComplianceLogs.logs.filter(l => l.status === "pending").length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="submit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Submit Content for Approval</CardTitle>
              <CardDescription>All marketing materials must be reviewed for compliance before distribution</CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<div>Loading form...</div>}>
                <SubmitContentForm userId={user?.id || ""} />
              </Suspense>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="space-y-4">
          <Suspense fallback={<div>Loading approvals...</div>}>
            <PendingApprovalsList initialApprovals={pendingApprovals} reviewerId={user?.id || ""} />
          </Suspense>
        </TabsContent>

        <TabsContent value="library" className="space-y-4">
          <Suspense fallback={<div>Loading library...</div>}>
            <ApprovedContentLibrary />
          </Suspense>
        </TabsContent>

        <TabsContent value="violations" className="space-y-4">
          <Suspense fallback={<div>Loading violations...</div>}>
            <ViolationsDashboard initialViolations={violations} report={monthlyReport} />
          </Suspense>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Suspense fallback={<div>Loading transaction compliance...</div>}>
            <TransactionComplianceTab initialLogs={transactionComplianceLogs.logs} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}
