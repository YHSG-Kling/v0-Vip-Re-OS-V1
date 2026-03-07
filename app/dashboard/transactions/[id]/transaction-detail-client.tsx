"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { TransactionStage, TRANSACTION_STAGES, STAGE_TRANSITIONS } from "@/lib/transactions/transaction-stages"
import {
  checkStageAdvancement,
  advanceTransactionStage,
  markTransactionLost,
} from "@/app/actions/transaction-stage-machine"
import {
  scheduleInspectionAction,
  approveInspectionQuoteAction,
  markInspectionCompleteAction,
  uploadInspectionReportAction,
  requestInsuranceQuoteAction,
  submitInsuranceQuoteApprovalAction,
  approveInsuranceQuoteAction,
  updateEarnestMoneyAction,
  getPendingQuoteApprovalsAction,
} from "@/app/actions/transaction-inspections"
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Users,
  DollarSign,
  Calendar,
  Shield,
  Home,
  Wrench,
  Building2,
  CircleDot,
  XCircle,
  Upload,
  Plus,
  Loader2,
} from "lucide-react"

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface TransactionDetailClientProps {
  transaction: {
    id: string
    brokerage_id: string
    agent_id: string
    contact_id: string
    property_address: string
    purchase_price: number
    status: string
    stage: string
    contract_date: string | null
    close_date: string | null
    compliance_passed_at: string | null
    deal_type: string | null
    offer_id: string | null
    listing_id: string | null
    created_at: string
    updated_at: string
  }
  brokerageId: string
  userRole: string
  userId: string
  milestones: Array<{
    id: string
    milestone_name: string
    milestone_date: string | null
    status: string
    completed_at: string | null
    notes: string | null
  }>
  deadlines: Array<{
    id: string
    deadline_type: string
    deadline_date: string
    status: string
    notes: string | null
  }>
  participants: Array<{
    id: string
    role: string
    name: string
    email: string | null
    phone: string | null
    company: string | null
  }>
  participantCountsByRole: Record<string, number>
  documents: Array<{
    id: string
    doc_type: string
    file_name: string
    status: string
    uploaded_at: string
  }>
  documentCountsByStatus: Record<string, number>
  healthScore: {
    score: number
    risk_level: string
    issues: string[]
    calculated_at: string
  } | null
  unresolvedInterventionsCount: number
  tasks: Array<{
    id: string
    title: string
    status: string
    due_date: string | null
    assigned_to: string | null
  }>
  timeline: Array<{
    id: string
    event_type: string
    description: string
    occurred_at: string
    actor_name: string | null
  }>
  titleEscrow: {
    id: string
    title_company: string | null
    escrow_company: string | null
    earnest_money_amount: number | null
    earnest_money_received_at: string | null
    earnest_money_holder: string | null
  } | null
  inspections: Array<{
    id: string
    inspection_type: string
    inspector_name: string | null
    inspector_company: string | null
    inspector_email: string | null
    inspector_phone: string | null
    scheduled_date: string | null
    completed_date: string | null
    cost: number | null
    status: string
    report_url: string | null
    report_received: boolean
  }>
  pendingQuoteApprovals: Array<{
    id: string
    activity_type: string
    title: string
    metadata: Record<string, unknown>
  }>
  vendorServices: Array<{
    id: string
    service_type: string
    vendor_name: string
    vendor_email: string | null
    vendor_phone: string | null
    status: string
    cost: number | null
    scheduled_date: string | null
  }>
  insuranceQuotes: Array<{
    id: string
    vendor_name: string
    quote_amount: number | null
    status: string
  }>
  repairs: Array<{
    id: string
    description: string
    status: string
    cost_estimate: number | null
    completed_at: string | null
  }>
  lenderInfo: {
    lender_name: string | null
    loan_officer: string | null
    loan_type: string | null
    loan_amount: number | null
    interest_rate: number | null
    pre_approval_amount: number | null
    clear_to_close_at: string | null
  } | null
  complianceAlerts: Array<{
    id: string
    alert_type: string
    severity: string
    message: string
    resolved_at: string | null
  }>
  commissionSplits: Array<{
    id: string
    recipient_type: string
    recipient_name: string
    percentage: number
    amount: number | null
    status: string
  }>
  stages: TransactionStage[]
  currentStageIndex: number
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────────

export function TransactionDetailClient({
  transaction,
  brokerageId,
  userRole,
  userId,
  milestones,
  deadlines,
  participants,
  participantCountsByRole,
  documents,
  documentCountsByStatus,
  healthScore,
  unresolvedInterventionsCount,
  tasks,
  timeline,
  titleEscrow,
  inspections,
  pendingQuoteApprovals,
  vendorServices,
  insuranceQuotes,
  repairs,
  lenderInfo,
  complianceAlerts,
  commissionSplits,
  stages,
  currentStageIndex,
}: TransactionDetailClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Stage advancement state
  const [showBlockersModal, setShowBlockersModal] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showLostModal, setShowLostModal] = useState(false)
  const [blockers, setBlockers] = useState<string[]>([])
  const [targetStage, setTargetStage] = useState<TransactionStage | null>(null)
  const [advanceReason, setAdvanceReason] = useState("")

  // Lost modal state
  const [lostReason, setLostReason] = useState("")
  const [lostCategory, setLostCategory] = useState("")
  const [earnestOutcome, setEarnestOutcome] = useState<"returned" | "forfeited">("returned")

  // Inspection form state
  const [showInspectionForm, setShowInspectionForm] = useState(false)
  const [inspectionType, setInspectionType] = useState("home_inspection")
  const [inspectorName, setInspectorName] = useState("")
  const [inspectorCompany, setInspectorCompany] = useState("")
  const [inspectorEmail, setInspectorEmail] = useState("")
  const [inspectorPhone, setInspectorPhone] = useState("")
  const [inspectionDate, setInspectionDate] = useState("")
  const [inspectionCost, setInspectionCost] = useState("")

  // Insurance form state
  const [showInsuranceForm, setShowInsuranceForm] = useState(false)
  const [insuranceVendorName, setInsuranceVendorName] = useState("")
  const [insuranceVendorEmail, setInsuranceVendorEmail] = useState("")
  const [insuranceVendorPhone, setInsuranceVendorPhone] = useState("")
  const [insuranceQuoteAmount, setInsuranceQuoteAmount] = useState("")

  // Earnest money form state
  const [emAmount, setEmAmount] = useState(titleEscrow?.earnest_money_amount?.toString() ?? "")
  const [emHeldBy, setEmHeldBy] = useState(titleEscrow?.earnest_money_holder ?? "")
  const [emReceivedDate, setEmReceivedDate] = useState(titleEscrow?.earnest_money_received_at ?? "")

  const currentStage = transaction.stage as TransactionStage
  const allowedNextStages = STAGE_TRANSITIONS[currentStage] || []
  const canAdvance = allowedNextStages.length > 0 && currentStage !== "CLOSED" && currentStage !== "LOST"
  const canMarkLost = currentStage !== "CLOSED" && currentStage !== "LOST"

  // Missing blocking conditions
  const missingContractDate = !transaction.contract_date
  const missingCompliance = !transaction.compliance_passed_at

  // ─── HANDLERS ────────────────────────────────────────────────────────────────

  async function handleAdvanceClick(stage: TransactionStage) {
    setTargetStage(stage)

    const result = await checkStageAdvancement({
      transactionId: transaction.id,
      brokerageId,
      targetStage: stage,
    })

    if (result.allowed) {
      setShowConfirmModal(true)
    } else {
      setBlockers(result.blockers)
      setShowBlockersModal(true)
    }
  }

  function confirmAdvance() {
    if (!targetStage) return

    startTransition(async () => {
      const result = await advanceTransactionStage({
        transactionId: transaction.id,
        brokerageId,
        targetStage,
        reason: advanceReason || undefined,
      })

      if (result.success) {
        setShowConfirmModal(false)
        setAdvanceReason("")
        router.refresh()
      } else {
        setBlockers(result.blockers ?? [result.error ?? "Unknown error"])
        setShowConfirmModal(false)
        setShowBlockersModal(true)
      }
    })
  }

  function confirmMarkLost() {
    if (!lostReason || !lostCategory) return

    startTransition(async () => {
      const result = await markTransactionLost({
        transactionId: transaction.id,
        brokerageId,
        lostReason,
        category: lostCategory,
        earnestMoneyOutcome: earnestOutcome,
      })

      if (result.success) {
        setShowLostModal(false)
        router.refresh()
      }
    })
  }

  // ─── INSPECTION HANDLERS ─────────────────────────────────────────────────────

  async function handleScheduleInspection() {
    if (!inspectorName) return

    startTransition(async () => {
      const result = await scheduleInspectionAction({
        transactionId: transaction.id,
        brokerageId,
        inspectionType,
        inspectorName,
        inspectorCompany: inspectorCompany || undefined,
        inspectorEmail: inspectorEmail || undefined,
        inspectorPhone: inspectorPhone || undefined,
        scheduledDate: inspectionDate || undefined,
        cost: inspectionCost ? parseFloat(inspectionCost) : undefined,
      })

      if (result.success) {
        setShowInspectionForm(false)
        setInspectorName("")
        setInspectorCompany("")
        setInspectorEmail("")
        setInspectorPhone("")
        setInspectionDate("")
        setInspectionCost("")
        router.refresh()
      }
    })
  }

  async function handleApproveQuote(activityId: string, vendorName: string, quoteType: string) {
    startTransition(async () => {
      if (quoteType === "inspector") {
        await approveInspectionQuoteAction({
          activityId,
          transactionId: transaction.id,
          brokerageId,
          vendorName,
        })
      } else {
        await approveInsuranceQuoteAction({
          activityId,
          serviceId: activityId,
          transactionId: transaction.id,
          brokerageId,
          vendorName,
        })
      }
      router.refresh()
    })
  }

  async function handleMarkInspectionComplete(inspectionId: string) {
    startTransition(async () => {
      await markInspectionCompleteAction({
        inspectionId,
        transactionId: transaction.id,
        brokerageId,
      })
      router.refresh()
    })
  }

  // ─── INSURANCE HANDLERS ──────────────────────────────────────────────────────

  async function handleRequestInsuranceQuote() {
    if (!insuranceVendorName) return

    startTransition(async () => {
      const result = await requestInsuranceQuoteAction({
        transactionId: transaction.id,
        brokerageId,
        vendorName: insuranceVendorName,
        vendorEmail: insuranceVendorEmail || undefined,
        vendorPhone: insuranceVendorPhone || undefined,
      })

      if (result.success) {
        setShowInsuranceForm(false)
        setInsuranceVendorName("")
        setInsuranceVendorEmail("")
        setInsuranceVendorPhone("")
        router.refresh()
      }
    })
  }

  async function handleSubmitInsuranceQuoteAmount(serviceId: string, vendorName: string) {
    if (!insuranceQuoteAmount) return

    startTransition(async () => {
      await submitInsuranceQuoteApprovalAction({
        serviceId,
        transactionId: transaction.id,
        brokerageId,
        vendorName,
        quoteAmount: parseFloat(insuranceQuoteAmount),
      })
      setInsuranceQuoteAmount("")
      router.refresh()
    })
  }

  // ─── EARNEST MONEY HANDLER ───────────────────────────────────────────────────

  async function handleUpdateEarnestMoney() {
    startTransition(async () => {
      await updateEarnestMoneyAction({
        transactionId: transaction.id,
        brokerageId,
        titleEscrowId: titleEscrow?.id,
        earnestMoneyAmount: emAmount ? parseFloat(emAmount) : undefined,
        earnestMoneyHeldBy: emHeldBy || undefined,
        earnestMoneyReceivedDate: emReceivedDate || undefined,
      })
      router.refresh()
    })
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      {/* Blocking Banner */}
      {(missingContractDate || missingCompliance) && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Transaction Blocked</AlertTitle>
          <AlertDescription>
            {missingContractDate && "Contract date is required. "}
            {missingCompliance && "Compliance must be passed before proceeding."}
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="border-b bg-card">
        <div className="container py-4">
          <div className="flex items-center gap-4 mb-3">
            <Link
              href={userRole === "tc" ? "/dashboard/coordinator" : "/dashboard/transactions"}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex-1">
              <h1 className="text-xl font-semibold">{transaction.property_address}</h1>
              <p className="text-sm text-muted-foreground">
                ${transaction.purchase_price?.toLocaleString()} | {transaction.deal_type ?? "Purchase"}
              </p>
            </div>
            <Badge variant={currentStage === "CLOSED" ? "default" : currentStage === "LOST" ? "destructive" : "secondary"}>
              {currentStage.replace(/_/g, " ")}
            </Badge>
          </div>
        </div>
      </div>

      {/* Main Layout: LEFT / CENTER / RIGHT */}
      <div className="container py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* LEFT: Stage Stepper */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Stage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {stages.map((stage, idx) => {
                  const isCompleted = idx < currentStageIndex
                  const isCurrent = stage === currentStage
                  const isNext = allowedNextStages.includes(stage) && !isCurrent
                  const isLost = currentStage === "LOST"

                  return (
                    <div key={stage} className="flex items-center gap-2">
                      <div
                        className={cn(
                          "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0",
                          isCompleted && "bg-green-500 text-white",
                          isCurrent && !isLost && "bg-primary text-primary-foreground",
                          isCurrent && isLost && "bg-destructive text-destructive-foreground",
                          !isCompleted && !isCurrent && "bg-muted text-muted-foreground"
                        )}
                      >
                        {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-xs truncate",
                          isCurrent ? "font-semibold" : "text-muted-foreground"
                        )}>
                          {stage.replace(/_/g, " ")}
                        </p>
                      </div>
                      {isNext && canAdvance && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          onClick={() => handleAdvanceClick(stage)}
                          disabled={isPending || missingContractDate || missingCompliance}
                        >
                          <ArrowRight className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )
                })}

                {/* Lost option */}
                {canMarkLost && (
                  <div className="pt-3 border-t mt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setShowLostModal(true)}
                      disabled={isPending}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      Mark Lost
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* CENTER: Deal Summary */}
          <div className="lg:col-span-6 space-y-4">
            {/* Deal Summary Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Deal Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Contract Date</p>
                    <p className="font-medium">
                      {transaction.contract_date
                        ? new Date(transaction.contract_date).toLocaleDateString()
                        : "Not set"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Target Close</p>
                    <p className="font-medium">
                      {transaction.close_date
                        ? new Date(transaction.close_date).toLocaleDateString()
                        : "Not set"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Compliance</p>
                    <p className="font-medium">
                      {transaction.compliance_passed_at ? (
                        <span className="text-green-600">Passed</span>
                      ) : (
                        <span className="text-amber-600">Pending</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Deal Type</p>
                    <p className="font-medium">{transaction.deal_type ?? "Purchase"}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Health Card */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">Deal Health</CardTitle>
                  {healthScore && (
                    <Badge
                      variant={
                        healthScore.risk_level === "healthy"
                          ? "default"
                          : healthScore.risk_level === "at_risk"
                          ? "secondary"
                          : "destructive"
                      }
                    >
                      {healthScore.score}/100
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {healthScore ? (
                  <div className="space-y-2">
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full transition-all",
                          healthScore.risk_level === "healthy" && "bg-green-500",
                          healthScore.risk_level === "at_risk" && "bg-amber-500",
                          healthScore.risk_level === "critical" && "bg-red-500"
                        )}
                        style={{ width: `${healthScore.score}%` }}
                      />
                    </div>
                    {healthScore.issues.length > 0 && (
                      <ul className="text-xs text-muted-foreground space-y-1">
                        {healthScore.issues.slice(0, 3).map((issue, i) => (
                          <li key={i} className="flex items-start gap-1">
                            <CircleDot className="h-3 w-3 mt-0.5 shrink-0" />
                            {issue}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No health score calculated yet.</p>
                )}
                {unresolvedInterventionsCount > 0 && (
                  <p className="text-xs text-amber-600 mt-2">
                    {unresolvedInterventionsCount} unresolved intervention(s)
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Next Deadline */}
            {deadlines.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Next Deadlines</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {deadlines.map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span>{d.deadline_type.replace(/_/g, " ")}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {new Date(d.deadline_date).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Participants & Docs Summary */}
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Participants
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{participants.length}</div>
                  <div className="text-xs text-muted-foreground space-x-2">
                    {Object.entries(participantCountsByRole).map(([role, count]) => (
                      <span key={role}>
                        {count} {role}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Documents
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{documents.length}</div>
                  <div className="text-xs text-muted-foreground space-x-2">
                    {documentCountsByStatus.approved && (
                      <span className="text-green-600">{documentCountsByStatus.approved} approved</span>
                    )}
                    {documentCountsByStatus.pending && (
                      <span className="text-amber-600">{documentCountsByStatus.pending} pending</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* RIGHT: Tasks & Timeline */}
          <div className="lg:col-span-4 space-y-4">
            {/* Active Tasks */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Active Tasks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active tasks.</p>
                ) : (
                  tasks.slice(0, 5).map((task) => (
                    <div key={task.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 rounded"
                        disabled
                      />
                      <div className="flex-1 min-w-0">
                        <p className="truncate">{task.title}</p>
                        {task.due_date && (
                          <p className="text-xs text-muted-foreground">
                            Due {new Date(task.due_date).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Recent Timeline */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {timeline.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent activity.</p>
                  ) : (
                    timeline.slice(0, 6).map((event) => (
                      <div key={event.id} className="flex gap-2 text-sm">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">{event.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(event.occurred_at).toLocaleString()}
                            {event.actor_name && ` by ${event.actor_name}`}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Tabs Section */}
        <div className="mt-6">
          <Tabs defaultValue="milestones">
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="milestones" className="text-xs">
                <Calendar className="h-3 w-3 mr-1" />
                Milestones
              </TabsTrigger>
              <TabsTrigger value="deadlines" className="text-xs">
                <Clock className="h-3 w-3 mr-1" />
                Deadlines
              </TabsTrigger>
              <TabsTrigger value="participants" className="text-xs">
                <Users className="h-3 w-3 mr-1" />
                Participants
              </TabsTrigger>
              <TabsTrigger value="lender" className="text-xs">
                <Building2 className="h-3 w-3 mr-1" />
                Lender
              </TabsTrigger>
              <TabsTrigger value="title" className="text-xs">
                <Home className="h-3 w-3 mr-1" />
                Title & Escrow
              </TabsTrigger>
              <TabsTrigger value="inspection" className="text-xs">
                <Shield className="h-3 w-3 mr-1" />
                Inspection
              </TabsTrigger>
              <TabsTrigger value="vendors" className="text-xs">
                <Wrench className="h-3 w-3 mr-1" />
                Vendors
              </TabsTrigger>
              <TabsTrigger value="documents" className="text-xs">
                <FileText className="h-3 w-3 mr-1" />
                Documents
              </TabsTrigger>
              <TabsTrigger value="repairs" className="text-xs">
                Repairs
              </TabsTrigger>
              <TabsTrigger value="compliance" className="text-xs">
                Compliance
              </TabsTrigger>
              <TabsTrigger value="commissions" className="text-xs">
                <DollarSign className="h-3 w-3 mr-1" />
                Commissions
              </TabsTrigger>
            </TabsList>

            {/* Milestones Tab */}
            <TabsContent value="milestones" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  <div className="space-y-2">
                    {milestones.map((m) => (
                      <div key={m.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "w-3 h-3 rounded-full",
                              m.status === "completed" && "bg-green-500",
                              m.status === "pending" && "bg-amber-500",
                              m.status === "overdue" && "bg-red-500"
                            )}
                          />
                          <span className="text-sm">{m.milestone_name.replace(/_/g, " ")}</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {m.completed_at
                            ? `Completed ${new Date(m.completed_at).toLocaleDateString()}`
                            : m.milestone_date
                            ? new Date(m.milestone_date).toLocaleDateString()
                            : "No date set"}
                        </div>
                      </div>
                    ))}
                    {milestones.length === 0 && (
                      <p className="text-sm text-muted-foreground">No milestones defined.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Deadlines Tab */}
            <TabsContent value="deadlines" className="mt-4">
              <Card>
                <CardContent className="pt-4 space-y-2">
                  {deadlines.map((d) => (
                    <div key={d.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <span className="text-sm">{d.deadline_type.replace(/_/g, " ")}</span>
                      <Badge variant={d.status === "pending" ? "secondary" : "default"}>
                        {new Date(d.deadline_date).toLocaleDateString()}
                      </Badge>
                    </div>
                  ))}
                  {deadlines.length === 0 && (
                    <p className="text-sm text-muted-foreground">No deadlines defined.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Participants Tab */}
            <TabsContent value="participants" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  <div className="grid gap-3">
                    {participants.map((p) => (
                      <div key={p.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div>
                          <p className="text-sm font-medium">{p.name}</p>
                          <p className="text-xs text-muted-foreground">{p.role} {p.company ? `at ${p.company}` : ""}</p>
                        </div>
                        <div className="text-xs text-muted-foreground text-right">
                          {p.email && <p>{p.email}</p>}
                          {p.phone && <p>{p.phone}</p>}
                        </div>
                      </div>
                    ))}
                    {participants.length === 0 && (
                      <p className="text-sm text-muted-foreground">No participants added.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Lender Tab */}
            <TabsContent value="lender" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  {lenderInfo ? (
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Lender</p>
                        <p className="font-medium">{lenderInfo.lender_name ?? "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Loan Officer</p>
                        <p className="font-medium">{lenderInfo.loan_officer ?? "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Loan Type</p>
                        <p className="font-medium">{lenderInfo.loan_type ?? "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Loan Amount</p>
                        <p className="font-medium">
                          {lenderInfo.loan_amount ? `$${lenderInfo.loan_amount.toLocaleString()}` : "Not set"}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Interest Rate</p>
                        <p className="font-medium">
                          {lenderInfo.interest_rate ? `${lenderInfo.interest_rate}%` : "Not set"}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Clear to Close</p>
                        <p className="font-medium">
                          {lenderInfo.clear_to_close_at
                            ? new Date(lenderInfo.clear_to_close_at).toLocaleDateString()
                            : "Pending"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No lender information added.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Title & Escrow Tab */}
            <TabsContent value="title" className="mt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Title & Escrow</CardTitle>
                </CardHeader>
                <CardContent>
                  {/* Title/Escrow Company Info (read-only display) */}
                  {titleEscrow && (titleEscrow.title_company || titleEscrow.escrow_company) && (
                    <div className="grid grid-cols-2 gap-4 text-sm mb-6 pb-4 border-b">
                      <div>
                        <p className="text-muted-foreground">Title Company</p>
                        <p className="font-medium">{titleEscrow.title_company ?? "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Escrow Company</p>
                        <p className="font-medium">{titleEscrow.escrow_company ?? "Not set"}</p>
                      </div>
                    </div>
                  )}

                  {/* Earnest Money Section - Editable */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-medium">Earnest Money</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="emAmount">Amount</Label>
                        <div className="relative mt-1">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                          <Input
                            id="emAmount"
                            type="number"
                            value={emAmount}
                            onChange={(e) => setEmAmount(e.target.value)}
                            placeholder="10000"
                            className="pl-6"
                          />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="emHeldBy">Held By</Label>
                        <Select value={emHeldBy} onValueChange={setEmHeldBy}>
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select holder" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="title_company">Title Company</SelectItem>
                            <SelectItem value="escrow_company">Escrow Company</SelectItem>
                            <SelectItem value="listing_brokerage">Listing Brokerage</SelectItem>
                            <SelectItem value="buyers_brokerage">Buyers Brokerage</SelectItem>
                            <SelectItem value="attorney">Attorney</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor="emReceivedDate">Received Date</Label>
                        <Input
                          id="emReceivedDate"
                          type="date"
                          value={emReceivedDate}
                          onChange={(e) => setEmReceivedDate(e.target.value)}
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <Button
                      onClick={handleUpdateEarnestMoney}
                      disabled={isPending}
                    >
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                      Save Earnest Money
                    </Button>

                    {/* Status Indicator */}
                    {titleEscrow?.earnest_money_received_at && (
                      <Alert className="border-green-500 bg-green-50">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <AlertTitle className="text-green-800">Earnest Money Received</AlertTitle>
                        <AlertDescription className="text-green-700">
                          ${titleEscrow.earnest_money_amount?.toLocaleString() ?? emAmount} received on{" "}
                          {new Date(titleEscrow.earnest_money_received_at).toLocaleDateString()}{" "}
                          {titleEscrow.earnest_money_holder && `held by ${titleEscrow.earnest_money_holder.replace(/_/g, " ")}`}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Inspection Tab */}
            <TabsContent value="inspection" className="mt-4">
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Inspections</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowInspectionForm(!showInspectionForm)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Inspection
                  </Button>
                </CardHeader>
                <CardContent>
                  {/* Pending Quote Approvals */}
                  {pendingQuoteApprovals.filter(a => (a.metadata as Record<string,unknown>)?.quote_type === "inspector").length > 0 && (
                    <Alert className="mb-4 border-amber-500 bg-amber-50">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <AlertTitle className="text-amber-800">Quote Approval Needed</AlertTitle>
                      <AlertDescription className="text-amber-700">
                        {pendingQuoteApprovals
                          .filter(a => (a.metadata as Record<string,unknown>)?.quote_type === "inspector")
                          .map((a) => {
                            const meta = a.metadata as Record<string,unknown>
                            return (
                              <div key={a.id} className="flex items-center justify-between mt-2">
                                <span>{meta.vendor_name as string} - ${(meta.quote_amount as number)?.toLocaleString()}</span>
                                <Button
                                  size="sm"
                                  onClick={() => handleApproveQuote(a.id, meta.vendor_name as string, "inspector")}
                                  disabled={isPending}
                                >
                                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve"}
                                </Button>
                              </div>
                            )
                          })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Schedule Inspection Form */}
                  {showInspectionForm && (
                    <div className="border rounded-lg p-4 mb-4 space-y-3 bg-muted/30">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="inspectionType">Inspection Type</Label>
                          <Select value={inspectionType} onValueChange={setInspectionType}>
                            <SelectTrigger className="mt-1">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="home_inspection">Home Inspection</SelectItem>
                              <SelectItem value="pest_inspection">Pest Inspection</SelectItem>
                              <SelectItem value="radon_inspection">Radon Inspection</SelectItem>
                              <SelectItem value="roof_inspection">Roof Inspection</SelectItem>
                              <SelectItem value="sewer_inspection">Sewer Inspection</SelectItem>
                              <SelectItem value="structural_inspection">Structural Inspection</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label htmlFor="inspectorName">Inspector Name *</Label>
                          <Input
                            id="inspectorName"
                            value={inspectorName}
                            onChange={(e) => setInspectorName(e.target.value)}
                            placeholder="John Smith"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="inspectorCompany">Company</Label>
                          <Input
                            id="inspectorCompany"
                            value={inspectorCompany}
                            onChange={(e) => setInspectorCompany(e.target.value)}
                            placeholder="ABC Inspections"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="inspectorEmail">Email</Label>
                          <Input
                            id="inspectorEmail"
                            type="email"
                            value={inspectorEmail}
                            onChange={(e) => setInspectorEmail(e.target.value)}
                            placeholder="inspector@example.com"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="inspectorPhone">Phone</Label>
                          <Input
                            id="inspectorPhone"
                            value={inspectorPhone}
                            onChange={(e) => setInspectorPhone(e.target.value)}
                            placeholder="(555) 123-4567"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="inspectionDate">Scheduled Date</Label>
                          <Input
                            id="inspectionDate"
                            type="date"
                            value={inspectionDate}
                            onChange={(e) => setInspectionDate(e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="inspectionCost">Cost</Label>
                          <Input
                            id="inspectionCost"
                            type="number"
                            value={inspectionCost}
                            onChange={(e) => setInspectionCost(e.target.value)}
                            placeholder="450"
                            className="mt-1"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button onClick={handleScheduleInspection} disabled={!inspectorName || isPending}>
                          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          Schedule Inspection
                        </Button>
                        <Button variant="outline" onClick={() => setShowInspectionForm(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Existing Inspections */}
                  {inspections.length > 0 ? (
                    <div className="space-y-3">
                      {inspections.map((insp) => (
                        <div key={insp.id} className="border rounded-lg p-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium">
                                {insp.inspection_type.replace(/_/g, " ")}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {insp.inspector_name}
                                {insp.inspector_company && ` at ${insp.inspector_company}`}
                              </p>
                              {insp.scheduled_date && (
                                <p className="text-xs text-muted-foreground">
                                  Scheduled: {new Date(insp.scheduled_date).toLocaleDateString()}
                                </p>
                              )}
                              {insp.cost && (
                                <p className="text-xs text-muted-foreground">
                                  Cost: ${insp.cost.toLocaleString()}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={
                                  insp.status === "report_received"
                                    ? "default"
                                    : insp.status === "scheduled"
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {insp.status.replace(/_/g, " ")}
                              </Badge>
                              {insp.status === "scheduled" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleMarkInspectionComplete(insp.id)}
                                  disabled={isPending}
                                >
                                  Mark Complete
                                </Button>
                              )}
                              {insp.report_url && (
                                <Button size="sm" variant="ghost" asChild>
                                  <a href={insp.report_url} target="_blank" rel="noopener noreferrer">
                                    <FileText className="h-4 w-4" />
                                  </a>
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !showInspectionForm && (
                      <p className="text-sm text-muted-foreground">No inspections scheduled yet.</p>
                    )
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Vendors Tab (Insurance Quotes) */}
            <TabsContent value="vendors" className="mt-4">
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Insurance Quotes</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowInsuranceForm(!showInsuranceForm)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Request Quote
                  </Button>
                </CardHeader>
                <CardContent>
                  {/* Pending Insurance Quote Approvals */}
                  {pendingQuoteApprovals.filter(a => (a.metadata as Record<string,unknown>)?.quote_type === "insurance").length > 0 && (
                    <Alert className="mb-4 border-amber-500 bg-amber-50">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <AlertTitle className="text-amber-800">Quote Approval Needed</AlertTitle>
                      <AlertDescription className="text-amber-700">
                        {pendingQuoteApprovals
                          .filter(a => (a.metadata as Record<string,unknown>)?.quote_type === "insurance")
                          .map((a) => {
                            const meta = a.metadata as Record<string,unknown>
                            return (
                              <div key={a.id} className="flex items-center justify-between mt-2">
                                <span>{meta.vendor_name as string} - ${(meta.quote_amount as number)?.toLocaleString()}/yr</span>
                                <Button
                                  size="sm"
                                  onClick={() => handleApproveQuote(a.id, meta.vendor_name as string, "insurance")}
                                  disabled={isPending}
                                >
                                  {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve"}
                                </Button>
                              </div>
                            )
                          })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* Request Insurance Quote Form */}
                  {showInsuranceForm && (
                    <div className="border rounded-lg p-4 mb-4 space-y-3 bg-muted/30">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="insuranceVendorName">Insurance Provider *</Label>
                          <Input
                            id="insuranceVendorName"
                            value={insuranceVendorName}
                            onChange={(e) => setInsuranceVendorName(e.target.value)}
                            placeholder="State Farm"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="insuranceVendorEmail">Email</Label>
                          <Input
                            id="insuranceVendorEmail"
                            type="email"
                            value={insuranceVendorEmail}
                            onChange={(e) => setInsuranceVendorEmail(e.target.value)}
                            placeholder="agent@statefarm.com"
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label htmlFor="insuranceVendorPhone">Phone</Label>
                          <Input
                            id="insuranceVendorPhone"
                            value={insuranceVendorPhone}
                            onChange={(e) => setInsuranceVendorPhone(e.target.value)}
                            placeholder="(555) 123-4567"
                            className="mt-1"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button onClick={handleRequestInsuranceQuote} disabled={!insuranceVendorName || isPending}>
                          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          Request Quote
                        </Button>
                        <Button variant="outline" onClick={() => setShowInsuranceForm(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Existing Insurance Quotes */}
                  {vendorServices.filter(v => v.service_type === "insurance_quote").length > 0 ? (
                    <div className="space-y-3">
                      {vendorServices
                        .filter(v => v.service_type === "insurance_quote")
                        .map((v) => (
                          <div key={v.id} className="border rounded-lg p-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium">{v.vendor_name}</p>
                                {v.vendor_email && (
                                  <p className="text-xs text-muted-foreground">{v.vendor_email}</p>
                                )}
                                {v.cost && (
                                  <p className="text-xs font-medium text-green-600">
                                    ${v.cost.toLocaleString()}/yr
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge
                                  variant={
                                    v.status === "approved"
                                      ? "default"
                                      : v.status === "pending_approval"
                                      ? "secondary"
                                      : "outline"
                                  }
                                >
                                  {v.status.replace(/_/g, " ")}
                                </Badge>
                                {v.status === "quote_requested" && (
                                  <div className="flex items-center gap-2">
                                    <Input
                                      type="number"
                                      placeholder="Amount"
                                      className="w-24 h-8"
                                      value={insuranceQuoteAmount}
                                      onChange={(e) => setInsuranceQuoteAmount(e.target.value)}
                                    />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleSubmitInsuranceQuoteAmount(v.id, v.vendor_name)}
                                      disabled={!insuranceQuoteAmount || isPending}
                                    >
                                      Submit
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    !showInsuranceForm && (
                      <p className="text-sm text-muted-foreground">No insurance quotes requested yet.</p>
                    )
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Documents Tab */}
            <TabsContent value="documents" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  {documents.length > 0 ? (
                    <div className="space-y-2">
                      {documents.map((d) => (
                        <div key={d.id} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div>
                            <p className="text-sm font-medium">{d.file_name}</p>
                            <p className="text-xs text-muted-foreground">{d.doc_type.replace(/_/g, " ")}</p>
                          </div>
                          <Badge
                            variant={
                              d.status === "approved"
                                ? "default"
                                : d.status === "rejected"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {d.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No documents uploaded.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Repairs Tab */}
            <TabsContent value="repairs" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  {repairs.length > 0 ? (
                    <div className="space-y-2">
                      {repairs.map((r) => (
                        <div key={r.id} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div>
                            <p className="text-sm font-medium">{r.description}</p>
                            <p className="text-xs text-muted-foreground">
                              Est: {r.cost_estimate ? `$${r.cost_estimate.toLocaleString()}` : "TBD"}
                            </p>
                          </div>
                          <Badge>{r.status}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No repairs tracked.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Compliance Tab */}
            <TabsContent value="compliance" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  {complianceAlerts.length > 0 ? (
                    <div className="space-y-2">
                      {complianceAlerts.map((a) => (
                        <div key={a.id} className="flex items-start gap-3 py-2 border-b last:border-0">
                          <AlertTriangle
                            className={cn(
                              "h-4 w-4 mt-0.5 shrink-0",
                              a.severity === "critical" && "text-red-500",
                              a.severity === "warning" && "text-amber-500",
                              a.severity === "info" && "text-blue-500"
                            )}
                          />
                          <div className="flex-1">
                            <p className="text-sm">{a.message}</p>
                            <p className="text-xs text-muted-foreground">
                              {a.alert_type} | {a.resolved_at ? "Resolved" : "Open"}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No compliance alerts.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Commissions Tab */}
            <TabsContent value="commissions" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  {commissionSplits.length > 0 ? (
                    <div className="space-y-2">
                      {commissionSplits.map((c) => (
                        <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div>
                            <p className="text-sm font-medium">{c.recipient_name}</p>
                            <p className="text-xs text-muted-foreground">{c.recipient_type}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium">{c.percentage}%</p>
                            {c.amount && (
                              <p className="text-xs text-muted-foreground">${c.amount.toLocaleString()}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No commission splits defined.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Blockers Modal */}
      <Dialog open={showBlockersModal} onOpenChange={setShowBlockersModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Cannot Advance Stage
            </DialogTitle>
            <DialogDescription>
              The following items must be resolved before advancing to {targetStage?.replace(/_/g, " ")}:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            {blockers.map((blocker, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                <span>{blocker}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBlockersModal(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Advance Modal */}
      <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Stage Advancement</DialogTitle>
            <DialogDescription>
              Advance this transaction to {targetStage?.replace(/_/g, " ")}?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea
              id="reason"
              placeholder="Add a note for this stage change..."
              value={advanceReason}
              onChange={(e) => setAdvanceReason(e.target.value)}
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmModal(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={confirmAdvance} disabled={isPending}>
              {isPending ? "Advancing..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark Lost Modal */}
      <Dialog open={showLostModal} onOpenChange={setShowLostModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              Mark Transaction Lost
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. Please provide details about why this transaction was lost.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="lostCategory">Category</Label>
              <Select value={lostCategory} onValueChange={setLostCategory}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="financing_fell_through">Financing Fell Through</SelectItem>
                  <SelectItem value="inspection_issues">Inspection Issues</SelectItem>
                  <SelectItem value="appraisal_gap">Appraisal Gap</SelectItem>
                  <SelectItem value="buyer_cold_feet">Buyer Cold Feet</SelectItem>
                  <SelectItem value="seller_withdrew">Seller Withdrew</SelectItem>
                  <SelectItem value="title_issues">Title Issues</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="lostReason">Reason</Label>
              <Textarea
                id="lostReason"
                placeholder="Describe what happened..."
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="earnestOutcome">Earnest Money Outcome</Label>
              <Select value={earnestOutcome} onValueChange={(v) => setEarnestOutcome(v as "returned" | "forfeited")}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="returned">Returned to Buyer</SelectItem>
                  <SelectItem value="forfeited">Forfeited to Seller</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLostModal(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmMarkLost}
              disabled={isPending || !lostReason || !lostCategory}
            >
              {isPending ? "Processing..." : "Mark Lost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
