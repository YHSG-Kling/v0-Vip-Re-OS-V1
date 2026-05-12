import { Suspense } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, Shield, Award, ClipboardCheck, ExternalLink } from "lucide-react"
import Link from "next/link"
import { getPendingApprovals, getComplianceViolations, generateComplianceReport, trackCertificationExpiration } from "@/app/actions/compliance-monitoring"
import { getAllTransactionComplianceLogs } from "@/app/actions/transaction-compliance"
import { calculateComplianceRiskScore } from "@/app/actions/multi-persona"
import { createClient } from "@/lib/supabase/server"
import SubmitContentForm from "@/app/components/shared/compliance/submit-content-form"
import PendingApprovalsList from "@/app/components/shared/compliance/pending-approvals-list"
import ViolationsDashboard from "@/app/components/shared/compliance/violations-dashboard"
import ApprovedContentLibrary from "@/app/components/shared/compliance/approved-content-library"
import { TransactionComplianceTab } from "@/app/components/compliance/transaction-compliance-tab"
import { FairHousingScanner } from "@/app/components/compliance/FairHousingScanner"
import { TodaysFocusCard } from "@/app/components/shell/todays-focus-card"
import { generateUserTypeBrief } from "@/lib/intelligence/user-type-briefs"
import { LearnThisWeekCard } from "@/app/components/learning/learn-this-week-card"
import {
  ComplianceCommandStrip,
  ComplianceRiskRadar,
  FlaggedFilesPanel,
  MissingDisclosuresPanel,
  ExceptionReviewPanelWrapper,
  AuditFeedPanel,
  AIComplianceReviewPanel,
  PolicyReportingPanel,
  CdaReviewPanel,
} from "./components/os"

export default async function ComplianceDashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [pendingApprovals, violations, monthlyReport, transactionComplianceLogs, certStatus, complianceRiskScore] = await Promise.all([
    getPendingApprovals(),
    getComplianceViolations(),
    generateComplianceReport({
      startDate: thirtyDaysAgo.toISOString(),
      endDate: today.toISOString(),
    }),
    getAllTransactionComplianceLogs({ limit: 100 }),
    user ? trackCertificationExpiration(user.id).catch(() => null) : Promise.resolve(null),
    user ? calculateComplianceRiskScore(user.id).catch(() => null) : Promise.resolve(null),
  ])

  // Resolve brokerage for the AI brief
  let brokerageId: string | null = null
  if (user) {
    const { data: userRow } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    brokerageId = userRow?.brokerage_id ?? null
  }

  const complianceBrief = user
    ? await generateUserTypeBrief({
        userType: "compliance_officer",
        userId: user.id,
        brokerageId,
      })
    : null

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

      {/* Today's Focus — AI Brief */}
      {complianceBrief && <TodaysFocusCard brief={complianceBrief} />}

      {/* Sprint 7 — Learning router for compliance_officer:
          unresolved_compliance_events, open_tenant_safety_findings,
          staff_onboarding. Hides when no module qualifies. */}
      {user && <LearnThisWeekCard actorKind="staff" actorId={user.id} />}

      {/* OS Command Strip - Priority Action */}
      <ComplianceCommandStrip
        pendingApprovalsCount={pendingApprovals.length}
        criticalViolations={monthlyReport.criticalViolations}
        complianceRate={complianceRate}
        blockingIssues={blockingIssues}
      />

      {/* Compliance Risk Score Card */}
      {complianceRiskScore && (
        <Card className={
          complianceRiskScore.riskLevel === "low"
            ? "border-green-200 bg-green-50/50"
            : complianceRiskScore.riskLevel === "medium"
            ? "border-yellow-200 bg-yellow-50/50"
            : "border-red-200 bg-red-50/50"
        }>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className={
                complianceRiskScore.riskLevel === "low"
                  ? "h-4 w-4 text-green-600"
                  : complianceRiskScore.riskLevel === "medium"
                  ? "h-4 w-4 text-yellow-600"
                  : "h-4 w-4 text-red-600"
              } />
              Compliance Risk Score
            </CardTitle>
            <CardDescription>Based on violations, unapproved content, and communication patterns (last 30 days)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-4">
              <div>
                <div className={
                  "text-4xl font-bold " + (
                    complianceRiskScore.riskLevel === "low"
                      ? "text-green-700"
                      : complianceRiskScore.riskLevel === "medium"
                      ? "text-yellow-700"
                      : "text-red-700"
                  )
                }>
                  {complianceRiskScore.overallScore}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">out of 100</div>
              </div>
              <Badge variant={
                complianceRiskScore.riskLevel === "low" ? "secondary"
                : complianceRiskScore.riskLevel === "medium" ? "outline"
                : "destructive"
              } className="mb-1">
                {complianceRiskScore.riskLevel.charAt(0).toUpperCase() + complianceRiskScore.riskLevel.slice(1)} Risk
              </Badge>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
              <div className="text-center p-2 rounded bg-muted">
                <div className="font-semibold">{complianceRiskScore.violationScore}</div>
                <div className="text-xs text-muted-foreground">Violation Score</div>
                <div className="text-xs text-muted-foreground mt-0.5">{complianceRiskScore.violationsCount} flag{complianceRiskScore.violationsCount !== 1 ? "s" : ""}</div>
              </div>
              <div className="text-center p-2 rounded bg-muted">
                <div className="font-semibold">{complianceRiskScore.contentScore}</div>
                <div className="text-xs text-muted-foreground">Content Score</div>
                <div className="text-xs text-muted-foreground mt-0.5">{complianceRiskScore.unapprovedContentCount} pending</div>
              </div>
              <div className="text-center p-2 rounded bg-muted">
                <div className="font-semibold">{complianceRiskScore.avgThemFirst}</div>
                <div className="text-xs text-muted-foreground">Comm. Score</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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

        {/* Center Column: Missing Disclosures + Exception Review + CDA Approval Queue */}
        <div className="space-y-6">
          <MissingDisclosuresPanel missingDisclosures={missingDisclosures} />
          <ExceptionReviewPanelWrapper exceptions={exceptions} />
          <CdaReviewPanel />
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
          <TabsTrigger value="trid">TRID Timeline</TabsTrigger>
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

        <TabsContent value="trid" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardCheck className="h-4 w-4 text-primary" />
                TRID Compliance Timeline
              </CardTitle>
              <CardDescription>
                TRID (TILA-RESPA Integrated Disclosure) compliance is monitored per transaction.
                Use the links below to access TRID timelines for active transactions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Summary from transaction compliance logs filtered for TRID-related checks */}
              {(() => {
                const TRID_CHECK_TYPES = new Set([
                  "trid_disclosure",
                  "trid_timeline",
                  "loan_estimate",
                  "closing_disclosure",
                ])
                const tridLogs = allLogs.filter(l =>
                  (l.check_type && TRID_CHECK_TYPES.has(l.check_type)) ||
                  l.check_type?.toLowerCase().startsWith("trid_")
                )
                const tridPending = tridLogs.filter(l => l.status === "pending" || l.status === "needs_review")
                const tridPassed = tridLogs.filter(l => l.status === "pass")

                return (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center p-4 rounded-lg bg-muted">
                        <p className="text-2xl font-bold">{tridLogs.length}</p>
                        <p className="text-xs text-muted-foreground mt-1">TRID Checks</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-green-50 border border-green-200">
                        <p className="text-2xl font-bold text-green-700">{tridPassed.length}</p>
                        <p className="text-xs text-green-600 mt-1">Passed</p>
                      </div>
                      <div className="text-center p-4 rounded-lg bg-yellow-50 border border-yellow-200">
                        <p className="text-2xl font-bold text-yellow-700">{tridPending.length}</p>
                        <p className="text-xs text-yellow-600 mt-1">Pending</p>
                      </div>
                    </div>

                    {tridPending.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Pending TRID Items</p>
                        {tridPending.slice(0, 5).map((l: any) => (
                          <div key={l.id} className="flex items-center justify-between p-3 rounded-lg border bg-yellow-50">
                            <div>
                              <p className="text-sm font-medium">{l.check_type?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}</p>
                              {l.notes && <p className="text-xs text-muted-foreground">{l.notes}</p>}
                            </div>
                            {l.transaction_id && (
                              <Link
                                href={`/dashboard/transactions/${l.transaction_id}`}
                                className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                              >
                                View Transaction
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            )}
                          </div>
                        ))}
                        {tridPending.length > 5 && (
                          <p className="text-xs text-muted-foreground">+{tridPending.length - 5} more pending items</p>
                        )}
                      </div>
                    )}

                    {tridLogs.length === 0 && (
                      <div className="text-center py-8 text-muted-foreground">
                        <ClipboardCheck className="h-10 w-10 mx-auto mb-3 opacity-40" />
                        <p className="text-sm">No TRID compliance checks found.</p>
                        <p className="text-xs mt-1">TRID timelines are created automatically when transactions are set up.</p>
                      </div>
                    )}

                    <div className="pt-2 border-t">
                      <p className="text-xs text-muted-foreground mb-2">Manage TRID timelines per transaction:</p>
                      <Link href="/dashboard/transactions" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                        Go to Transaction List
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                )
              })()}
            </CardContent>
          </Card>
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
