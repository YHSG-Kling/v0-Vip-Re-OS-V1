import { Suspense } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, Shield, Award } from "lucide-react"
import { getPendingApprovals, getComplianceViolations, generateComplianceReport, trackCertificationExpiration } from "@/app/actions/compliance-monitoring"
import { getAllTransactionComplianceLogs } from "@/app/actions/transaction-compliance"
import { createClient } from "@/lib/supabase/server"
import SubmitContentForm from "@/app/components/shared/compliance/submit-content-form"
import PendingApprovalsList from "@/app/components/shared/compliance/pending-approvals-list"
import ViolationsDashboard from "@/app/components/shared/compliance/violations-dashboard"
import ApprovedContentLibrary from "@/app/components/shared/compliance/approved-content-library"
import { TransactionComplianceTab } from "@/app/components/compliance/transaction-compliance-tab"
import { FairHousingScanner } from "@/app/components/compliance/FairHousingScanner"
import {
  ComplianceCommandStrip,
  ComplianceRiskRadar,
  FlaggedFilesPanel,
  MissingDisclosuresPanel,
  ExceptionReviewPanelWrapper,
  AuditFeedPanel,
  AIComplianceReviewPanel,
  PolicyReportingPanel,
} from "./components/os"

export default async function ComplianceDashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [pendingApprovals, violations, monthlyReport, transactionComplianceLogs, certStatus] = await Promise.all([
    getPendingApprovals(),
    getComplianceViolations(),
    generateComplianceReport({
      startDate: thirtyDaysAgo.toISOString(),
      endDate: today.toISOString(),
    }),
    getAllTransactionComplianceLogs({ limit: 100 }),
    user ? trackCertificationExpiration(user.id).catch(() => null) : Promise.resolve(null),
  ])

  const complianceRate =
    monthlyReport.totalCommunications > 0
      ? Math.round((monthlyReport.compliantCommunications / monthlyReport.totalCommunications) * 100)
      : 100

  // Process transaction compliance logs for OS panels
  const allLogs = transactionComplianceLogs.logs || []
  
  // Flagged files: fail or needs_review status
  const flaggedFiles = allLogs.filter(
    (l) => l.status === "fail" || l.status === "needs_review"
  )
  
  // Missing disclosures: pending status with disclosure-related check types
  const disclosureTypes = ["lead_paint_disclosure", "property_disclosure", "agency_disclosure", "wire_fraud_disclosure"]
  const missingDisclosures = allLogs.filter(
    (l) => l.status === "pending" && disclosureTypes.includes(l.check_type)
  )
  
  // Exceptions requiring decision: needs_review status
  const exceptions = allLogs.filter((l) => l.status === "needs_review" || (l.is_blocking && l.status === "fail"))
  
  // Blocking issues count
  const blockingIssues = allLogs.filter(
    (l) => l.is_blocking && (l.status === "fail" || l.status === "pending" || l.status === "needs_review")
  ).length

  // Calculate risk metrics
  const openExceptions = allLogs.filter((l) => l.status === "needs_review").length
  const reviewBacklog = pendingApprovals.length
  const criticalPressure = Math.min(100, Math.round(
    ((monthlyReport.criticalViolations * 20) + (blockingIssues * 10) + (openExceptions * 5)) / 2
  ))

  // Get audit events from transaction timeline (compliance-related)
  const { data: auditEvents } = await supabase
    .from("transaction_timeline")
    .select("id, activity_type, description, created_at, metadata")
    .in("activity_type", ["compliance_check_updated", "compliance_checks_seeded", "compliance_batch_pass"])
    .order("created_at", { ascending: false })
    .limit(20)

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Shield className="w-8 h-8 text-primary" />
            Compliance Command Center
          </h1>
          <p className="text-muted-foreground mt-1">
            Risk-first compliance monitoring and content moderation
          </p>
        </div>
      </div>

      {/* OS Command Strip - Priority Action */}
      <ComplianceCommandStrip
        pendingApprovalsCount={pendingApprovals.length}
        criticalViolations={monthlyReport.criticalViolations}
        complianceRate={complianceRate}
        blockingIssues={blockingIssues}
      />

      {/* OS Intelligence Grid - 3 Column Layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left Column: Risk Radar + Flagged Files */}
        <div className="space-y-6">
          <ComplianceRiskRadar
            flaggedFiles={flaggedFiles.length}
            openExceptions={openExceptions}
            missingDisclosures={missingDisclosures.length}
            criticalPressure={criticalPressure}
            reviewBacklog={reviewBacklog}
            complianceRate={complianceRate}
          />
          <FlaggedFilesPanel flaggedFiles={flaggedFiles} />
        </div>

        {/* Center Column: Missing Disclosures + Exception Review */}
        <div className="space-y-6">
          <MissingDisclosuresPanel missingDisclosures={missingDisclosures} />
          <ExceptionReviewPanelWrapper exceptions={exceptions} />
        </div>

        {/* Right Column: Audit Feed + AI Review + Reporting */}
        <div className="space-y-6">
          <AuditFeedPanel auditEvents={auditEvents || []} />
          <AIComplianceReviewPanel />
          <PolicyReportingPanel
            complianceRate={complianceRate}
            totalViolations={monthlyReport.totalViolations}
            criticalViolations={monthlyReport.criticalViolations}
            totalCommunications={monthlyReport.totalCommunications}
          />
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

      {/* Main Content Tabs - Preserved from Original */}
      <Tabs defaultValue="pending" className="space-y-4">
        <TabsList>
          <TabsTrigger value="submit">Submit Content</TabsTrigger>
          <TabsTrigger value="pending" id="pending">
            Pending Approvals
            {pendingApprovals.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {pendingApprovals.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="library">Approved Library</TabsTrigger>
          <TabsTrigger value="violations" id="violations">
            Violations
            {monthlyReport.totalViolations > 0 && (
              <Badge variant="secondary" className="ml-2">
                {monthlyReport.totalViolations}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="transactions" id="transactions">
            Transaction Compliance
            {blockingIssues > 0 && (
              <Badge variant="destructive" className="ml-2">
                {blockingIssues}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="fair-housing">Fair Housing</TabsTrigger>
          <TabsTrigger value="certifications">
            Certifications
            {certStatus && certStatus.expiring > 0 && (
              <Badge variant="secondary" className="ml-2">{certStatus.expiring}</Badge>
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
              <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
                <SubmitContentForm userId={user?.id || ""} />
              </Suspense>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="space-y-4">
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <PendingApprovalsList initialApprovals={pendingApprovals} reviewerId={user?.id || ""} />
          </Suspense>
        </TabsContent>

        <TabsContent value="library" className="space-y-4">
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <ApprovedContentLibrary />
          </Suspense>
        </TabsContent>

        <TabsContent value="violations" className="space-y-4">
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <ViolationsDashboard initialViolations={violations} report={monthlyReport} />
          </Suspense>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            <TransactionComplianceTab initialLogs={transactionComplianceLogs.logs} />
          </Suspense>
        </TabsContent>

        <TabsContent value="fair-housing" className="space-y-4">
          <FairHousingScanner />
        </TabsContent>

        <TabsContent value="certifications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Award className="h-4 w-4 text-primary" />
                License &amp; Certification Status
              </CardTitle>
              <CardDescription>Current certification and licensing status for your profile</CardDescription>
            </CardHeader>
            <CardContent>
              {certStatus ? (
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-4 rounded-lg bg-green-50 border border-green-200">
                    <p className="text-2xl font-bold text-green-700">{certStatus.active}</p>
                    <p className="text-xs text-green-600 mt-1">Active</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-yellow-50 border border-yellow-200">
                    <p className="text-2xl font-bold text-yellow-700">{certStatus.expiring}</p>
                    <p className="text-xs text-yellow-600 mt-1">Expiring Soon</p>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-red-50 border border-red-200">
                    <p className="text-2xl font-bold text-red-700">{certStatus.expired}</p>
                    <p className="text-xs text-red-600 mt-1">Expired</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No certification data available. Add certifications in your agent profile.</p>
              )}
              {certStatus && certStatus.expiring > 0 && (
                <Alert className="mt-4 border-yellow-300 bg-yellow-50">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <AlertDescription className="text-yellow-800">
                    {certStatus.expiring} certification{certStatus.expiring !== 1 ? "s" : ""} expiring within 30 days. Renew to maintain compliance.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
