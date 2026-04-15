"use client"

import { useState, useTransition, useEffect } from "react"
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
  CheckCircle2,
  Clock,
  AlertTriangle,
  CircleDot,
  FileText,
  Users,
  Sparkles,
  ChevronDown,
  Loader2,
  Home,
  DollarSign,
  CalendarDays,
  Building2,
  Scale,
  ClipboardList,
  PenLine,
  Brain,
  TrendingDown,
  Landmark,
  ExternalLink,
  Plus,
  ShieldCheck,
  Bell,
  Share2,
  ChevronRight,
  XCircle,
} from "lucide-react"
import { format } from "date-fns"
import { createClient } from "@/lib/supabase/client"
import { DepositTrackerDialog } from "@/app/dashboard/financials/agent/components/deposit-tracker-dialog"
import { reviewTransactionDocuments, generateDocumentChecklist } from "@/app/actions/ai-contract-review"
import { predictDealCloseProbability } from "@/app/actions/ai-predictions"
import {
  logTransactionDelay,
  getTransactionDelays,
} from "@/app/actions/transaction-transparency"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { Progress } from "@/components/ui/progress"
import { SuggestedVendors } from "@/app/components/transactions/suggested-vendors"
import { SendForSignaturesPanel } from "@/app/components/shared/SendForSignaturesPanel"
import { DocumentSignaturePanel } from "@/app/components/shared/DocumentSignaturePanel"
import { isSignableDocType } from "@/lib/documents/signable-doc-types"
import { AssignTCPanel } from "./assign-tc-panel"
import { AssignLenderPanel } from "./assign-lender-panel"
import { VendorBookingsPanel } from "@/app/dashboard/components/vendor-bookings-panel"
import {
  analyzeTransactionDocument,
  generateTransactionDocumentReminders,
  checkTransactionDisclosures,
  shareDocumentAnalysisWithClient,
} from "@/app/actions/ai-transaction-documents"
import {
  resolveFormsProviderAction,
  loadAvailableFormsAction,
} from "@/app/actions/forms-kernel"
import {
  TransactionFormEsignFlow,
  type FormTemplate,
} from "./components/transaction-form-esign-flow"

// ─── TYPES ─────────────────────────────────────────────────────────────────────

interface TransactionDetailClientProps {
  // Uses actual Supabase transactions table columns
  transaction: {
    id: string
    brokerage_id: string
    agent_id: string
    contact_id: string
    property_address: string
    property_city: string | null
    property_state: string | null
    property_zip: string | null
    purchase_price: number
    status: string
    stage: string
    contract_date: string | null
    close_date: string | null
    compliance_passed_at: string | null
    deal_type: string | null
    deal_name: string | null
    client_name: string | null
    listing_id: string | null
    health_score: number | null
    commission_percentage: number | null
    estimated_commission: number | null
    created_at: string
    updated_at: string
  }
  brokerageId: string
  brokerageName?: string
  brokerageLogoUrl?: string
  userRole: string
  userId: string
  milestones: Array<{
    id: string
    milestone_name: string
    milestone_date: string | null
    status: string
    completed_at: string | null
    notes: string | null
    is_client_visible: boolean | null
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
  // Uses actual Supabase transaction_documents table columns
  documents: Array<{
    id: string
    doc_type: string
    doc_label: string | null
    status: string
    storage_url: string | null
    uploaded_at: string
    notes: string | null
    rejection_reason: string | null
    extracted_data: Record<string, unknown> | null
    classification_confidence: number | null
  }>
  documentCountsByStatus: Record<string, number>
  // Uses actual Supabase deal_health_scores table columns
  healthScore: {
    id: string
    overall_score: number
    risk_level: string
    score_components: Record<string, number> | null
    flags: string[] | null
    ai_narrative: string | null
    previous_score: number | null
    score_delta: number | null
    scored_at: string
  } | null
  unresolvedInterventionsCount: number
  tasks: Array<{
    id: string
    title: string
    status: string
    due_date: string | null
    assigned_to: string | null
  }>
  // Uses actual Supabase transaction_timeline table columns
  timeline: Array<{
    id: string
    activity_type: string
    description: string
    created_at: string
    performed_by: string | null
    metadata: Record<string, unknown> | null
  }>
  // Uses actual Supabase transaction_title_escrow table columns
  titleEscrow: {
    id: string
    title_company_name: string | null
    title_officer_name: string | null
    title_officer_email: string | null
    title_officer_phone: string | null
    escrow_company_name: string | null
    escrow_officer_name: string | null
    escrow_officer_email: string | null
    escrow_officer_phone: string | null
    escrow_number: string | null
    earnest_money_amount: number | null
    earnest_money_received_date: string | null
    earnest_money_held_by: string | null
    title_search_ordered_date: string | null
    title_search_completed_date: string | null
    title_commitment_date: string | null
    title_issues: string | null
    closing_scheduled_date: string | null
    closing_location: string | null
  } | null
  // Uses actual Supabase transaction_inspections table columns
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
    issues_found: string | null
    notes: string | null
    quote_activity_id: string | null
    quote_approved: boolean | null
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
  // Uses actual Supabase transaction_repair_negotiations table columns
  repairs: Array<{
    id: string
    item_description: string
    status: string
    estimated_cost: number | null
    actual_cost: number | null
    requested_by: string | null
    priority: string | null
    notes: string | null
    response_note: string | null
    responded_at: string | null
  }>
  // Uses actual Supabase transaction_lenders table columns
  lenderInfo: {
    id: string
    lender_name: string | null
    loan_officer_name: string | null
    loan_officer_email: string | null
    loan_officer_phone: string | null
    loan_type: string | null
    loan_amount: number | null
    interest_rate: number | null
    loan_term_years: number | null
    pre_approval_date: string | null
    pre_approval_amount: number | null
    appraisal_ordered_date: string | null
    appraisal_completed_date: string | null
    appraisal_value: number | null
    underwriting_status: string | null
    clear_to_close_date: string | null
  } | null
  // Uses actual Supabase transaction_compliance_log table columns
  complianceLogs: Array<{
    id: string
    check_type: string
    check_label: string | null
    status: string
    is_blocking: boolean | null
    checked_by: string | null
    checked_at: string | null
    failure_reason: string | null
    resolution_notes: string | null
    resolved_by: string | null
    resolved_at: string | null
  }>
  // Uses actual Supabase transaction_commissions table columns
  commissions: Array<{
    id: string
    recipient_type: string
    recipient_name: string
    recipient_id: string | null
    commission_type: string | null
    rate_percentage: number | null
    flat_amount: number | null
    split_percentage: number | null
    calculated_amount: number | null
    status: string
    paid_date: string | null
  }>
  stages: TransactionStage[]
  currentStageIndex: number
  // Contact details for e-sign
  contactEmail?: string | null
  contactName?: string | null
  // E-sign provider resolved from platform_credentials (null = none connected)
  connectedEsignProvider?: { platform: string; accountName: string | null } | null
  // Linked buyer offer for signature workflow (null = no offer linked)
  linkedOffer?: {
    id: string
    esign_status?: string | null
    esign_provider?: string | null
    esign_sent_at?: string | null
    esign_completed_at?: string | null
    buyer_signed_at?: string | null
  } | null
  // Existing contract_signatures rows for this brokerage — keyed by contract_type
  contractSignatures?: Record<string, {
    id: string
    esign_status: string
    provider_name: string | null
    sent_at: string | null
    agent_signed_at: string | null
    fully_signed_at: string | null
  }>
  // TC assignment
  currentCoordinatorId?: string | null
  availableTCs?: Array<{
    id: string
    display_name: string | null
    max_active_deals: number | null
  }>
  // Lender assignment
  currentLenderId?: string | null
  availableLenders?: Array<{
    id: string
    lender_company: string | null
  }>
  // Vendor bookings
  vendorBookings?: Array<{
    id: string
    service_type: string | null
    status: string | null
    scheduled_date: string | null
    notes: string | null
    contact_id: string | null
    listing_id: string | null
    vendors: { name: string } | null
  }>
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const LOAN_STAGES = [
  "lender_assigned",
  "preapproval_received",
  "application_in_progress",
  "underwriting",
  "conditional_approval",
  "clear_to_close",
] as const

type LoanStage = typeof LOAN_STAGES[number]

function deriveLoanStatus(info: TransactionDetailClientProps["lenderInfo"]): LoanStage | "no_lender_assigned" {
  if (!info) return "no_lender_assigned"
  if (info.clear_to_close_date) return "clear_to_close"
  if (info.underwriting_status === "approved") return "conditional_approval"
  if (info.underwriting_status === "in_review") return "underwriting"
  if (info.appraisal_completed_date) return "application_in_progress"
  if (info.pre_approval_date) return "preapproval_received"
  return "lender_assigned"
}

// ─── COMPONENT ─────────────────────────────────────────────────────────────────

export function TransactionDetailClient({
  transaction,
  brokerageId,
  brokerageName,
  brokerageLogoUrl,
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
  complianceLogs,
  commissions,
  stages,
  currentStageIndex,
  contactEmail,
  contactName,
  connectedEsignProvider,
  linkedOffer,
  contractSignatures = {},
  currentCoordinatorId = null,
  availableTCs = [],
  currentLenderId = null,
  availableLenders = [],
  vendorBookings = [],
}: TransactionDetailClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Local milestones state — allows optimistic visibility toggle updates
  const [localMilestones, setLocalMilestones] = useState(milestones)

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

  // Earnest money form state (using actual Supabase column names)
  const [emAmount, setEmAmount] = useState(titleEscrow?.earnest_money_amount?.toString() ?? "")
  const [emHeldBy, setEmHeldBy] = useState(titleEscrow?.earnest_money_held_by ?? "")
  const [emReceivedDate, setEmReceivedDate] = useState(titleEscrow?.earnest_money_received_date ?? "")

  // Forms tab state — lazy loaded when tab is first opened
  const [formsProvider, setFormsProvider] = useState<{ provider_name: string; is_configured: boolean } | null>(null)
  const [availableForms, setAvailableForms] = useState<Array<{ id: string; name: string; category: string; form_type: string; is_required: boolean; description?: string }>>([])
  const [formsLoading, setFormsLoading] = useState(false)
  const [formsLoaded, setFormsLoaded] = useState(false)
  const [activeTab, setActiveTab] = useState("milestones")

  // E-sign flow sheet state
  const [esignFlowForm, setEsignFlowForm] = useState<FormTemplate | null>(null)

  // Deal Health Prediction — loaded once on mount, no blocking
  const [dealPrediction, setDealPrediction] = useState<any>(null)
  const [dealPredLoading, setDealPredLoading] = useState(false)

  useEffect(() => {
    setDealPredLoading(true)
    predictDealCloseProbability(transaction.id)
      .then(setDealPrediction)
      .catch(() => null)
      .finally(() => setDealPredLoading(false))
  }, [transaction.id])

  // E-sign local state (optimistic updates for linked offer)
  const [esignSent, setEsignSent] = useState(false)

  // Contract review state
  const [contractReview, setContractReview] = useState<any>(null)
  const [reviewLoading, setReviewLoading] = useState(false)

  // Delay tracking state
  const [delays, setDelays] = useState<any>(null)
  const [transparencyUpdates, setTransparencyUpdates] = useState<any[]>([])
  const [delaySheetOpen, setDelaySheetOpen] = useState(false)
  const [selectedDelayTypes, setSelectedDelayTypes] = useState<string[]>([])
  const [delayReasonText, setDelayReasonText] = useState("")
  const [impactDays, setImpactDays] = useState(5)
  const [notifyClient, setNotifyClient] = useState(false)
  const [isLoggingDelay, setIsLoggingDelay] = useState(false)

  useEffect(() => {
    getTransactionDelays(transaction.id).then(({ delays: d, updates: u }) => {
      setDelays(d)
      setTransparencyUpdates(u)
    })
  }, [transaction.id])

  // Lazy-load transaction forms when the Forms tab is first opened
  useEffect(() => {
    if (activeTab !== "forms" || formsLoaded || formsLoading) return
    setFormsLoading(true)
    Promise.all([
      resolveFormsProviderAction(),
      loadAvailableFormsAction({
        context_type: "transaction",
        state: transaction.property_state ?? undefined,
      }),
    ]).then(([providerRes, formsRes]) => {
      if (providerRes.success && providerRes.data) {
        setFormsProvider(providerRes.data)
      }
      if (formsRes.success && formsRes.data) {
        setAvailableForms(formsRes.data.forms)
      }
      setFormsLoaded(true)
      setFormsLoading(false)
    }).catch(() => setFormsLoading(false))
  }, [activeTab, formsLoaded, formsLoading, transaction.property_state])

  // Deposits state
  const [deposits, setDeposits] = useState<Array<{
    id: string
    deposit_type: string
    amount: number
    received_date: string
    due_date: string | null
    escrow_company: string | null
    check_number: string | null
    status: string
    delivered_to_escrow_at: string | null
    notes: string | null
  }>>([])

  const [complianceTasks, setComplianceTasks] = useState<Array<{
    id: string
    task_type: string
    description: string
    due_date: string | null
    status: string
    completed_at: string | null
    completed_by: string | null
  }>>([])

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase
        .from("deposits")
        .select("id, deposit_type, amount, received_date, due_date, escrow_company, check_number, status, delivered_to_escrow_at, notes")
        .eq("transaction_id", transaction.id)
        .order("received_date", { ascending: false }),
      supabase
        .from("compliance_tasks")
        .select("id, task_type, description, due_date, status, completed_at, completed_by")
        .eq("transaction_id", transaction.id)
        .order("due_date", { ascending: true }),
    ]).then(([depositsResult, complianceResult]) => {
      if (depositsResult.data) setDeposits(depositsResult.data)
      if (complianceResult.data) setComplianceTasks(complianceResult.data)
    })
  }, [transaction.id])
  const [docChecklist, setDocChecklist] = useState<any[]>([])
  const [checklistLoading, setChecklistLoading] = useState(false)
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set())

  // AI Document Intelligence state
  const [analyzingDocId, setAnalyzingDocId] = useState<string | null>(null)
  const [docAnalysisResults, setDocAnalysisResults] = useState<Record<string, Record<string, unknown>>>({})
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null)
  const [disclosureResult, setDisclosureResult] = useState<{
    complianceScore?: number
    missingDisclosures?: string[]
    issues?: string[]
    recommendations?: string[]
  } | null>(null)
  const [disclosureLoading, setDisclosureLoading] = useState(false)
  const [remindersLoading, setRemindersLoading] = useState(false)
  const [remindersCreated, setRemindersCreated] = useState<number | null>(null)
  const [sharingDocId, setSharingDocId] = useState<string | null>(null)

  const currentStage = transaction.stage as TransactionStage
  const allowedNextStages = STAGE_TRANSITIONS[currentStage] || []
  const canAdvance = allowedNextStages.length > 0 && currentStage !== "CLOSED" && currentStage !== "LOST"
  const canMarkLost = currentStage !== "CLOSED" && currentStage !== "LOST"

  // Missing blocking conditions
  const missingContractDate = !transaction.contract_date
  const missingCompliance = !transaction.compliance_passed_at

  // ──�� HANDLERS ────────────────────────────────────────────────────────────────

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

  // ─── AI DOCUMENT INTELLIGENCE HANDLERS ──────────────────────────────────────

  async function handleAnalyzeDocument(docId: string) {
    setAnalyzingDocId(docId)
    try {
      const result = await analyzeTransactionDocument({
        documentId: docId,
        transactionId: transaction.id,
        brokerageId,
        agentId: transaction.agent_id,
      })
      if (result.success && result.extracted) {
        setDocAnalysisResults((prev) => ({ ...prev, [docId]: result.extracted! }))
        setExpandedDocId(docId)
        toast.success("Document analyzed")
      } else {
        toast.error(result.error ?? "Analysis failed")
      }
    } finally {
      setAnalyzingDocId(null)
    }
  }

  async function handleCheckDisclosures() {
    setDisclosureLoading(true)
    try {
      const result = await checkTransactionDisclosures({
        transactionId: transaction.id,
        brokerageId,
        agentId: transaction.agent_id,
        state: transaction.property_state ?? "CA",
      })
      if (result.success) {
        setDisclosureResult(result)
        toast.success("Disclosure check complete")
      } else {
        toast.error(result.error ?? "Disclosure check failed")
      }
    } finally {
      setDisclosureLoading(false)
    }
  }

  async function handleGenerateReminders() {
    setRemindersLoading(true)
    try {
      const result = await generateTransactionDocumentReminders({
        transactionId: transaction.id,
        brokerageId,
        agentId: transaction.agent_id,
      })
      if (result.success) {
        setRemindersCreated(result.remindersCreated ?? 0)
        toast.success(`${result.remindersCreated} reminder task(s) created`)
        router.refresh()
      } else {
        toast.error(result.error ?? "Failed to generate reminders")
      }
    } finally {
      setRemindersLoading(false)
    }
  }

  async function handleShareWithClient(docId: string, docLabel: string, analysis: Record<string, unknown>) {
    if (!transaction.contact_id) {
      toast.error("No contact linked to this transaction")
      return
    }
    setSharingDocId(docId)
    try {
      const analysisText = [
        analysis.summary ? `Summary: ${analysis.summary}` : null,
        Array.isArray(analysis.redFlags) && analysis.redFlags.length > 0
          ? `Items to note: ${(analysis.redFlags as string[]).join(", ")}`
          : null,
        Array.isArray(analysis.recommendedActions) && analysis.recommendedActions.length > 0
          ? `Next steps: ${(analysis.recommendedActions as string[]).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n")

      const result = await shareDocumentAnalysisWithClient({
        transactionId: transaction.id,
        contactId: transaction.contact_id,
        brokerageId,
        agentId: transaction.agent_id,
        documentLabel: docLabel,
        analysisText,
      })
      if (result.success) {
        toast.success("Analysis shared with client via portal")
      } else {
        toast.error(result.error ?? "Failed to share")
      }
    } finally {
      setSharingDocId(null)
    }
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

  // ─── CONTRACT REVIEW HANDLERS ─────────────────────────────────────────────────

  const getState = () => transaction.property_state || (() => {
    const m = (transaction.property_address || '').split(',').pop()?.trim().match(/\b([A-Z]{2})\b/)
    return m?.[1] || 'FL'
  })()

  const handleReviewDocuments = async () => {
    setReviewLoading(true)
    try {
      const result = await reviewTransactionDocuments({
        transactionId: transaction.id,
        agentId: transaction.agent_id,
        state: getState(),
      })
      if (result.success !== false) setContractReview(result)
    } catch {}
    finally { setReviewLoading(false) }
  }

  const handleGenerateChecklist = async () => {
    setChecklistLoading(true)
    try {
      const txType:'purchase'|'sale'|'lease' = transaction.deal_type === 'seller' ? 'sale' : 'purchase'
      const result = await generateDocumentChecklist({
        transactionId: transaction.id,
        transactionType: txType,
        state: getState(),
        agentId: transaction.agent_id,
      })
      if ((result as any).checklist) setDocChecklist((result as any).checklist)
    } catch {}
    finally { setChecklistLoading(false) }
  }

  // ─── RENDER ──────────────────────────────���────────────────────────────────��──

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
              {(transaction.property_city || transaction.property_state || transaction.property_zip) && (
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {[transaction.property_city, transaction.property_state, transaction.property_zip]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                ${transaction.purchase_price?.toLocaleString()} | {transaction.deal_type ?? "Purchase"}
              </p>
            </div>
            {currentStage === "CLOSING_PREP" && (
              <Link href={`/dashboard/transactions/${transaction.id}/cda`}>
                <Button variant="outline" size="sm">
                  <FileText className="h-4 w-4 mr-2" />
                  CDA Workflow
                </Button>
              </Link>
            )}
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
                  <div className="pt-3 border-t mt-3 space-y-1">
                    {/* Close Transaction — sets status=closed, stage=CLOSED */}
                    {currentStage !== "CLOSED" && currentStage !== "LOST" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-green-700 hover:text-green-800 hover:bg-green-50"
                        disabled={isPending}
                        onClick={() => {
                          startTransition(async () => {
                            const { closeTransaction } = await import("@/app/actions/transactions")
                            const result = await closeTransaction({
                              transactionId: transaction.id,
                              brokerageId,
                              agentId: transaction.agent_id,
                            })
                            if (result.success) {
                              toast.success("Transaction closed")
                              router.refresh()
                            } else {
                              toast.error(result.error ?? "Failed to close transaction")
                            }
                          })
                        }}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Close Transaction
                      </Button>
                    )}
                    {/* Reopen — only shown when closed; requires broker/admin */}
                    {currentStage === "CLOSED" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                        disabled={isPending}
                        onClick={() => {
                          const reason = window.prompt("Reason for reopening this transaction:")
                          if (!reason) return
                          startTransition(async () => {
                            const { reopenTransactionIfAuthorized } = await import("@/app/actions/transactions")
                            const result = await reopenTransactionIfAuthorized({
                              transactionId: transaction.id,
                              brokerageId,
                              requestingUserId: transaction.agent_id,
                              requestingUserRole: "broker",
                              reason,
                            })
                            if (result.success) {
                              toast.success("Transaction reopened")
                              router.refresh()
                            } else {
                              toast.error(result.error ?? "Reopen failed — broker/admin only")
                            }
                          })
                        }}
                      >
                        <CircleDot className="h-4 w-4 mr-2" />
                        Reopen Transaction
                      </Button>
                    )}
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
              <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">Deal Summary</CardTitle>
                {/* Send Client Update — writes to client_friendly_updates table */}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7"
                  disabled={isPending}
                  onClick={() => {
                    const text = window.prompt("Enter plain-language update for the client (shown in portal):")
                    if (!text?.trim()) return
                    startTransition(async () => {
                      const { emitClientFriendlyUpdate } = await import("@/app/actions/transactions")
                      const result = await emitClientFriendlyUpdate({
                        transactionId: transaction.id,
                        brokerageId,
                        agentId:       transaction.agent_id,
                        contactId:     transaction.contact_id,
                        updateType:    "general",
                        updateText:    text.trim(),
                        sendVia:       "portal",
                      })
                      if (result.success) {
                        toast.success("Client update sent to portal")
                      } else {
                        toast.error(result.error ?? "Failed to send update")
                      }
                    })
                  }}
                >
                  <Bell className="h-3 w-3" />
                  Client Update
                </Button>
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
                  <div className="col-span-2">
                    <p className="text-muted-foreground">Brokerage</p>
                    {brokerageLogoUrl ? (
                      <img src={brokerageLogoUrl} alt={brokerageName ?? "Brokerage"} className="h-6 w-auto object-contain mt-1" />
                    ) : (
                      <p className="font-medium">{brokerageName ?? "—"}</p>
                    )}
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
                      {healthScore.overall_score}/100
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {healthScore ? (
                  <div className="space-y-3">
                    {/* Score bar */}
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full transition-all",
                          healthScore.risk_level === "healthy" && "bg-green-500",
                          (healthScore.risk_level === "at_risk" || healthScore.risk_level === "medium") && "bg-amber-500",
                          (healthScore.risk_level === "critical" || healthScore.risk_level === "high") && "bg-red-500"
                        )}
                        style={{ width: `${healthScore.overall_score}%` }}
                      />
                    </div>

                    {/* At-risk / critical tooltip with risk factors */}
                    {(healthScore.risk_level === "at_risk" || healthScore.risk_level === "critical" ||
                      healthScore.risk_level === "high" || healthScore.risk_level === "medium") && healthScore.flags && healthScore.flags.length > 0 && (
                      <div className={cn(
                        "rounded-md border p-3 text-xs space-y-1",
                        (healthScore.risk_level === "critical" || healthScore.risk_level === "high")
                          ? "border-red-200 bg-red-50 text-red-800"
                          : "border-amber-200 bg-amber-50 text-amber-800"
                      )}>
                        <TooltipProvider>
                          <p className="font-semibold flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {(healthScore.risk_level === "critical" || healthScore.risk_level === "high") ? "Critical Risk Factors" : "Risk Factors"}
                          </p>
                        </TooltipProvider>
                        <ul className="space-y-0.5 list-disc list-inside">
                          {healthScore.flags.slice(0, 5).map((flag, i) => (
                            <li key={i}>{flag}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* No flags but has score */}
                    {(!healthScore.flags || healthScore.flags.length === 0) && (
                      <p className="text-xs text-green-600 font-medium">No risk flags detected</p>
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

            {/* Deal Health Prediction */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Brain className="h-4 w-4 text-indigo-500" />
                  Deal Health Prediction
                </CardTitle>
              </CardHeader>
              <CardContent>
                {dealPredLoading && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Analyzing deal signals...
                  </div>
                )}
                {!dealPredLoading && dealPrediction && !dealPrediction.error && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Close Probability</span>
                      <span className={`text-sm font-bold ${
                        (dealPrediction.close_probability ?? 0) >= 70
                          ? "text-green-600"
                          : (dealPrediction.close_probability ?? 0) >= 40
                          ? "text-amber-600"
                          : "text-red-600"
                      }`}>
                        {dealPrediction.close_probability ?? 0}%
                      </span>
                    </div>
                    <Progress
                      value={dealPrediction.close_probability ?? 0}
                      className="h-1.5"
                    />
                    {dealPrediction.risk_factors?.length > 0 && (
                      <div className="pt-1 space-y-1">
                        {dealPrediction.risk_factors.slice(0, 2).map((r: string, i: number) => (
                          <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <TrendingDown className="h-3 w-3 text-red-400 mt-0.5 shrink-0" />
                            {r}
                          </div>
                        ))}
                      </div>
                    )}
                    {dealPrediction.recommended_action && (
                      <p className="text-xs text-indigo-700 bg-indigo-50 rounded px-2 py-1 border border-indigo-100">
                        {dealPrediction.recommended_action}
                      </p>
                    )}
                  </div>
                )}
                {!dealPredLoading && (!dealPrediction || dealPrediction.error) && (
                  <p className="text-xs text-muted-foreground">Prediction unavailable — insufficient data.</p>
                )}
              </CardContent>
            </Card>

            {/* Pending Signatures Blocker — shown when contract_signatures rows are not yet fully signed */}
            {Object.values(contractSignatures).some(s => s.esign_status !== "fully_signed") && (
              <Card className="border-amber-200 bg-amber-50/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
                    <PenLine className="h-4 w-4" />
                    Signatures Pending
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {Object.entries(contractSignatures)
                    .filter(([, s]) => s.esign_status !== "fully_signed")
                    .map(([docType, s]) => (
                      <div key={docType} className="flex items-center justify-between text-xs">
                        <span className="capitalize text-amber-900">{docType.replace(/_/g, " ")}</span>
                        <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-amber-200">
                          {s.esign_status?.replace(/_/g, " ") ?? "pending"}
                        </Badge>
                      </div>
                    ))}
                  <p className="text-xs text-amber-700 pt-1">
                    Go to the Documents tab to send or resend for signatures.
                  </p>
                </CardContent>
              </Card>
            )}

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

            {/* Assign TC Panel — broker/admin/tc only */}
            <AssignTCPanel
              transactionId={transaction.id}
              currentCoordinatorId={currentCoordinatorId}
              availableTCs={availableTCs}
              userRole={userRole}
            />

            {/* Assign Lender Panel */}
            <AssignLenderPanel
              transactionId={transaction.id}
              currentLenderId={currentLenderId}
              availableLenders={availableLenders}
              userRole={userRole}
            />

            {/* Lending Status Card */}
            {(() => {
              const loanStatus = deriveLoanStatus(lenderInfo)
              const currentIdx = LOAN_STAGES.indexOf(loanStatus as LoanStage)
              return (
                <Card className="mb-4">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                        Lending Status
                      </span>
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/portal/lender/${transaction.id}`}>
                          Lender Portal
                          <ExternalLink className="h-3 w-3 ml-1.5" />
                        </Link>
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm font-medium mb-3">
                      {lenderInfo?.lender_name ?? "No lender assigned yet"}
                      {lenderInfo?.loan_officer_name ? ` · ${lenderInfo.loan_officer_name}` : ""}
                    </p>
                    {/* Pipeline strip */}
                    <div className="flex gap-1 mb-2">
                      {LOAN_STAGES.map((stage, i) => (
                        <div
                          key={stage}
                          className={cn(
                            "h-2 flex-1 rounded-full transition-colors",
                            loanStatus === "no_lender_assigned"
                              ? "bg-muted"
                              : i < currentIdx
                              ? "bg-green-500"
                              : i === currentIdx
                              ? "bg-blue-500"
                              : "bg-muted"
                          )}
                          title={stage.replace(/_/g, " ")}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground capitalize">
                      {loanStatus === "no_lender_assigned"
                        ? "No lender assigned"
                        : loanStatus.replace(/_/g, " ")}
                    </p>
                    {loanStatus === "clear_to_close" && (
                      <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-800">
                        Clear to Close
                        {lenderInfo?.clear_to_close_date
                          ? ` · ${new Date(lenderInfo.clear_to_close_date).toLocaleDateString()}`
                          : ""}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })()}

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

            {/* Suggested Vendors */}
            {["INSPECTION", "APPRAISAL", "FINANCING_PENDING"].includes(currentStage) && (
              <SuggestedVendors
                transactionId={transaction.id}
                stage={currentStage}
                propertyAddress={transaction.property_address}
              />
            )}

            {/* Closing Timeline Status */}
            <Card className={delays?.delays?.length > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-950/20" : "border-green-200 bg-green-50 dark:bg-green-950/20"}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Closing Timeline Status
                  </CardTitle>
                  <Button size="sm" variant="outline" onClick={() => setDelaySheetOpen(true)}>
                    {delays?.delays?.length > 0 ? "Update Delay" : "Log Delay"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {delays?.delays?.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      {delays.impact_on_closing} day(s) impact on closing
                    </p>
                    {delays.delays.map((d: string, i: number) => (
                      <p key={i} className="text-xs text-amber-700 dark:text-amber-300">{d}</p>
                    ))}
                    {!delays.communicated_to_client ? (
                      <Button
                        size="sm"
                        className="mt-2 bg-amber-600 hover:bg-amber-700 text-white"
                        disabled={isLoggingDelay}
                        onClick={async () => {
                          setIsLoggingDelay(true)
                          const res = await logTransactionDelay({
                            transactionId: transaction.id,
                            delays: delays.delays,
                            reasons: delays.reason_for_delays,
                            impactDays: delays.impact_on_closing,
                            notifyClient: true,
                          })
                          setIsLoggingDelay(false)
                          if (res.success) {
                            toast.success("Client notified of delay")
                            setDelays({ ...delays, communicated_to_client: true })
                          } else {
                            toast.error(res.error ?? "Failed to notify client")
                          }
                        }}
                      >
                        {isLoggingDelay ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Notify Client Now
                      </Button>
                    ) : (
                      <p className="text-xs text-green-600 dark:text-green-400">Client has been notified</p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-green-700 dark:text-green-300">On track — no delays recorded</p>
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
{new Date(event.created_at).toLocaleString()}
                        {event.performed_by && ` by ${event.performed_by}`}
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
          <Tabs value={activeTab} onValueChange={setActiveTab}>
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
              <TabsTrigger value="deposits" className="text-xs">
                <Landmark className="h-3 w-3 mr-1" />
                Deposits &amp; Compliance
                {(() => {
                  const overdueCount = complianceTasks.filter(
                    t => t.status === "pending" && t.due_date && new Date(t.due_date) < new Date()
                  ).length
                  return overdueCount > 0 ? (
                    <Badge variant="destructive" className="ml-1 h-4 px-1 text-xs">
                      {overdueCount}
                    </Badge>
                  ) : deposits.some(d => d.status === "received" && d.due_date && new Date(d.due_date) < new Date()) ? (
                    <span className="ml-1 flex h-1.5 w-1.5 rounded-full bg-red-500" />
                  ) : null
                })()}
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
              <TabsTrigger value="partners" className="text-xs">
                <Landmark className="h-3 w-3 mr-1" />
                Partners
              </TabsTrigger>
              <TabsTrigger value="forms" className="text-xs">
                <ClipboardList className="h-3 w-3 mr-1" />
                Forms
                {formsProvider?.is_configured && (
                  <span className="ml-1 flex h-1.5 w-1.5 rounded-full bg-green-500" />
                )}
              </TabsTrigger>
            </TabsList>

            {/* Milestones Tab */}
            <TabsContent value="milestones" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-muted-foreground cursor-help underline decoration-dotted">
                            Client portal visibility
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs">
                          Client portal journey only shows milestones you mark visible. Defaults to hidden so no accidental exposure.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="space-y-2">
                    {localMilestones.map((m) => {
                      const isOverdue = m.status !== "completed" && m.milestone_date
                        ? new Date(m.milestone_date) < new Date()
                        : false
                      return (
                      <div key={m.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "w-3 h-3 rounded-full flex-shrink-0",
                              m.status === "completed" && "bg-green-500",
                              isOverdue && "bg-red-500",
                              !isOverdue && m.status === "pending" && "bg-amber-500",
                              m.status === "overdue" && "bg-red-500"
                            )}
                          />
                          <span className="text-sm font-medium">{m.milestone_name.replace(/_/g, " ")}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {/* Date — red if overdue, green if complete */}
                          <span className={cn(
                            "text-sm",
                            m.completed_at ? "text-green-600 font-medium" : isOverdue ? "text-red-600 font-semibold" : "text-muted-foreground"
                          )}>
                            {m.completed_at
                              ? `Completed ${format(new Date(m.completed_at), "MMM d")}`
                              : m.milestone_date
                              ? `${isOverdue ? "Overdue: " : ""}${format(new Date(m.milestone_date), "MMM d, yyyy")}`
                              : "No date set"}
                          </span>

                          {/* Mark Complete button — only for non-completed milestones */}
                          {m.status !== "completed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              disabled={isPending}
                              onClick={() => {
                                startTransition(async () => {
                                  const supabase = createClient()
                                  const now = new Date().toISOString()
                                  const { error } = await supabase
                                    .from("transaction_milestones")
                                    .update({ status: "completed", completed_at: now })
                                    .eq("id", m.id)
                                  if (!error) {
                                    // Log timeline activity
                                    await supabase.from("transaction_timeline").insert({
                                      transaction_id: transaction.id,
                                      brokerage_id: brokerageId,
                                      activity_type: "milestone_completed",
                                      description: `Milestone completed: ${m.milestone_name.replace(/_/g, " ")}`,
                                      performed_by: userId,
                                      created_at: now,
                                    })
                                    setLocalMilestones((prev) =>
                                      prev.map((row) =>
                                        row.id === m.id ? { ...row, status: "completed", completed_at: now } : row
                                      )
                                    )
                                    toast.success("Milestone marked complete")
                                  } else {
                                    toast.error("Failed to update milestone")
                                  }
                                })
                              }}
                            >
                              Complete
                            </Button>
                          )}

                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {m.is_client_visible ? "Client sees this" : "Agent only"}
                            </span>
                            <Switch
                              checked={m.is_client_visible ?? false}
                              onCheckedChange={async (visible) => {
                                setLocalMilestones((prev) =>
                                  prev.map((row) =>
                                    row.id === m.id ? { ...row, is_client_visible: visible } : row
                                  )
                                )
                                const supabase = createClient()
                                const { error } = await supabase
                                  .from("transaction_milestones")
                                  .update({ is_client_visible: visible })
                                  .eq("id", m.id)
                                if (error) {
                                  setLocalMilestones((prev) =>
                                    prev.map((row) =>
                                      row.id === m.id ? { ...row, is_client_visible: !visible } : row
                                    )
                                  )
                                  toast.error("Failed to update milestone visibility")
                                } else {
                                  toast.success(
                                    visible
                                      ? "Milestone now visible in client portal"
                                      : "Milestone hidden from client portal"
                                  )
                                }
                              }}
                            />
                          </div>
                        </div>
                      </div>
                      )
                    })}
                    {localMilestones.length === 0 && (
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
                <CardContent className="pt-4 space-y-4">
                  {/* CTC Green Banner */}
                  {lenderInfo?.clear_to_close_date && (
                    <div className="flex items-center gap-3 rounded-lg border border-green-300 bg-green-50 px-4 py-3">
                      <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                      <div>
                        <p className="text-sm font-bold text-green-800">Clear to Close</p>
                        <p className="text-xs text-green-700">
                          Issued {new Date(lenderInfo.clear_to_close_date).toLocaleDateString()}
                          {lenderInfo.lender_name ? ` by ${lenderInfo.lender_name}` : ""}
                        </p>
                      </div>
                    </div>
                  )}

                  {lenderInfo ? (
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Lender</p>
                        <p className="font-medium">{lenderInfo.lender_name ?? "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Loan Officer</p>
                        <p className="font-medium">{lenderInfo.loan_officer_name ?? "Not set"}</p>
                      </div>
                      {lenderInfo.loan_officer_email && (
                        <div className="col-span-2">
                          <p className="text-muted-foreground">Contact</p>
                          <p className="font-medium">{lenderInfo.loan_officer_email}
                            {lenderInfo.loan_officer_phone ? ` · ${lenderInfo.loan_officer_phone}` : ""}
                          </p>
                        </div>
                      )}
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
                        <p className="text-muted-foreground">Underwriting</p>
                        <p className="font-medium capitalize">
                          {lenderInfo.underwriting_status?.replace(/_/g, " ") ?? "Not started"}
                        </p>
                      </div>
                      {lenderInfo.appraisal_value && (
                        <div>
                          <p className="text-muted-foreground">Appraisal Value</p>
                          <p className="font-medium">${lenderInfo.appraisal_value.toLocaleString()}</p>
                        </div>
                      )}
                      <div>
                        <p className="text-muted-foreground">Clear to Close</p>
                        <p className={cn("font-medium", lenderInfo.clear_to_close_date ? "text-green-600" : "text-muted-foreground")}>
                          {lenderInfo.clear_to_close_date
                            ? new Date(lenderInfo.clear_to_close_date).toLocaleDateString()
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
{titleEscrow && (titleEscrow.title_company_name || titleEscrow.escrow_company_name) && (
                    <div className="space-y-2 pt-4 border-t">
                      <p className="text-sm text-muted-foreground">Title Company</p>
                      <p className="font-medium">{titleEscrow.title_company_name ?? "Not set"}</p>
                      <p className="text-sm text-muted-foreground">Escrow Company</p>
                      <p className="font-medium">{titleEscrow.escrow_company_name ?? "Not set"}</p>
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

            {/* Deposits Tab */}
            <TabsContent value="deposits" className="mt-4">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Landmark className="h-4 w-4" />
                      Deposits & Earnest Money
                    </CardTitle>
                    <DepositTrackerDialog
                      agentId={transaction.agent_id}
                      transactionId={transaction.id}
                      propertyAddress={transaction.property_address}
                      trigger={
                        <Button size="sm" variant="outline">
                          <Plus className="h-3 w-3 mr-1" /> Record Deposit
                        </Button>
                      }
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  {deposits.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No deposits recorded yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {deposits.map((dep) => {
                        const isOverdue =
                          dep.status === "received" &&
                          dep.due_date != null &&
                          new Date(dep.due_date) < new Date()
                        return (
                          <div
                            key={dep.id}
                            className={cn(
                              "flex items-center justify-between rounded border p-3 gap-3",
                              isOverdue && "border-red-300 bg-red-50"
                            )}
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className="capitalize">
                                  {dep.deposit_type.replace(/_/g, " ")}
                                </Badge>
                                <span className="text-sm font-medium">
                                  ${dep.amount?.toLocaleString()}
                                </span>
                                <Badge
                                  className={cn(
                                    "text-xs",
                                    dep.status === "delivered"
                                      ? "bg-green-100 text-green-800 border-green-200"
                                      : dep.status === "received"
                                      ? "bg-blue-100 text-blue-800 border-blue-200"
                                      : dep.status === "forfeited"
                                      ? "bg-red-100 text-red-800 border-red-200"
                                      : "bg-gray-100 text-gray-800 border-gray-200"
                                  )}
                                >
                                  {dep.status}
                                </Badge>
                                {isOverdue && (
                                  <Badge variant="destructive" className="text-xs">
                                    OVERDUE
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Received: {format(new Date(dep.received_date), "MMM d, yyyy")}
                                {dep.due_date &&
                                  ` · Due to escrow: ${format(new Date(dep.due_date), "MMM d, yyyy")}`}
                                {dep.escrow_company && ` · ${dep.escrow_company}`}
                                {dep.check_number && ` · Check #${dep.check_number}`}
                              </p>
                              {dep.delivered_to_escrow_at && (
                                <p className="text-xs text-green-600">
                                  Delivered {format(new Date(dep.delivered_to_escrow_at), "MMM d, yyyy h:mm a")}
                                </p>
                              )}
                            </div>
                            {dep.status === "received" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={async () => {
                                  const supabase = createClient()
                                  const now = new Date().toISOString()
                                  const { error } = await supabase
                                    .from("deposits")
                                    .update({ status: "delivered", delivered_to_escrow_at: now })
                                    .eq("id", dep.id)
                                  if (!error) {
                                    setDeposits((prev) =>
                                      prev.map((d) =>
                                        d.id === dep.id
                                          ? { ...d, status: "delivered", delivered_to_escrow_at: now }
                                          : d
                                      )
                                    )
                                    toast.success("Deposit marked as delivered to escrow")
                                  } else {
                                    toast.error("Failed to update deposit")
                                  }
                                }}
                              >
                                Mark Delivered
                              </Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Compliance Tasks */}
                  <div className="mt-6 border-t pt-4">
                    <h4 className="text-sm font-semibold flex items-center gap-2 mb-3">
                      <ClipboardList className="h-4 w-4" />
                      Compliance Tasks
                    </h4>
                    {complianceTasks.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-3">No compliance tasks yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {complianceTasks.map((task) => {
                          const isOverdue =
                            task.status === "pending" &&
                            task.due_date != null &&
                            new Date(task.due_date) < new Date()
                          return (
                            <div
                              key={task.id}
                              className={cn(
                                "rounded border p-3 flex items-start justify-between text-sm",
                                isOverdue
                                  ? "border-red-200 bg-red-50"
                                  : task.status === "complete"
                                  ? "border-green-200 bg-green-50 opacity-70"
                                  : "border-gray-200 bg-white"
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-medium">{task.description}</p>
                                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                                  <span className="capitalize">{task.task_type.replace(/_/g, " ")}</span>
                                  {task.due_date && (
                                    <span>· Due {format(new Date(task.due_date), "MMM d, yyyy")}</span>
                                  )}
                                </div>
                                {isOverdue && (
                                  <p className="text-xs text-red-700 font-semibold mt-1">Overdue</p>
                                )}
                                {task.status === "complete" && task.completed_at && (
                                  <p className="text-xs text-green-700 mt-1">
                                    Completed {format(new Date(task.completed_at), "MMM d")}
                                  </p>
                                )}
                              </div>
                              {task.status === "pending" && (
                                <div className="flex gap-1.5 ml-3 shrink-0">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={async () => {
                                      const supabase = createClient()
                                      const now = new Date().toISOString()
                                      await supabase
                                        .from("compliance_tasks")
                                        .update({ status: "complete", completed_at: now, completed_by: userId })
                                        .eq("id", task.id)
                                      setComplianceTasks((prev) =>
                                        prev.map((t) =>
                                          t.id === task.id
                                            ? { ...t, status: "complete", completed_at: now }
                                            : t
                                        )
                                      )
                                      toast.success("Task completed")
                                    }}
                                  >
                                    Done
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs"
                                    onClick={async () => {
                                      const supabase = createClient()
                                      await supabase
                                        .from("compliance_tasks")
                                        .update({ status: "waived" })
                                        .eq("id", task.id)
                                      setComplianceTasks((prev) =>
                                        prev.map((t) =>
                                          t.id === task.id ? { ...t, status: "waived" } : t
                                        )
                                      )
                                      toast.success("Task waived")
                                    }}
                                  >
                                    Waive
                                  </Button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
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
                                  insp.report_url !== null
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
            <TabsContent value="documents" className="mt-4 space-y-3">
              {/* Transaction-level AI actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => setActiveTab("forms")}
                  className="text-xs gap-1.5"
                >
                  <ClipboardList className="h-3.5 w-3.5" />
                  Add Form
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckDisclosures}
                  disabled={disclosureLoading}
                  className="text-xs gap-1.5"
                >
                  {disclosureLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  Check Disclosures
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateReminders}
                  disabled={remindersLoading}
                  className="text-xs gap-1.5"
                >
                  {remindersLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Bell className="h-3.5 w-3.5" />
                  )}
                  Generate Reminders
                </Button>
                {remindersCreated !== null && (
                  <Badge variant="secondary" className="text-xs">
                    {remindersCreated} reminder task{remindersCreated !== 1 ? "s" : ""} created
                  </Badge>
                )}
              </div>

              {/* Disclosure check result */}
              {disclosureResult && (
                <Card className="border-blue-200 bg-blue-50/40">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-blue-600" />
                        <span className="text-sm font-semibold text-blue-900">Disclosure Compliance</span>
                      </div>
                      <Badge
                        className={cn(
                          "text-xs",
                          (disclosureResult.complianceScore ?? 0) >= 80
                            ? "bg-green-100 text-green-800"
                            : (disclosureResult.complianceScore ?? 0) >= 50
                            ? "bg-amber-100 text-amber-800"
                            : "bg-red-100 text-red-800"
                        )}
                      >
                        Score: {disclosureResult.complianceScore ?? 0}/100
                      </Badge>
                    </div>
                    {(disclosureResult.missingDisclosures?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-xs font-medium text-red-700 mb-1">Missing disclosures:</p>
                        <ul className="list-disc list-inside space-y-0.5">
                          {disclosureResult.missingDisclosures!.map((item, i) => (
                            <li key={i} className="text-xs text-red-600">{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(disclosureResult.recommendations?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-xs font-medium text-blue-800 mb-1">Recommendations:</p>
                        <ul className="list-disc list-inside space-y-0.5">
                          {disclosureResult.recommendations!.map((r, i) => (
                            <li key={i} className="text-xs text-blue-700">{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="pt-4">
                  {documents.length > 0 ? (
                    <div className="space-y-3">
                      {documents.map((d) => {
                        const signable = isSignableDocType(d.doc_type)
                        const sig = contractSignatures[d.doc_type] ?? null
                        const hasAnalysis = !!(d.extracted_data && Object.keys(d.extracted_data).length > 0)
                        const pendingAnalysis = docAnalysisResults[d.id]
                        const analysisData = pendingAnalysis ?? (hasAnalysis ? d.extracted_data! : null)
                        const isAnalyzed = !!analysisData
                        const isExpanded = expandedDocId === d.id
                        const confidence = d.classification_confidence
                          ? Math.round(d.classification_confidence * 100)
                          : null

                        return (
                          <div key={d.id} className="border rounded-lg overflow-hidden">
                            {/* Document header row */}
                            <div className="flex items-center justify-between px-4 py-3 bg-muted/30">
                              <div className="flex items-center gap-3 min-w-0">
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{d.doc_label ?? d.doc_type}</p>
                                  <p className="text-xs text-muted-foreground capitalize">
                                    {d.doc_type.replace(/_/g, " ")}
                                    {confidence !== null && (
                                      <span className="ml-2 text-blue-600">{confidence}% confidence</span>
                                    )}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge
                                  variant={
                                    d.status === "approved"
                                      ? "default"
                                      : d.status === "rejected"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                  className="text-xs"
                                >
                                  {d.status.replace(/_/g, " ")}
                                </Badge>
                                {isAnalyzed ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs h-7 gap-1 text-blue-700"
                                    onClick={() => setExpandedDocId(isExpanded ? null : d.id)}
                                  >
                                    <Brain className="h-3.5 w-3.5" />
                                    {isExpanded ? "Hide" : "View Analysis"}
                                    <ChevronRight
                                      className={cn(
                                        "h-3 w-3 transition-transform",
                                        isExpanded && "rotate-90"
                                      )}
                                    />
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-xs h-7 gap-1"
                                    onClick={() => handleAnalyzeDocument(d.id)}
                                    disabled={analyzingDocId === d.id}
                                  >
                                    {analyzingDocId === d.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Sparkles className="h-3.5 w-3.5" />
                                    )}
                                    AI Analyze
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* Inline AI analysis panel */}
                            {isExpanded && isAnalyzed && analysisData && (
                              <div className="border-t bg-blue-50/30 px-4 py-3 space-y-3">
                                {/* Summary */}
                                {typeof analysisData.summary === "string" && (
                                  <div>
                                    <p className="text-xs font-semibold text-foreground mb-1">Summary</p>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      {analysisData.summary}
                                    </p>
                                  </div>
                                )}

                                {/* Key Terms (contracts) */}
                                {Array.isArray(analysisData.keyTerms) && analysisData.keyTerms.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-foreground mb-1">Key Terms</p>
                                    <div className="grid grid-cols-1 gap-1">
                                      {(analysisData.keyTerms as Array<{ term: string; value: string; importance: string }>)
                                        .slice(0, 6)
                                        .map((kt, i) => (
                                          <div key={i} className="flex justify-between text-xs">
                                            <span className="text-muted-foreground">{kt.term}</span>
                                            <span className="font-medium text-foreground">{kt.value}</span>
                                          </div>
                                        ))}
                                    </div>
                                  </div>
                                )}

                                {/* Red Flags */}
                                {Array.isArray(analysisData.redFlags) && analysisData.redFlags.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-destructive mb-1">Red Flags</p>
                                    <ul className="list-disc list-inside space-y-0.5">
                                      {(analysisData.redFlags as string[]).map((flag, i) => (
                                        <li key={i} className="text-xs text-destructive">{flag}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Deadlines */}
                                {Array.isArray(analysisData.deadlines) && analysisData.deadlines.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-foreground mb-1">Deadlines</p>
                                    <div className="space-y-1">
                                      {(analysisData.deadlines as Array<{ description: string; date: string }>).map((dl, i) => (
                                        <div key={i} className="flex justify-between text-xs">
                                          <span className="text-muted-foreground">{dl.description}</span>
                                          <span className="font-medium text-amber-700">{dl.date}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Recommended Actions */}
                                {Array.isArray(analysisData.recommendedActions) && analysisData.recommendedActions.length > 0 && (
                                  <div>
                                    <p className="text-xs font-semibold text-foreground mb-1">Recommended Actions</p>
                                    <ul className="list-disc list-inside space-y-0.5">
                                      {(analysisData.recommendedActions as string[]).map((a, i) => (
                                        <li key={i} className="text-xs text-muted-foreground">{a}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Share with client */}
                                {transaction.contact_id && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-xs h-7 gap-1 w-full"
                                    onClick={() =>
                                      handleShareWithClient(
                                        d.id,
                                        d.doc_label ?? d.doc_type,
                                        analysisData
                                      )
                                    }
                                    disabled={sharingDocId === d.id}
                                  >
                                    {sharingDocId === d.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Share2 className="h-3.5 w-3.5" />
                                    )}
                                    Share with Client via Portal
                                  </Button>
                                )}
                              </div>
                            )}

                            {/* E-sign panel */}
                            {signable && (
                              <div className="border-t px-4 py-3">
                                <DocumentSignaturePanel
                                  transactionId={transaction.id}
                                  documentId={d.id}
                                  docType={d.doc_type}
                                  docLabel={d.doc_label}
                                  userId={userId}
                                  brokerageId={brokerageId}
                                  connectedProvider={connectedEsignProvider ?? null}
                                  existingSignatureId={sig?.id ?? null}
                                  esignStatus={sig?.esign_status ?? null}
                                  providerName={sig?.provider_name ?? null}
                                  sentAt={sig?.sent_at ?? null}
                                  agentSignedAt={sig?.agent_signed_at ?? null}
                                  fullySignedAt={sig?.fully_signed_at ?? null}
                                  defaultSigners={
                                    contactEmail
                                      ? [{ name: contactName ?? "Contact", email: contactEmail, role: "signer" }]
                                      : []
                                  }
                                />
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No documents uploaded.</p>
                  )}

                  {/* E-sign Panel — shown when a buyer offer is linked */}
                  {linkedOffer && (
                    <div className="mt-4 border-t pt-4">
                      <p className="text-sm font-semibold mb-2">Offer Signatures</p>
                      <SendForSignaturesPanel
                        offerId={linkedOffer.id}
                        userId={userId}
                        connectedProvider={connectedEsignProvider ?? null}
                        buyerName={contactName ?? ""}
                        buyerEmail={contactEmail ?? ""}
                        esignStatus={esignSent ? "sent" : (linkedOffer.esign_status ?? undefined)}
                        esignProvider={linkedOffer.esign_provider ?? undefined}
                        esignSentAt={esignSent ? new Date().toISOString() : (linkedOffer.esign_sent_at ?? undefined)}
                        esignCompletedAt={linkedOffer.esign_completed_at ?? undefined}
                        buyerSignedAt={linkedOffer.buyer_signed_at ?? undefined}
                        onSent={() => setEsignSent(true)}
                      />
                    </div>
                  )}

                  <div className="mt-6 border-t pt-6 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <h3 className="font-semibold text-sm flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-indigo-600" />
                          AI Contract Intelligence
                          {transaction.property_state && (
                            <Badge variant="outline" className="text-xs font-normal">{transaction.property_state}</Badge>
                          )}
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Flag critical issues, missing signatures, and key dates before they become problems
                          {transaction.property_state
                            ? ` · ${transaction.property_state} compliance rules applied`
                            : ' · state rules applied from address'}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleReviewDocuments} disabled={reviewLoading}>
                          {reviewLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/> : <Sparkles className="h-3.5 w-3.5 mr-1.5"/>}
                          Review Documents
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleGenerateChecklist} disabled={checklistLoading}>
                          {checklistLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/> : <CheckSquare className="h-3.5 w-3.5 mr-1.5"/>}
                          Generate Checklist
                        </Button>
                      </div>
                    </div>

                    {contractReview && (
                      <div className="space-y-3">
                        <div className="p-4 bg-muted/40 rounded-lg">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-sm font-medium">Document Score</span>
                            <span className={`text-sm font-bold ${contractReview.overallScore>=80?'text-green-700':contractReview.overallScore>=60?'text-amber-700':'text-red-700'}`}>
                              {contractReview.overallScore}/100 · {contractReview.overallScore>=80?'All Clear':contractReview.overallScore>=60?'Review Needed':'Issues Found'}
                            </span>
                          </div>
                          <Progress value={contractReview.overallScore} className="h-2" />
                          <p className="text-xs text-muted-foreground mt-1">{contractReview.overallAssessment}</p>
                        </div>
                        {contractReview.issues?.filter((i:any)=>i.severity==='critical').length > 0 && (
                          <div className="border border-red-200 rounded-lg p-3 bg-red-50">
                            <p className="text-sm font-semibold text-red-700 mb-1 flex items-center gap-1">
                              <AlertTriangle className="h-4 w-4"/>
                              {contractReview.issues.filter((i:any)=>i.severity==='critical').length} Critical Issues
                            </p>
                            {contractReview.issues.filter((i:any)=>i.severity==='critical').map((issue:any,idx:number)=>(
                              <div key={idx} className="text-xs mb-1.5">
                                <span className="font-medium">{issue.category}: </span>{issue.description}
                                <p className="text-red-700 mt-0.5">→ {issue.recommendation}</p>
                              </div>
                            ))}
                          </div>
                        )}
                        {contractReview.missingItems?.length > 0 && (
                          <div>
                            <p className="text-sm font-medium mb-1">Missing Items</p>
                            {contractReview.missingItems.map((item:any,idx:number)=>(
                              <div key={idx} className="flex items-center gap-2 text-xs p-2 bg-muted/40 rounded mb-1">
                                <Badge variant={item.required?"destructive":"secondary"} className="text-xs shrink-0">
                                  {item.required?"Required":"Optional"}
                                </Badge>
                                <span>{item.item}</span>
                                {item.deadline && <span className="ml-auto text-muted-foreground">Due: {item.deadline}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {contractReview.keyDates?.length > 0 && (
                          <div>
                            <p className="text-sm font-medium mb-1">Key Dates</p>
                            {contractReview.keyDates.map((kd:any,idx:number)=>(
                              <div key={idx} className="flex justify-between text-xs p-2 bg-muted/40 rounded mb-1">
                                <span>{kd.event}</span>
                                <span className={kd.daysRemaining<=7?'text-red-600 font-semibold':kd.daysRemaining<=14?'text-amber-600':'text-green-600'}>
                                  {kd.date}{kd.daysRemaining!==undefined?` (${kd.daysRemaining}d)`:''}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {docChecklist.length > 0 && (
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <p className="text-sm font-medium">Document Checklist</p>
                          <p className="text-xs text-muted-foreground">{checkedItems.size}/{docChecklist.length} complete</p>
                        </div>
                        <Progress value={(checkedItems.size/docChecklist.length)*100} className="h-1.5 mb-3"/>
                        {docChecklist.map((item:any,idx:number)=>(
                          <label key={idx} className="flex items-start gap-2 p-2 rounded hover:bg-muted/40 cursor-pointer mb-1">
                            <input type="checkbox" className="mt-0.5 shrink-0"
                              checked={checkedItems.has(String(idx))}
                              onChange={e=>{const n=new Set(checkedItems);e.target.checked?n.add(String(idx)):n.delete(String(idx));setCheckedItems(n)}}
                            />
                            <div>
                              <span className={`text-xs ${checkedItems.has(String(idx))?'line-through text-muted-foreground':''}`}>{item.item}</span>
                              {item.required && <Badge variant="outline" className="text-[10px] h-4 px-1 ml-1">Required</Badge>}
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
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
                            <p className="text-sm font-medium">{r.item_description}</p>
                            <p className="text-xs text-muted-foreground">
                              Est: {r.estimated_cost ? `$${r.estimated_cost.toLocaleString()}` : "TBD"}
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
{complianceLogs.length > 0 ? (
                <div className="space-y-3">
                  {complianceLogs.map((a) => (
                        <div key={a.id} className="flex items-start gap-3 py-2 border-b last:border-0">
                          <AlertTriangle
                            className={cn(
                              "h-4 w-4 mt-0.5 shrink-0",
                              a.status === "fail" && "text-red-500",
                              a.status === "pending" && "text-amber-500",
                              a.status === "needs_review" && "text-orange-500",
                              a.status === "pass" && "text-green-500",
                              a.status === "waived" && "text-slate-500"
                            )}
                          />
                          <div className="flex-1">
                            <p className="text-sm">{a.check_label ?? a.check_type}</p>
                            <p className="text-xs text-muted-foreground">
                              {a.check_type} | {a.status}{a.is_blocking ? " (Blocking)" : ""}
                            </p>
                            {a.failure_reason && (
                              <p className="text-xs text-red-500 mt-1">{a.failure_reason}</p>
                            )}
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
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Commission Summary
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    disabled={isPending}
                    onClick={() => {
                      startTransition(async () => {
                        const { calculateCommissions } = await import("@/app/actions/transactions")
                        const result = await calculateCommissions(transaction.id)
                        if (result?.success) {
                          toast.success("Commissions recalculated")
                          router.refresh()
                        } else {
                          toast.error("Recalculation failed")
                        }
                      })
                    }}
                  >
                    {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Recalculate
                  </Button>
                </CardHeader>
                <CardContent>
                  {/* CLOSED: show commission summary banner */}
                  {currentStage === "CLOSED" && commissions.length > 0 && (
                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4">
                      <p className="text-sm font-bold text-green-800 mb-2 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4" />
                        Transaction Closed — Final Commission Summary
                      </p>
                      <div className="grid grid-cols-2 gap-2 text-xs text-green-700">
                        <span>Gross Commission</span>
                        <span className="font-semibold text-right">
                          ${(transaction.purchase_price * (transaction.commission_percentage ?? 3) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                        <span>Total Distributed</span>
                        <span className="font-semibold text-right">
                          ${commissions.reduce((s, c) => s + (c.calculated_amount ?? c.flat_amount ?? 0), 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>
                  )}

                  {commissions.length > 0 ? (
                    <div className="space-y-2">
                      {commissions.map((c) => (
                        <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div>
                            <p className="text-sm font-medium">{c.recipient_name}</p>
                            <p className="text-xs text-muted-foreground capitalize">{c.recipient_type} · {c.commission_type?.replace(/_/g, " ") ?? "split"}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium">
                              {c.rate_percentage ?? c.split_percentage
                                ? `${(c.rate_percentage ?? c.split_percentage ?? 0).toFixed(2)}%`
                                : c.flat_amount ? `$${c.flat_amount.toLocaleString()}` : "—"}
                            </p>
                            {(c.calculated_amount || c.flat_amount) && (
                              <p className="text-xs text-muted-foreground">
                                ${(c.calculated_amount ?? c.flat_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </p>
                            )}
                            {c.status && (
                              <Badge variant={c.status === "paid" ? "default" : "secondary"} className="mt-1 text-[10px] px-1 h-4">
                                {c.status}
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-6 text-center space-y-2">
                      <p className="text-sm text-muted-foreground">No commission splits defined yet.</p>
                      <p className="text-xs text-muted-foreground">
                        Commission splits are calculated automatically when the transaction advances to Closing Prep.
                        Click Recalculate to trigger manually.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

          {/* Partners Tab */}
          <TabsContent value="partners" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

              {/* Lender Workspace Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    Lender Workspace
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {lenderInfo ? (
                    <>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{lenderInfo.lender_name ?? "—"}</p>
                        {lenderInfo.loan_officer_name && (
                          <p className="text-xs text-muted-foreground">{lenderInfo.loan_officer_name}</p>
                        )}
                        {lenderInfo.loan_officer_email && (
                          <p className="text-xs text-muted-foreground">{lenderInfo.loan_officer_email}</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        {lenderInfo.loan_type && (
                          <>
                            <span className="text-muted-foreground">Loan Type</span>
                            <span className="font-medium">{lenderInfo.loan_type}</span>
                          </>
                        )}
                        {lenderInfo.underwriting_status && (
                          <>
                            <span className="text-muted-foreground">Underwriting</span>
                            <Badge variant="outline" className="w-fit text-[10px] px-1.5 py-0">
                              {lenderInfo.underwriting_status.replace(/_/g, " ")}
                            </Badge>
                          </>
                        )}
                        {lenderInfo.clear_to_close_date && (
                          <>
                            <span className="text-muted-foreground">CTC Date</span>
                            <span className="font-medium">
                              {new Date(lenderInfo.clear_to_close_date).toLocaleDateString()}
                            </span>
                          </>
                        )}
                        {lenderInfo.loan_amount && (
                          <>
                            <span className="text-muted-foreground">Loan Amount</span>
                            <span className="font-medium">${lenderInfo.loan_amount.toLocaleString()}</span>
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No lender assigned.</p>
                  )}
                  <div className="pt-1">
                    <Link href={`/portal/lender/${transaction.id}`} target="_blank">
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs">
                        <ExternalLink className="h-3 w-3" />
                        Open Lender Portal
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>

              {/* Title & Escrow Workspace Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Home className="h-4 w-4 text-muted-foreground" />
                    Title & Escrow Workspace
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {titleEscrow ? (
                    <>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{titleEscrow.title_company_name ?? "—"}</p>
                        {titleEscrow.title_officer_name && (
                          <p className="text-xs text-muted-foreground">{titleEscrow.title_officer_name}</p>
                        )}
                        {titleEscrow.title_officer_email && (
                          <p className="text-xs text-muted-foreground">{titleEscrow.title_officer_email}</p>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        {titleEscrow.escrow_number && (
                          <>
                            <span className="text-muted-foreground">Escrow #</span>
                            <span className="font-medium">{titleEscrow.escrow_number}</span>
                          </>
                        )}
                        {titleEscrow.closing_scheduled_date && (
                          <>
                            <span className="text-muted-foreground">Closing</span>
                            <span className="font-medium">
                              {new Date(titleEscrow.closing_scheduled_date).toLocaleDateString()}
                            </span>
                          </>
                        )}
                        {titleEscrow.title_issues && (
                          <>
                            <span className="text-muted-foreground">Issues</span>
                            <Badge variant="destructive" className="w-fit text-[10px] px-1.5 py-0">
                              {titleEscrow.title_issues}
                            </Badge>
                          </>
                        )}
                        {titleEscrow.earnest_money_amount && (
                          <>
                            <span className="text-muted-foreground">Earnest $</span>
                            <span className="font-medium">${titleEscrow.earnest_money_amount.toLocaleString()}</span>
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No title/escrow info assigned.</p>
                  )}
                  <div className="pt-1">
                    <Link href={`/portal/title/${transaction.id}`} target="_blank">
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs">
                        <ExternalLink className="h-3 w-3" />
                        Open Title Portal
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>

              {/* Vendor Workspace Card */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Wrench className="h-4 w-4 text-muted-foreground" />
                    Vendor Workspace
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {vendorServices.length > 0 ? (
                    <div className="space-y-2">
                      {vendorServices.slice(0, 4).map((v) => (
                        <div key={v.id} className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-medium">{v.vendor_name}</p>
                            <p className="text-[10px] text-muted-foreground capitalize">
                              {v.service_type.replace(/_/g, " ")}
                            </p>
                          </div>
                          <Badge
                            variant={v.status === "completed" ? "default" : v.status === "scheduled" ? "secondary" : "outline"}
                            className="text-[10px] px-1.5 py-0 capitalize"
                          >
                            {v.status.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      ))}
                      {vendorServices.length > 4 && (
                        <p className="text-[10px] text-muted-foreground">
                          +{vendorServices.length - 4} more
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No vendor services assigned.</p>
                  )}
                  <div className="pt-1">
                    <Link href="/vendor/dashboard">
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs">
                        <ExternalLink className="h-3 w-3" />
                        View Vendor Dashboard
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>

              {/* Vendor Bookings Panel */}
              <VendorBookingsPanel bookings={vendorBookings} />

            </div>
          </TabsContent>

          {/* Forms Tab — brokerage provider forms (Dotloop, SkySlope, etc.) */}
          <TabsContent value="forms" className="mt-4 space-y-4">
            {formsLoading ? (
              <Card>
                <CardContent className="pt-6 flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Provider Connection Banner */}
                <Card className={formsProvider?.is_configured ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building2 className="h-4 w-4" />
                      Transaction Forms Provider
                      {formsProvider && (
                        <Badge
                          variant={formsProvider.is_configured ? "default" : "secondary"}
                          className="ml-auto capitalize text-xs"
                        >
                          {formsProvider.is_configured ? "Connected" : "Not Configured"}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium capitalize">
                          {formsProvider?.provider_name ?? "Dotloop"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formsProvider?.is_configured
                            ? "Your brokerage has this provider connected. Use the button below to open forms directly in the portal."
                            : "No forms provider is configured for your brokerage. Connect one under Settings → Integrations."}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {formsProvider?.is_configured ? (
                        <>
                          <Link href="/dashboard/settings?tab=integrations">
                            <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                              <PenLine className="h-3 w-3" />
                              Manage Connection
                            </Button>
                          </Link>
                        </>
                      ) : (
                        <Link href="/dashboard/settings?tab=integrations">
                          <Button size="sm" variant="default" className="gap-1.5 text-xs">
                            <Plus className="h-3 w-3" />
                            Connect Forms Provider
                          </Button>
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Available Transaction Forms */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">
                        Available Transaction Forms
                      </CardTitle>
                      <Badge variant="secondary" className="text-xs">
                        {availableForms.length} form{availableForms.length !== 1 ? "s" : ""}
                        {transaction.property_state ? ` · ${transaction.property_state}` : ""}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      State-required and brokerage forms for this transaction. Open the provider portal above to complete them.
                    </p>
                  </CardHeader>
                  <CardContent className="p-0">
                    {availableForms.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <FileText className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                        <p className="text-sm text-muted-foreground">No forms found for this state.</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {availableForms.map((form) => (
                          <div key={form.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                            <div className="flex items-start gap-3 min-w-0">
                              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-sm font-medium text-foreground">{form.name}</p>
                                  {form.is_required && (
                                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">
                                      Required
                                    </Badge>
                                  )}
                                </div>
                                {form.description && (
                                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{form.description}</p>
                                )}
                                <p className="text-[10px] text-muted-foreground capitalize mt-0.5">
                                  {form.category.replace(/_/g, " ")}
                                  {form.form_type !== form.category && ` · ${form.form_type}`}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 ml-3 shrink-0">
                              <Button
                                size="sm"
                                className="text-xs h-7 gap-1"
                                onClick={() => setEsignFlowForm({
                                  id: form.id,
                                  name: form.name,
                                  category: form.category,
                                  form_type: form.form_type,
                                  is_required: form.is_required,
                                  description: form.description,
                                })}
                              >
                                <FileText className="h-3 w-3" />
                                Use This Form
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

              </>
            )}
          </TabsContent>

          </Tabs>
        </div>
      </div>

      {/* Transaction Form E-Sign Flow */}
      {esignFlowForm && (
        <TransactionFormEsignFlow
          open={!!esignFlowForm}
          onOpenChange={open => { if (!open) setEsignFlowForm(null) }}
          formTemplate={esignFlowForm}
          contextType="transaction"
          contextId={transaction.id}
          providerName={formsProvider?.provider_name}
          defaultSigners={[
            ...(transaction.contact_id ? [{ name: transaction.client_name ?? "", email: "", role: "buyer" }] : []),
          ].filter(s => s.name)}
          onSuccess={() => {
            setEsignFlowForm(null)
            setActiveTab("documents")
          }}
        />
      )}

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

      {/* Log Delay Sheet */}
      <Sheet open={delaySheetOpen} onOpenChange={(open) => {
        if (!open) {
          setSelectedDelayTypes([])
          setDelayReasonText("")
          setImpactDays(5)
          setNotifyClient(false)
        }
        setDelaySheetOpen(open)
      }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Log Closing Delay</SheetTitle>
            <SheetDescription>
              Record delay types, reason, and estimated impact on the closing date.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 py-4">
            {/* Delay type checkboxes */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Delay Types</Label>
              {[
                "Inspection issues",
                "Financing/appraisal",
                "Title issues",
                "Repair negotiations",
                "Buyer contingency",
                "Document delays",
                "Scheduling conflict",
                "Other",
              ].map((type) => (
                <label key={type} className="flex items-center gap-2 cursor-pointer text-sm py-1">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={selectedDelayTypes.includes(type)}
                    onChange={(e) =>
                      setSelectedDelayTypes((prev) =>
                        e.target.checked ? [...prev, type] : prev.filter((t) => t !== type),
                      )
                    }
                  />
                  {type}
                </label>
              ))}
            </div>

            {/* Reason textarea */}
            <div className="space-y-1.5">
              <Label htmlFor="delayReason" className="text-sm font-medium">
                Reason / Notes
              </Label>
              <Textarea
                id="delayReason"
                placeholder="Describe the reason for the delay..."
                rows={3}
                value={delayReasonText}
                onChange={(e) => setDelayReasonText(e.target.value)}
              />
            </div>

            {/* Impact days slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Impact on Closing</Label>
                <span className="text-sm font-semibold tabular-nums">{impactDays} day{impactDays !== 1 ? "s" : ""}</span>
              </div>
              <Slider
                min={1}
                max={30}
                step={1}
                value={[impactDays]}
                onValueChange={([v]) => setImpactDays(v)}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1 day</span>
                <span>30 days</span>
              </div>
            </div>

            {/* Notify client toggle */}
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Notify client immediately</Label>
                <p className="text-xs text-muted-foreground">
                  Sends a transparency update to the client portal
                </p>
              </div>
              <Switch checked={notifyClient} onCheckedChange={setNotifyClient} />
            </div>
          </div>

          <SheetFooter>
            <Button variant="outline" onClick={() => setDelaySheetOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={isLoggingDelay || selectedDelayTypes.length === 0}
              onClick={async () => {
                setIsLoggingDelay(true)
                const res = await logTransactionDelay({
                  transactionId: transaction.id,
                  delays: selectedDelayTypes,
                  reasons: delayReasonText ? [delayReasonText] : selectedDelayTypes,
                  impactDays,
                  notifyClient,
                })
                setIsLoggingDelay(false)
                if (res.success) {
                  toast.success("Delay logged")
                  setDelays(res.delay)
                  setDelaySheetOpen(false)
                } else {
                  toast.error(res.error ?? "Failed to log delay")
                }
              }}
            >
              {isLoggingDelay ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Log Delay
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  )
}
