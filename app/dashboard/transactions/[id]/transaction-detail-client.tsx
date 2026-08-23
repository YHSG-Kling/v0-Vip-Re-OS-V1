"use client"

import { useState, useTransition, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { RepairCoPilotPanel } from "@/app/components/features/transactions/repair-copilot-panel"
import { resolveInterventionAction, rescanDealHealthAction } from "@/app/actions/deal-health-actions"
import { analyzeTransactionHealth } from "@/app/actions/ai-transaction-coordinator"
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
  completeMilestoneAction,
  overrideMilestoneAction,
  markAppraisalOrderedAction,
  markAppraisalCompleteAction,
  scheduleFinalWalkthroughAction,
  completeFinalWalkthroughAction,
  requestRepairAction,
  completeRepairAction,
} from "@/app/actions/transaction-milestones"
import {
  scheduleInspectionAction,
  approveInspectionQuoteAction,
  declineInspectionQuoteAction,
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
  ArrowLeft,
  ArrowRight,
  MapPin,
  Calendar,
  Shield,
  Wrench,
  CheckSquare,
  Brain,
  TrendingDown,
  TrendingUp,
  RefreshCw,
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
  markDelaysCommunicated,
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
import { VendorBookingSection } from "@/app/components/transactions/VendorBookingSection"
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
import { detectTransactionIssues, detectTransactionDelays, setMilestoneClientVisibility } from "@/app/actions/transactions"
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
  userType: string
  userId: string
  milestones: Array<{
    id: string
    milestone_name: string
    target_date: string | null
    status: string
    completed_at: string | null
    notes: string | null
    is_client_visible: boolean | null
    override_at: string | null
    override_reason: string | null
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
  unresolvedInterventions: Array<{
    id: string
    issue_detected: string
    severity: string
    ai_recommendation: string | null
    client_impacted: boolean | null
    created_at: string
  }>
  healthScoreHistory: Array<{
    overall_score: number
    risk_level: string
    scored_at: string
  }>
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
  /**
   * Parsed title-issue triage from trackTitleIssues (multi-persona).
   * transaction_title_escrow.title_issues is a TEXT column that the platform
   * writes as a JSON array of { text, status, severity } — the card below used
   * to render that whole blob inside one red badge, so a resolved issue looked
   * identical to a critical open one and the closing-blocking question ("are
   * there open CRITICAL issues?") was never asked. Null when the server-side
   * triage could not run.
   */
  titleIssueSummary: {
    critical: Array<Record<string, unknown>>
    moderate: Array<Record<string, unknown>>
    totalUnresolved: number
    canClose: boolean
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
  // contract_signatures rows scoped to THIS transaction's signable doc_types
  // (app/actions/transaction-document-signatures.ts:getTransactionSignatureStatuses)
  // — keyed by contract_type, most recent wins.
  contractSignatures?: Record<string, {
    id: string
    esign_status: string
    provider_name: string | null
    sent_at: string | null
    agent_signed_at: string | null
    fully_signed_at: string | null
  }>
  /** Signable documents ON THIS TRANSACTION that are not fully signed — the
   *  readiness blockers, from
   *  app/actions/transaction-document-signatures.ts:getUnsignedDocumentBlockers.
   *  Keyed off transaction_documents, so it names the real document (label + id)
   *  rather than a bare doc_type, and never shows another deal's paperwork. */
  unsignedDocBlockers?: Array<{
    docId: string
    docLabel: string
    docType: string
    signatureId: string | null
    esignStatus: string | null
  }>
  // TC assignment
  currentCoordinatorId?: string | null
  availableTCs?: Array<{
    id: string
    display_name: string | null
    max_active_deals: number | null
    active_transactions_count?: number | null
  }>
  // Lender assignment
  currentLenderUserId?: string | null
  availableLenderUsers?: Array<{
    userId: string
    label: string
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
  userType,
  userId,
  milestones,
  deadlines,
  participants,
  participantCountsByRole,
  documents,
  documentCountsByStatus,
  healthScore,
  unresolvedInterventions,
  healthScoreHistory,
  tasks,
  timeline,
  titleEscrow,
  titleIssueSummary,
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
  unsignedDocBlockers = [],
  currentCoordinatorId = null,
  availableTCs = [],
  currentLenderUserId = null,
  availableLenderUsers = [],
  vendorBookings = [],
}: TransactionDetailClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Deal Health interactive state — rescan + intervention resolve
  const [rescanning, setRescanning] = useState(false)
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  async function handleRescan() {
    if (rescanning) return
    setRescanning(true)
    try {
      const r = await rescanDealHealthAction({ transactionId: transaction.id })
      if (r.success) {
        toast.success(`Health rescored — ${r.overallScore}/100 (${r.riskLevel})`)
        router.refresh()
      } else {
        toast.error(r.error ?? "Rescan failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rescan failed")
    } finally {
      setRescanning(false)
    }
  }

  // THE AI READ, alongside the deterministic rescan above.
  //
  // rescanDealHealthAction scores components; this runs the transaction through
  // the model for a win probability + narrative risk read. It is also the ONLY
  // writer of transactions.win_probability — which lib/kernel/commission-forecaster
  // and the partners-meeting brief both READ. With nothing calling it, the
  // forecaster fell back to its by-stage default for every deal forever, and the
  // round-36 accuracy flywheel (captureWinProbabilitySnapshot → ai_predictions)
  // had no claims to grade. The button is the missing producer.
  async function handleAiAnalysis() {
    if (aiAnalyzing) return
    setAiAnalyzing(true)
    try {
      const r = await analyzeTransactionHealth({
        transactionId: transaction.id,
        agentId: transaction.agent_id,
      })
      if (r.success && r.analysis) {
        toast.success(
          `AI read: ${r.analysis.healthScore}/100 · ${r.analysis.winProbability}% win probability (${r.analysis.riskLevel} risk)`,
        )
        router.refresh()
      } else {
        toast.error(r.error ?? "AI analysis failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI analysis failed")
    } finally {
      setAiAnalyzing(false)
    }
  }

  async function handleResolveIntervention(interventionId: string) {
    setResolvingId(interventionId)
    try {
      const r = await resolveInterventionAction({ interventionId })
      if (r.success) {
        toast.success("Intervention marked resolved")
        router.refresh()
      } else {
        toast.error(r.error ?? "Could not resolve")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resolve")
    } finally {
      setResolvingId(null)
    }
  }

  // Local milestones state — allows optimistic visibility toggle updates
  const [localMilestones, setLocalMilestones] = useState(milestones)

  // Stage advancement state
  const [showBlockersModal, setShowBlockersModal] = useState(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showLostModal, setShowLostModal] = useState(false)
  const [blockers, setBlockers] = useState<string[]>([])
  const [targetStage, setTargetStage] = useState<TransactionStage | null>(null)
  const [advanceReason, setAdvanceReason] = useState("")

  // Manual override state — only shown to user_types with override authority.
  // Server-side requireOverrideActor enforces the same set; UI gate is for UX
  // only (no security boundary).
  const OVERRIDE_USER_TYPES = new Set([
    "broker", "broker_admin", "admin", "superadmin",
    "compliance_officer", "compliance_manager",
  ])
  const canOverrideStage = OVERRIDE_USER_TYPES.has(userType?.toLowerCase?.() ?? "")
  const [showOverridePanel, setShowOverridePanel] = useState(false)
  const [overrideReason, setOverrideReason] = useState("")
  const [overrideError, setOverrideError] = useState<string | null>(null)

  // Milestone override dialog state — separate from stage override so both
  // can be in flight independently.
  const [milestoneOverrideName, setMilestoneOverrideName] = useState<string | null>(null)
  const [milestoneOverrideReason, setMilestoneOverrideReason] = useState("")
  const [milestoneOverrideError, setMilestoneOverrideError] = useState<string | null>(null)

  async function handleMilestoneOverride() {
    if (!milestoneOverrideName) return
    if (milestoneOverrideReason.trim().length < 10) {
      setMilestoneOverrideError("Override reason must be at least 10 characters for the audit trail.")
      return
    }
    setMilestoneOverrideError(null)
    startTransition(async () => {
      const res = await overrideMilestoneAction({
        transactionId:  transaction.id,
        brokerageId,
        milestoneName:  milestoneOverrideName,
        overrideReason: milestoneOverrideReason.trim(),
      })
      if (res.success) {
        // Local update — show the override visually (kept as pending but
        // with override_by stamped server-side; UI distinguishes via a chip
        // on the next render)
        setLocalMilestones((prev) =>
          prev.map((row) =>
            row.milestone_name === milestoneOverrideName
              ? { ...row, override_at: new Date().toISOString(), override_reason: milestoneOverrideReason.trim() }
              : row,
          ),
        )
        setMilestoneOverrideName(null)
        setMilestoneOverrideReason("")
        toast.success("Milestone overridden — audit row written")
      } else {
        setMilestoneOverrideError(res.error ?? "Override failed")
      }
    })
  }

  async function handleForceAdvance() {
    if (!targetStage) return
    if (overrideReason.trim().length < 10) {
      setOverrideError("Override reason must be at least 10 characters for the audit trail.")
      return
    }
    setOverrideError(null)
    startTransition(async () => {
      const result = await advanceTransactionStage({
        transactionId: transaction.id,
        brokerageId,
        targetStage,
        reason: advanceReason || undefined,
        overrideReason: overrideReason.trim(),
      })
      if (result.success) {
        setShowBlockersModal(false)
        setShowOverridePanel(false)
        setOverrideReason("")
        setAdvanceReason("")
        router.refresh()
      } else {
        setOverrideError(result.error ?? "Override failed")
      }
    })
  }

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

  // Add Deadline form
  const [showAddDeadline, setShowAddDeadline] = useState(false)
  const [newDeadlineLabel, setNewDeadlineLabel] = useState("")
  const [newDeadlineType, setNewDeadlineType] = useState("contingency_period")
  const [newDeadlineDate, setNewDeadlineDate] = useState("")

  // Add Participant form
  const [showAddParticipant, setShowAddParticipant] = useState(false)
  const [newParticipantName, setNewParticipantName] = useState("")
  const [newParticipantRole, setNewParticipantRole] = useState("cooperating_agent")
  const [newParticipantEmail, setNewParticipantEmail] = useState("")
  const [newParticipantPhone, setNewParticipantPhone] = useState("")
  const [newParticipantCompany, setNewParticipantCompany] = useState("")

  // Add Commission form
  const [showAddCommission, setShowAddCommission] = useState(false)
  const [newCommRecipientName, setNewCommRecipientName] = useState("")
  const [newCommRecipientType, setNewCommRecipientType] = useState("agent")
  const [newCommType, setNewCommType] = useState("buyer_side")
  const [newCommRate, setNewCommRate] = useState("")

  // Submit Repair Request form
  // ── MILESTONES WITH A LIFECYCLE BEHIND THEM ────────────────────────────────
  // Three milestones are not just a status flip. transaction-milestones.ts has a
  // dedicated action for each, and every one of them was unreachable — so the
  // generic "Complete" button below silently skipped:
  //   appraisal_ordered   → the appraiser-packet coaching moment (be present,
  //                         bring the packet) + the APPRAISAL_ORDERED portal card
  //   appraisal_completed → the appraisal-GAP detector: compares the value to the
  //                         contract price and, on a shortfall, fires
  //                         APPRAISAL_GAP_DETECTED, convenes the deal-save huddle,
  //                         and hands the agent the three priced negotiation plays
  //   final_walkthrough   → schedule (sets the date + fans out) and complete
  // A low appraisal was being recorded as a tick in a checklist.
  const [appraisalDialogOpen, setAppraisalDialogOpen] = useState(false)
  const [appraisalValue, setAppraisalValue] = useState("")
  const [appraisalError, setAppraisalError] = useState<string | null>(null)
  const [walkthroughDialogOpen, setWalkthroughDialogOpen] = useState(false)
  const [walkthroughDate, setWalkthroughDate] = useState("")
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null)

  /** Milestones whose completion runs a real lifecycle, not just a status flip. */
  const LIFECYCLE_MILESTONES = new Set([
    "appraisal_ordered",
    "appraisal_completed",
    "final_walkthrough_scheduled",
  ])

  function markMilestoneDone(m: { id: string; milestone_name: string }) {
    startTransition(async () => {
      let res: { success: boolean; error?: string }
      if (m.milestone_name === "appraisal_ordered") {
        res = await markAppraisalOrderedAction({
          transactionId: transaction.id,
          brokerageId,
        })
      } else if (m.milestone_name === "final_walkthrough_scheduled") {
        res = await completeFinalWalkthroughAction({
          transactionId: transaction.id,
          brokerageId,
        })
      } else {
        res = await completeMilestoneAction({
          transactionId: transaction.id,
          brokerageId,
          milestoneName: m.milestone_name,
        })
      }
      if (res.success) {
        const now = new Date().toISOString()
        setLocalMilestones((prev) =>
          prev.map((row) => (row.id === m.id ? { ...row, status: "completed", completed_at: now } : row)),
        )
        toast.success("Milestone marked complete")
        router.refresh()
      } else {
        toast.error(res.error ?? "Failed to update milestone")
      }
    })
  }

  function submitAppraisalComplete() {
    const value = Number(appraisalValue)
    if (!appraisalValue.trim() || !Number.isFinite(value) || value <= 0) {
      setAppraisalError("Enter the appraised value — the gap check needs a real number to compare against the contract price.")
      return
    }
    setAppraisalError(null)
    startTransition(async () => {
      const res = await markAppraisalCompleteAction({
        transactionId: transaction.id,
        brokerageId,
        appraisalValue: value,
      })
      if (res.success) {
        setAppraisalDialogOpen(false)
        setAppraisalValue("")
        setLocalMilestones((prev) =>
          prev.map((row) =>
            row.milestone_name === "appraisal_completed"
              ? { ...row, status: "completed", completed_at: new Date().toISOString() }
              : row,
          ),
        )
        toast.success("Appraisal recorded — gap check run against the contract price")
        router.refresh()
      } else {
        setAppraisalError(res.error ?? "Could not record the appraisal")
      }
    })
  }

  function submitWalkthroughSchedule() {
    if (!walkthroughDate) {
      setWalkthroughError("Pick a date for the final walkthrough.")
      return
    }
    setWalkthroughError(null)
    startTransition(async () => {
      const res = await scheduleFinalWalkthroughAction({
        transactionId: transaction.id,
        brokerageId,
        walkthroughDate,
      })
      if (res.success) {
        setWalkthroughDialogOpen(false)
        setWalkthroughDate("")
        toast.success("Final walkthrough scheduled")
        router.refresh()
      } else {
        setWalkthroughError(res.error ?? "Could not schedule the walkthrough")
      }
    })
  }

  const [showRepairForm, setShowRepairForm] = useState(false)
  const [newRepairItem, setNewRepairItem] = useState("")
  const [newRepairCost, setNewRepairCost] = useState("")

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

  // Transaction Warnings — issues + delays loaded on mount
  const [txWarnings, setTxWarnings] = useState<string[]>([])

  useEffect(() => {
    Promise.all([
      detectTransactionIssues(transaction.id).catch(() => null),
      detectTransactionDelays(transaction.id).catch(() => null),
    ]).then(([issues, delays]) => {
      const warnings: string[] = []
      if (issues && typeof issues === "object" && "issues" in issues) {
        const issueList = (issues as any).issues
        if (Array.isArray(issueList)) {
          issueList.forEach((i: any) => warnings.push(typeof i === "string" ? i : i.description ?? i.issue ?? String(i)))
        }
      }
      if (Array.isArray(delays)) {
        delays.forEach((d: any) => warnings.push(d.description ?? d.delay ?? String(d)))
      } else if (delays && typeof delays === "object" && "delays" in delays) {
        const delayList = (delays as any).delays
        if (Array.isArray(delayList)) {
          delayList.forEach((d: any) => warnings.push(d.description ?? d.delay ?? String(d)))
        }
      }
      setTxWarnings(warnings)
    })
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
      // The action reports failure BY RETURN ({ success:false, error }) — it checks
      // authorisation and that the transaction belongs to this brokerage. Discarding
      // it meant the screen refreshed as though the quote had been approved when it
      // had not, and the broker was never told.
      const res = quoteType === "inspector"
        ? await approveInspectionQuoteAction({
            activityId,
            transactionId: transaction.id,
            brokerageId,
            vendorName,
          })
        : await approveInsuranceQuoteAction({
            activityId,
            serviceId: activityId,
            transactionId: transaction.id,
            brokerageId,
            vendorName,
          })
      if (!res?.success) {
        toast.error((res as any)?.error ?? "The approval did not go through.")
        return
      }
      router.refresh()
    })
  }

  // The other half of the quote-approval decision. The alert offered ONLY
  // "Approve": a client who did not want that inspector's price had no way to
  // say so, and the pending activity row sat in the queue forever because
  // nothing in the app could resolve it any other way. declineQuote is the
  // same workflow's decline path (lib/transactions/vendor-quote-workflow.ts).
  async function handleDeclineQuote(activityId: string) {
    const reason = window.prompt("Why is this quote being declined? (optional — shown to the agent)")
    if (reason === null) return
    startTransition(async () => {
      const res = await declineInspectionQuoteAction({
        activityId,
        transactionId: transaction.id,
        brokerageId,
        reason: reason.trim() || undefined,
      })
      if (!res?.success) {
        toast.error((res as any)?.error ?? "The decline did not go through.")
        return
      }
      toast.success("Quote declined.")
      router.refresh()
    })
  }

  async function handleMarkInspectionComplete(inspectionId: string) {
    startTransition(async () => {
        // The action reports failure BY RETURN ({ success:false, error }) — it
        // checks authorisation and that the transaction is in this brokerage.
        // Discarding it meant the screen refreshed as though the approval had
        // happened when it had not, with nothing shown to the broker.
        const res = await markInspectionCompleteAction({
          inspectionId,
          transactionId: transaction.id,
          brokerageId,
        })
        if (!res?.success) {
          toast.error((res as any)?.error ?? "Could not mark the inspection complete.")
          return
        }
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
        // The action reports failure BY RETURN ({ success:false, error }) — it
        // checks authorisation and that the transaction is in this brokerage.
        // Discarding it meant the screen refreshed as though the approval had
        // happened when it had not, with nothing shown to the broker.
        const res = await submitInsuranceQuoteApprovalAction({
          serviceId,
          transactionId: transaction.id,
          brokerageId,
          vendorName,
          quoteAmount: parseFloat(insuranceQuoteAmount),
        })
        if (!res?.success) {
          toast.error((res as any)?.error ?? "The quote was not submitted.")
          return
        }
      setInsuranceQuoteAmount("")
      router.refresh()
    })
  }

  // ─── EARNEST MONEY HANDLER ───────────────────────────────────────────────────

  async function handleUpdateEarnestMoney() {
    startTransition(async () => {
        // The action reports failure BY RETURN ({ success:false, error }) — it
        // checks authorisation and that the transaction is in this brokerage.
        // Discarding it meant the screen refreshed as though the approval had
        // happened when it had not, with nothing shown to the broker.
        const res = await updateEarnestMoneyAction({
          transactionId: transaction.id,
          brokerageId,
          titleEscrowId: titleEscrow?.id,
          earnestMoneyAmount: emAmount ? parseFloat(emAmount) : undefined,
          earnestMoneyHeldBy: emHeldBy || undefined,
          earnestMoneyReceivedDate: emReceivedDate || undefined,
        })
        if (!res?.success) {
          toast.error((res as any)?.error ?? "Earnest money was not updated.")
          return
        }
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

      {/* AI Warnings Panel */}
      {txWarnings.length > 0 && (
        <Alert className="rounded-none border-x-0 border-t-0 border-yellow-300 bg-yellow-50">
          <AlertTriangle className="h-4 w-4 text-yellow-600" />
          <AlertTitle className="text-yellow-800">Transaction Warnings</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside space-y-0.5 mt-1">
              {txWarnings.map((w, i) => (
                <li key={i} className="text-sm text-yellow-700">{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="border-b bg-card">
        <div className="container py-4">
          <div className="flex items-center gap-4 mb-3">
            <Link
              href={userType === "tc" ? "/dashboard/coordinator" : "/dashboard/transactions"}
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
            {/* ── ORPHAN-ROUTE SWEEP (lane G) — THE LINK THIS HEADER OWED. ─────
                /dashboard/transactions/[id]/milestones is the ad-hoc milestone
                surface `createTransactionMilestone` (app/actions/copilot.ts) was
                written for — the only lane in the product for adding ONE
                milestone by hand; everything else writes a SET. The page's own
                docblock recorded the debt: "There is no LINK into this route yet…
                The one line still owed on the parent (a link to this route from
                the deal header) is REPORTED, not written here." The lane boundary
                that deferred it has since closed. This is that line.
                Unconditional, unlike CDA Workflow above it: a deal has
                milestones at every stage, not only in CLOSING_PREP. */}
            <Link href={`/dashboard/transactions/${transaction.id}/milestones`}>
              <Button variant="outline" size="sm">
                <FileText className="h-4 w-4 mr-2" />
                Milestones
              </Button>
            </Link>
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

      {/* Milestone Timeline Ribbon */}
      {(() => {
        const KEY_MILESTONES: Array<{ label: string; owner: string }> = [
          { label: "Earnest Money", owner: "TC / Buyer" },
          { label: "Inspection",    owner: "TC / Agent" },
          { label: "Appraisal",     owner: "Lender" },
          { label: "Financing",     owner: "Lender" },
          { label: "Clear to Close", owner: "Lender" },
          { label: "Final Walkthrough", owner: "Agent" },
          { label: "Closing Date",  owner: "TC / Title" },
        ]
        const now = new Date()
        const ribbonItems = KEY_MILESTONES.map(({ label, owner }) => {
          const found = milestones.find((m) =>
            m.milestone_name?.toLowerCase().includes(label.toLowerCase())
          ) ?? deadlines.find((d) =>
            d.deadline_type?.toLowerCase().includes(label.toLowerCase())
          )
          const date = found
            ? new Date((found as any).target_date ?? (found as any).deadline_date ?? "")
            : null
          const completed = (found as any)?.status === "completed" || (found as any)?.status === "done"
          const overdue = !!(date && date < now && !completed)
          const daysOverdue = overdue && date ? Math.floor((now.getTime() - date.getTime()) / 86400000) : 0
          return { label, owner, date, completed, overdue, daysOverdue }
        })

        // Compliance flags derived from available data
        const hasAllDocs = (documentCountsByStatus?.approved ?? 0) > 0 && (documentCountsByStatus?.missing ?? 0) === 0
        const tridDoc = documents.find((d) => d.doc_type?.includes("closing_disclosure") || d.doc_type?.includes("trid"))
        const tridSent = !!tridDoc && tridDoc.status !== "missing" && tridDoc.status !== "rejected"

        return (
          <div className="border-b bg-muted/30">
            {/* Milestone dots */}
            <div className="container pt-3 pb-1 overflow-x-auto">
              <div className="flex items-start gap-0 min-w-max">
                {ribbonItems.map((item, i) => (
                  <div key={item.label} className="flex items-start">
                    <div className="flex flex-col items-center px-3">
                      <div
                        className={cn(
                          "h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                          item.completed
                            ? "bg-emerald-500 text-white"
                            : item.overdue
                            ? "bg-red-500 text-white"
                            : "bg-muted border-2 border-border text-muted-foreground"
                        )}
                      >
                        {item.completed ? "✓" : item.overdue ? "!" : i + 1}
                      </div>
                      <p className="text-[10px] font-medium mt-1 text-center w-16 leading-tight">
                        {item.label}
                      </p>
                      <p className="text-[9px] text-muted-foreground text-center w-16">{item.owner}</p>
                      {item.date && (
                        <p
                          className={cn(
                            "text-[9px] tabular-nums",
                            item.overdue
                              ? "text-red-600 font-semibold"
                              : item.completed
                              ? "text-emerald-600"
                              : "text-muted-foreground"
                          )}
                        >
                          {item.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          {item.overdue && item.daysOverdue > 0 && ` (+${item.daysOverdue}d)`}
                        </p>
                      )}
                      {item.overdue && (
                        <span className="text-[8px] uppercase tracking-wide text-red-600 font-bold mt-0.5">
                          OVERDUE
                        </span>
                      )}
                    </div>
                    {i < ribbonItems.length - 1 && (
                      <div
                        className={cn(
                          "h-px w-8 shrink-0 mt-3",
                          ribbonItems[i + 1]?.completed
                            ? "bg-emerald-400"
                            : ribbonItems[i + 1]?.overdue
                            ? "bg-red-300"
                            : "bg-border"
                        )}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Compliance flags strip */}
            <div className="container pb-2 flex items-center gap-4 flex-wrap text-[10px]">
              <span className="text-muted-foreground font-medium uppercase tracking-wide">Compliance:</span>
              <span className={cn("flex items-center gap-1", tridSent ? "text-emerald-600" : "text-amber-600")}>
                {tridSent ? "✓" : "⚠"} TRID Disclosure
              </span>
              <span className={cn("flex items-center gap-1", hasAllDocs ? "text-emerald-600" : "text-amber-600")}>
                {hasAllDocs ? "✓" : "⚠"} All Docs Uploaded
              </span>
              <Link
                href={`/dashboard/transactions/${transaction.id}/cda`}
                className="flex items-center gap-1 text-primary hover:underline"
              >
                → CDA Status
              </Link>
            </div>
          </div>
        )
      })()}

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
                    {(currentStage as string) !== "CLOSED" && (currentStage as string) !== "LOST" && (
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
                    {(currentStage as string) === "CLOSED" && (
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
                {/* Trend + actions row — always rendered when we have a score */}
                {healthScore && (
                  <div className="mt-3 pt-3 border-t flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {typeof healthScore.score_delta === "number" && healthScore.score_delta !== 0 ? (
                        <span className={cn(
                          "inline-flex items-center gap-0.5 font-medium",
                          healthScore.score_delta > 0 ? "text-emerald-600" : "text-red-600",
                        )}>
                          {healthScore.score_delta > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                          {healthScore.score_delta > 0 ? "+" : ""}{healthScore.score_delta}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5">— flat</span>
                      )}
                      {healthScoreHistory && healthScoreHistory.length > 1 && (
                        <span className="text-[10px]">
                          ({healthScoreHistory.length} scores · last {new Date(healthScore.scored_at).toLocaleDateString()})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] gap-1"
                        disabled={rescanning}
                        onClick={handleRescan}
                        title="Trigger fresh deal-health score now"
                      >
                        <RefreshCw className={cn("h-3 w-3", rescanning && "animate-spin")} />
                        Refresh
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] gap-1"
                        disabled={aiAnalyzing}
                        onClick={handleAiAnalysis}
                        title="Run the AI read: win probability, narrative risks and next best actions"
                      >
                        <Sparkles className={cn("h-3 w-3", aiAnalyzing && "animate-pulse")} />
                        AI read
                      </Button>
                      <Link
                        href={`/dashboard/transactions/${transaction.id}/health`}
                        className="inline-flex items-center gap-1 h-6 px-2 text-[11px] rounded-md hover:bg-accent"
                      >
                        Full report
                        <ChevronRight className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>
                )}

                {/* Unresolved interventions list — actionable inline */}
                {unresolvedInterventions && unresolvedInterventions.length > 0 && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <p className="text-[11px] font-semibold text-foreground">
                      {unresolvedInterventions.length} open intervention{unresolvedInterventions.length === 1 ? "" : "s"}
                    </p>
                    <ul className="space-y-1.5">
                      {unresolvedInterventions.slice(0, 3).map((iv) => (
                        <li key={iv.id} className={cn(
                          "rounded-md border p-2 text-[11px] space-y-0.5",
                          iv.severity === "critical" ? "border-red-200 bg-red-50" :
                          iv.severity === "high"     ? "border-amber-200 bg-amber-50" :
                                                       "border-input bg-muted/20",
                        )}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium leading-snug">{iv.issue_detected}</p>
                            <span className={cn(
                              "text-[9px] uppercase px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap",
                              iv.severity === "critical" ? "bg-red-200 text-red-800" :
                              iv.severity === "high"     ? "bg-amber-200 text-amber-800" :
                                                           "bg-gray-200 text-gray-700",
                            )}>
                              {iv.severity}
                            </span>
                          </div>
                          {iv.ai_recommendation && (
                            <p className="text-muted-foreground leading-snug">{iv.ai_recommendation}</p>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-[10px] mt-0.5"
                            disabled={resolvingId === iv.id}
                            onClick={() => handleResolveIntervention(iv.id)}
                          >
                            {resolvingId === iv.id ? <Loader2 className="h-2.5 w-2.5 animate-spin mr-1" /> : null}
                            Mark resolved
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {unresolvedInterventions.length > 3 && (
                      <Link
                        href={`/dashboard/transactions/${transaction.id}/health`}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        See all {unresolvedInterventions.length} interventions →
                      </Link>
                    )}
                  </div>
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

            {/* Unsigned-document blockers for THIS transaction.
                Source: getUnsignedDocumentBlockers (transaction_documents ⋈
                contract_signatures), not the brokerage-wide signature map this
                card used to iterate. Two things change for the agent:
                  · doc types belonging to OTHER deals no longer appear here; and
                  · a signable document that was NEVER sent for signature now
                    raises a blocker — the old card could only ever list
                    documents that already had a signature row, so "never sent"
                    read as "nothing pending". */}
            {unsignedDocBlockers.length > 0 && (
              <Card className="border-amber-200 bg-amber-50/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
                    <PenLine className="h-4 w-4" />
                    Signatures Pending ({unsignedDocBlockers.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {unsignedDocBlockers.map((b) => (
                    <div key={b.docId} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-amber-900 truncate">{b.docLabel}</span>
                      <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-amber-200 shrink-0">
                        {b.signatureId
                          ? (b.esignStatus?.replace(/_/g, " ") ?? "pending")
                          : "not sent"}
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
              availableTCs={(availableTCs ?? []) as any[]}
              userType={userType}
            />

            {/* Assign Lender Panel */}
            <AssignLenderPanel
              transactionId={transaction.id}
              currentLenderUserId={currentLenderUserId}
              availableLenderUsers={availableLenderUsers}
              userType={userType}
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
                    ) : null}
                    {/* Already told them by phone / in person? Record the
                        disclosure WITHOUT re-sending a portal notice —
                        markDelaysCommunicated flips only the flag, and refuses
                        (rather than claiming success) when no delay row exists. */}
                    {!delays.communicated_to_client ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1 text-xs text-amber-700 dark:text-amber-300"
                        disabled={isLoggingDelay}
                        onClick={async () => {
                          const res = await markDelaysCommunicated(transaction.id)
                          if (res.success) {
                            toast.success("Marked as communicated to client")
                            setDelays({ ...delays, communicated_to_client: true })
                          } else {
                            toast.error(res.error ?? "Could not mark as communicated")
                          }
                        }}
                      >
                        Already communicated outside the app — mark as told
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

        {/* Tabs Section — 5 grouped outer tabs with sub-tabs.
            Inner TabsContent values unchanged so existing content blocks
            keep rendering as-is. */}
        <div className="mt-6">
          {(() => {
            // Map any existing tab value → outer group
            const TIMELINE_SUBS = ["milestones", "deadlines", "deposits", "inspection", "repairs"] as const
            const TEAM_SUBS     = ["participants", "lender", "title", "partners"] as const
            const DOCS_SUBS     = ["documents", "forms", "compliance"] as const
            const outerTab =
              TIMELINE_SUBS.includes(activeTab as any) ? "timeline" :
              TEAM_SUBS.includes(activeTab as any)     ? "team" :
              DOCS_SUBS.includes(activeTab as any)     ? "docs" :
              activeTab === "commissions"              ? "money" :
              activeTab === "vendors"                  ? "vendors" :
              "timeline"

            const overdueComplianceCount = complianceTasks.filter(
              t => t.status === "pending" && t.due_date && new Date(t.due_date) < new Date()
            ).length

            return null
          })()}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            {/* OUTER tab navigation — 5 groups */}
            {(() => {
              const TIMELINE_SUBS = ["milestones", "deadlines", "deposits", "inspection", "repairs"] as const
              const TEAM_SUBS     = ["participants", "lender", "title", "partners"] as const
              const DOCS_SUBS     = ["documents", "forms", "compliance"] as const
              const outerTab =
                TIMELINE_SUBS.includes(activeTab as any) ? "timeline" :
                TEAM_SUBS.includes(activeTab as any)     ? "team" :
                DOCS_SUBS.includes(activeTab as any)     ? "docs" :
                activeTab === "commissions"              ? "money" :
                activeTab === "vendors"                  ? "vendors" :
                "timeline"

              const overdueComplianceCount = complianceTasks.filter(
                t => t.status === "pending" && t.due_date && new Date(t.due_date) < new Date()
              ).length

              const outerTabs: Array<{ key: string; label: string; icon: any; defaultSub: string; badge?: React.ReactNode }> = [
                { key: "timeline", label: "Timeline",  icon: Calendar,      defaultSub: "milestones",
                  badge: overdueComplianceCount > 0
                    ? <Badge variant="destructive" className="ml-1 h-4 px-1 text-[10px]">{overdueComplianceCount}</Badge>
                    : null },
                { key: "team",     label: "Team",      icon: Users,         defaultSub: "participants" },
                { key: "docs",     label: "Documents", icon: FileText,      defaultSub: "documents",
                  badge: formsProvider?.is_configured
                    ? <span className="ml-1 flex h-1.5 w-1.5 rounded-full bg-green-500" />
                    : null },
                { key: "vendors",  label: "Vendors",   icon: Wrench,        defaultSub: "vendors" },
                { key: "money",    label: "Money",     icon: DollarSign,    defaultSub: "commissions" },
              ]

              const subTabsByOuter: Record<string, Array<{ value: string; label: string; icon?: any; badge?: React.ReactNode }>> = {
                timeline: [
                  { value: "milestones", label: "Milestones",  icon: Calendar },
                  { value: "deadlines",  label: "Deadlines",   icon: Clock },
                  { value: "deposits",   label: "Deposits",    icon: Landmark,
                    badge: overdueComplianceCount > 0
                      ? <Badge variant="destructive" className="ml-1 h-4 px-1 text-[10px]">{overdueComplianceCount}</Badge>
                      : deposits.some(d => d.status === "received" && d.due_date && new Date(d.due_date) < new Date())
                      ? <span className="ml-1 flex h-1.5 w-1.5 rounded-full bg-red-500" />
                      : null },
                  { value: "inspection", label: "Inspection",  icon: Shield },
                  { value: "repairs",    label: "Repairs" },
                ],
                team: [
                  { value: "participants", label: "Participants", icon: Users },
                  { value: "lender",       label: "Lender",       icon: Building2 },
                  { value: "title",        label: "Title & Escrow", icon: Home },
                  { value: "partners",     label: "Partners",     icon: Landmark },
                ],
                docs: [
                  { value: "documents",  label: "Documents",  icon: FileText },
                  { value: "forms",      label: "Forms",      icon: ClipboardList,
                    badge: formsProvider?.is_configured
                      ? <span className="ml-1 flex h-1.5 w-1.5 rounded-full bg-green-500" />
                      : null },
                  { value: "compliance", label: "Compliance" },
                ],
              }

              const activeSubs = subTabsByOuter[outerTab]

              return (
                <>
                  {/* OUTER tabs — switch active tab to that group's default sub when clicked */}
                  <div className="flex items-center gap-1 border-b mb-2 overflow-x-auto pb-px">
                    {outerTabs.map(t => {
                      const Icon = t.icon
                      const isActive = outerTab === t.key
                      return (
                        <button
                          key={t.key}
                          type="button"
                          onClick={() => setActiveTab(t.defaultSub)}
                          className={
                            "px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap -mb-px flex items-center " +
                            (isActive
                              ? "border-primary text-primary"
                              : "border-transparent text-muted-foreground hover:text-foreground")
                          }
                        >
                          <Icon className="h-3.5 w-3.5 mr-1.5" />
                          {t.label}
                          {t.badge}
                        </button>
                      )
                    })}
                  </div>

                  {/* SUB tabs — only when group has multiple */}
                  {activeSubs && activeSubs.length > 1 && (
                    <TabsList className="flex-wrap h-auto gap-1 mb-2">
                      {activeSubs.map(s => {
                        const Icon = s.icon
                        return (
                          <TabsTrigger key={s.value} value={s.value} className="text-xs">
                            {Icon && <Icon className="h-3 w-3 mr-1" />}
                            {s.label}
                            {s.badge}
                          </TabsTrigger>
                        )
                      })}
                    </TabsList>
                  )}
                </>
              )
            })()}

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
                      const isOverdue = m.status !== "completed" && m.target_date
                        ? new Date(m.target_date) < new Date()
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
                              : m.target_date
                              ? `${isOverdue ? "Overdue: " : ""}${format(new Date(m.target_date), "MMM d, yyyy")}`
                              : "No date set"}
                          </span>

                          {/* Override badge — written when broker forces past blocker */}
                          {m.override_at && m.status !== "completed" && (
                            <Badge
                              variant="outline"
                              className="h-6 text-[10px] text-amber-700 border-amber-300 bg-amber-50"
                              title={m.override_reason ?? "Overridden"}
                            >
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              Overridden
                            </Badge>
                          )}

                          {/* Schedule — only the final walkthrough carries a
                              date the agent sets ahead of completing it. */}
                          {m.milestone_name === "final_walkthrough_scheduled" &&
                            m.status !== "completed" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs px-2"
                              disabled={isPending}
                              onClick={() => {
                                setWalkthroughDate("")
                                setWalkthroughError(null)
                                setWalkthroughDialogOpen(true)
                              }}
                            >
                              {m.target_date ? "Reschedule" : "Schedule"}
                            </Button>
                          )}

                          {/* Mark Complete — routes to the milestone's own
                              lifecycle action where one exists (appraisal
                              ordered / completed, final walkthrough), otherwise
                              the canonical completeMilestone. The generic path
                              alone flipped a status and skipped the appraisal
                              gap detector, the appraiser-packet coaching and the
                              portal fan-out those milestones own. */}
                          {m.status !== "completed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              disabled={isPending}
                              onClick={() => {
                                if (m.milestone_name === "appraisal_completed") {
                                  // Needs the appraised value — the gap check has
                                  // nothing to compare without it.
                                  setAppraisalValue("")
                                  setAppraisalError(null)
                                  setAppraisalDialogOpen(true)
                                  return
                                }
                                markMilestoneDone(m)
                              }}
                              title={
                                LIFECYCLE_MILESTONES.has(m.milestone_name)
                                  ? "Runs this milestone's full lifecycle, not just a status change"
                                  : undefined
                              }
                            >
                              Complete
                            </Button>
                          )}

                          {/* Override — only for elevated user_types and only
                              for non-completed milestones. Lets broker / admin
                              / compliance push past an overdue or blocked
                              milestone with an audit-trail reason. */}
                          {canOverrideStage && m.status !== "completed" && !m.override_at && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs px-2 text-amber-700 hover:bg-amber-50"
                              disabled={isPending}
                              onClick={() => {
                                setMilestoneOverrideName(m.milestone_name)
                                setMilestoneOverrideReason("")
                                setMilestoneOverrideError(null)
                              }}
                            >
                              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                              Override
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
                                // This toggle decides what a CLIENT sees in their portal, so it
                                // goes through the server action written for it —
                                // app/actions/transactions.ts:setMilestoneClientVisibility —
                                // not a raw browser-side update. Two things the inline version
                                // could not do: validate the milestone id, and revalidate the
                                // server-rendered surfaces (the portal journey and the
                                // transactions list read this flag), which left the portal
                                // showing the old visibility until something else happened to
                                // revalidate it.
                                const res = await setMilestoneClientVisibility(m.id, visible)
                                if (!res.success) {
                                  setLocalMilestones((prev) =>
                                    prev.map((row) =>
                                      row.id === m.id ? { ...row, is_client_visible: !visible } : row
                                    )
                                  )
                                  toast.error(res.error ?? "Failed to update milestone visibility")
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
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-medium">Deadlines</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => setShowAddDeadline((v) => !v)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Deadline
                  </Button>
                </CardHeader>
                <CardContent className="space-y-2">
                  {showAddDeadline && (
                    <div className="border rounded-lg p-3 space-y-3 bg-muted/30 mb-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Type</Label>
                          <select
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            value={newDeadlineType}
                            onChange={(e) => setNewDeadlineType(e.target.value)}
                          >
                            <option value="contingency_period">Contingency Period</option>
                            <option value="inspection_deadline">Inspection Deadline</option>
                            <option value="appraisal_deadline">Appraisal Deadline</option>
                            <option value="loan_commitment">Loan Commitment</option>
                            <option value="closing_date">Closing Date</option>
                            <option value="possession_date">Possession Date</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Date</Label>
                          <input
                            type="date"
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            value={newDeadlineDate}
                            onChange={(e) => setNewDeadlineDate(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Label (optional)</Label>
                        <input
                          className="w-full h-8 text-xs border rounded px-2 bg-background"
                          placeholder="Custom label…"
                          value={newDeadlineLabel}
                          onChange={(e) => setNewDeadlineLabel(e.target.value)}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="w-full text-xs h-7"
                        disabled={!newDeadlineDate || isPending}
                        onClick={() => {
                          if (!newDeadlineDate) return
                          startTransition(async () => {
                            const { addDeadline } = await import("@/app/actions/transactions")
                            const result = await addDeadline({
                              transaction_id: transaction.id,
                              deadline_type: newDeadlineType,
                              notes: newDeadlineLabel || newDeadlineType.replace(/_/g, " "),
                              deadline_date: newDeadlineDate,
                            })
                            if (result?.success) {
                              toast.success("Deadline added")
                              setShowAddDeadline(false)
                              setNewDeadlineDate("")
                              setNewDeadlineLabel("")
                              router.refresh()
                            } else {
                              toast.error("Failed to add deadline")
                            }
                          })
                        }}
                      >
                        {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Save Deadline
                      </Button>
                    </div>
                  )}
                  {deadlines.map((d) => (
                    <div key={d.id} className="flex items-center justify-between py-2 border-b last:border-0">
                      <span className="text-sm">{d.deadline_type.replace(/_/g, " ")}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant={d.status === "completed" ? "default" : "secondary"}>
                          {new Date(d.deadline_date).toLocaleDateString()}
                        </Badge>
                        {d.status !== "completed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-green-600 hover:text-green-700"
                            title="Mark complete"
                            onClick={() => {
                              startTransition(async () => {
                                const { completeDeadline } = await import("@/app/actions/transactions")
                                await completeDeadline(d.id)
                                router.refresh()
                              })
                            }}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  {deadlines.length === 0 && !showAddDeadline && (
                    <p className="text-sm text-muted-foreground">No deadlines defined.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Participants Tab */}
            <TabsContent value="participants" className="mt-4">
              <Card>
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-medium">Participants</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => setShowAddParticipant((v) => !v)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Participant
                  </Button>
                </CardHeader>
                <CardContent>
                  {showAddParticipant && (
                    <div className="border rounded-lg p-3 space-y-3 bg-muted/30 mb-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Name</Label>
                          <input
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="Full name"
                            value={newParticipantName}
                            onChange={(e) => setNewParticipantName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Role</Label>
                          <select
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            value={newParticipantRole}
                            onChange={(e) => setNewParticipantRole(e.target.value)}
                          >
                            <option value="cooperating_agent">Cooperating Agent</option>
                            <option value="listing_agent">Listing Agent</option>
                            <option value="buyer">Buyer</option>
                            <option value="seller">Seller</option>
                            <option value="lender">Lender</option>
                            <option value="escrow_officer">Escrow Officer</option>
                            <option value="inspector">Inspector</option>
                            <option value="attorney">Attorney</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Email</Label>
                          <input
                            type="email"
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="email@example.com"
                            value={newParticipantEmail}
                            onChange={(e) => setNewParticipantEmail(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Phone</Label>
                          <input
                            type="tel"
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="(555) 000-0000"
                            value={newParticipantPhone}
                            onChange={(e) => setNewParticipantPhone(e.target.value)}
                          />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <Label className="text-xs">Company</Label>
                          <input
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="Company name (optional)"
                            value={newParticipantCompany}
                            onChange={(e) => setNewParticipantCompany(e.target.value)}
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        className="w-full text-xs h-7"
                        disabled={!newParticipantName || isPending}
                        onClick={() => {
                          if (!newParticipantName) return
                          startTransition(async () => {
                            const { addParticipant } = await import("@/app/actions/transactions")
                            const result = await addParticipant({
                              transaction_id: transaction.id,
                              name: newParticipantName,
                              role: newParticipantRole,
                              email: newParticipantEmail || undefined,
                              phone: newParticipantPhone || undefined,
                              company: newParticipantCompany || undefined,
                            })
                            if (result?.success) {
                              toast.success("Participant added")
                              setShowAddParticipant(false)
                              setNewParticipantName("")
                              setNewParticipantEmail("")
                              setNewParticipantPhone("")
                              setNewParticipantCompany("")
                              router.refresh()
                            } else {
                              toast.error("Failed to add participant")
                            }
                          })
                        }}
                      >
                        {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Add Participant
                      </Button>
                    </div>
                  )}
                  <div className="grid gap-3">
                    {participants.map((p) => (
                      <div key={p.id} className="flex items-center justify-between py-2 border-b last:border-0">
                        <div>
                          <p className="text-sm font-medium">{p.name}</p>
                          <p className="text-xs text-muted-foreground capitalize">{p.role.replace(/_/g, " ")} {p.company ? `at ${p.company}` : ""}</p>
                        </div>
                        <div className="text-xs text-muted-foreground text-right">
                          {p.email && <p>{p.email}</p>}
                          {p.phone && <p>{p.phone}</p>}
                        </div>
                      </div>
                    ))}
                    {participants.length === 0 && !showAddParticipant && (
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
                    {titleEscrow?.earnest_money_received_date && (
                      <Alert className="border-green-500 bg-green-50">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <AlertTitle className="text-green-800">Earnest Money Received</AlertTitle>
                        <AlertDescription className="text-green-700">
                          ${titleEscrow.earnest_money_amount?.toLocaleString() ?? emAmount} received on{" "}
                          {new Date(titleEscrow.earnest_money_received_date).toLocaleDateString()}{" "}
                          {titleEscrow.earnest_money_held_by && `held by ${titleEscrow.earnest_money_held_by.replace(/_/g, " ")}`}
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
                                <span className="flex items-center gap-2">
                                  <Button
                                    size="sm"
                                    onClick={() => handleApproveQuote(a.id, meta.vendor_name as string, "inspector")}
                                    disabled={isPending}
                                  >
                                    {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Approve"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-red-700 border-red-300 hover:bg-red-50"
                                    onClick={() => handleDeclineQuote(a.id)}
                                    disabled={isPending}
                                  >
                                    Decline
                                  </Button>
                                </span>
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

            {/* Vendors Tab */}
            <TabsContent value="vendors" className="mt-4 space-y-4">
              {/* Vendor Bookings */}
              <VendorBookingSection
                transactionId={transaction.id}
                transactionStage={transaction.stage ?? undefined}
                initialBookings={vendorBookings as any}
              />

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
            <TabsContent value="repairs" className="mt-4 space-y-3">
              <RepairCoPilotPanel
                transactionId={transaction.id}
                side={transaction.deal_type === "buyer" ? "buyer" : "seller"}
              />
              <Card>
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-medium">Repair Negotiations</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => setShowRepairForm((v) => !v)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Request Repairs
                  </Button>
                </CardHeader>
                <CardContent>
                  {showRepairForm && (
                    <div className="border rounded-lg p-3 space-y-3 bg-muted/30 mb-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Item Description</Label>
                        <input
                          className="w-full h-8 text-xs border rounded px-2 bg-background"
                          placeholder="e.g. HVAC unit replacement"
                          value={newRepairItem}
                          onChange={(e) => setNewRepairItem(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Estimated Cost ($)</Label>
                        <input
                          type="number"
                          className="w-full h-8 text-xs border rounded px-2 bg-background"
                          placeholder="0"
                          value={newRepairCost}
                          onChange={(e) => setNewRepairCost(e.target.value)}
                        />
                      </div>
                      <Button
                        size="sm"
                        className="w-full text-xs h-7"
                        disabled={!newRepairItem || isPending}
                        onClick={() => {
                          if (!newRepairItem) return
                          startTransition(async () => {
                            // requestRepairAction, NOT the application-layer
                            // submitRepairRequest this form used to call: that one
                            // inserts an UNTENANTED row (no brokerage_id, no scope
                            // check) and fires no kernel event, so the other side
                            // of the deal never learned a repair had been asked
                            // for. This path verifies the transaction is in the
                            // caller's brokerage, stamps brokerage_id, and emits
                            // LISTING_REPAIR_REQUIRED so the buyer/seller portals
                            // fan out.
                            const result = await requestRepairAction({
                              transactionId: transaction.id,
                              brokerageId,
                              requestedBy: "buyer",
                              itemDescription: newRepairItem,
                              estimatedCost: newRepairCost ? Number(newRepairCost) : undefined,
                            })
                            if (result.success) {
                              toast.success("Repair request submitted")
                              setShowRepairForm(false)
                              setNewRepairItem("")
                              setNewRepairCost("")
                              router.refresh()
                            } else {
                              toast.error(result.error ?? "Failed to submit repair request")
                            }
                          })
                        }}
                      >
                        {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Submit Request
                      </Button>
                    </div>
                  )}
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
                          <div className="flex items-center gap-2">
                            <Badge className="capitalize">{r.status}</Badge>
                            {r.status === "requested" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-6 px-2"
                                onClick={() => {
                                  startTransition(async () => {
                                    const { respondToRepairRequest } = await import("@/app/actions/transactions")
                                    const res = await respondToRepairRequest(r.id, "accepted")
                                    if (res?.success) toast.success("Repair request accepted")
                                    router.refresh()
                                  })
                                }}
                              >
                                Accept
                              </Button>
                            )}
                            {/* The end of the repair story — completeRepairAction
                                emits LISTING_REPAIR_COMPLETED so both portals see
                                the item close. Nothing used to call it, so an
                                approved repair stayed "approved" forever. */}
                            {(r.status === "approved" || r.status === "countered") && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-6 px-2"
                                disabled={isPending}
                                onClick={() => {
                                  startTransition(async () => {
                                    const res = await completeRepairAction({
                                      transactionId: transaction.id,
                                      brokerageId,
                                      repairId: r.id,
                                      actualCost: r.estimated_cost ?? undefined,
                                    })
                                    if (res.success) {
                                      toast.success("Repair marked complete")
                                      router.refresh()
                                    } else {
                                      toast.error(res.error ?? "Could not complete repair")
                                    }
                                  })
                                }}
                              >
                                Mark Complete
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !showRepairForm && <p className="text-sm text-muted-foreground">No repairs tracked.</p>
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
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      onClick={() => setShowAddCommission((v) => !v)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add Split
                    </Button>
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
                  </div>
                </CardHeader>
                <CardContent>
                  {showAddCommission && (
                    <div className="border rounded-lg p-3 space-y-3 bg-muted/30 mb-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Recipient Name</Label>
                          <input
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="Agent or brokerage name"
                            value={newCommRecipientName}
                            onChange={(e) => setNewCommRecipientName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Recipient Type</Label>
                          <select
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            value={newCommRecipientType}
                            onChange={(e) => setNewCommRecipientType(e.target.value)}
                          >
                            <option value="agent">Agent</option>
                            <option value="brokerage">Brokerage</option>
                            <option value="referral">Referral</option>
                            <option value="other">Other</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Commission Type</Label>
                          <select
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            value={newCommType}
                            onChange={(e) => setNewCommType(e.target.value)}
                          >
                            <option value="buyer_side">Buyer Side</option>
                            <option value="listing_side">Listing Side</option>
                            <option value="referral_fee">Referral Fee</option>
                            <option value="transaction_fee">Transaction Fee</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Rate (%)</Label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            className="w-full h-8 text-xs border rounded px-2 bg-background"
                            placeholder="e.g. 2.5"
                            value={newCommRate}
                            onChange={(e) => setNewCommRate(e.target.value)}
                          />
                        </div>
                      </div>
                      <Button
                        size="sm"
                        className="w-full text-xs h-7"
                        disabled={!newCommRecipientName || isPending}
                        onClick={() => {
                          if (!newCommRecipientName) return
                          startTransition(async () => {
                            const { addCommission } = await import("@/app/actions/transactions")
                            const result = await addCommission({
                              transaction_id: transaction.id,
                              recipient_name: newCommRecipientName,
                              recipient_type: newCommRecipientType,
                              commission_type: newCommType,
                              rate_percentage: newCommRate ? Number(newCommRate) : undefined,
                            })
                            if (result?.success) {
                              toast.success("Commission split added")
                              setShowAddCommission(false)
                              setNewCommRecipientName("")
                              setNewCommRate("")
                              router.refresh()
                            } else {
                              toast.error("Failed to add commission split")
                            }
                          })
                        }}
                      >
                        {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Save Commission Split
                      </Button>
                    </div>
                  )}
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
                          <div className="flex items-center gap-2">
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
                            {c.status !== "paid" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs h-6 px-2 shrink-0"
                                title="Mark as paid"
                                onClick={() => {
                                  startTransition(async () => {
                                    const { markCommissionPaid } = await import("@/app/actions/transactions")
                                    const result = await markCommissionPaid(c.id, new Date().toISOString().split("T")[0])
                                    if (result?.success) {
                                      toast.success("Commission marked paid")
                                      router.refresh()
                                    } else {
                                      toast.error(result?.error ?? "Failed to mark commission paid")
                                    }
                                  })
                                }}
                              >
                                Mark Paid
                              </Button>
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
                            {titleIssueSummary ? (
                              <span className="flex flex-wrap items-center gap-1">
                                {titleIssueSummary.critical.length > 0 && (
                                  <Badge variant="destructive" className="w-fit text-[10px] px-1.5 py-0">
                                    {titleIssueSummary.critical.length} critical
                                  </Badge>
                                )}
                                {titleIssueSummary.moderate.length > 0 && (
                                  <Badge variant="secondary" className="w-fit text-[10px] px-1.5 py-0">
                                    {titleIssueSummary.moderate.length} moderate
                                  </Badge>
                                )}
                                {titleIssueSummary.totalUnresolved === 0 && (
                                  <Badge variant="outline" className="w-fit text-[10px] px-1.5 py-0">
                                    all resolved
                                  </Badge>
                                )}
                              </span>
                            ) : (
                              <Badge variant="destructive" className="w-fit text-[10px] px-1.5 py-0">
                                {titleEscrow.title_issues}
                              </Badge>
                            )}
                          </>
                        )}
                        {titleEscrow.earnest_money_amount && (
                          <>
                            <span className="text-muted-foreground">Earnest $</span>
                            <span className="font-medium">${titleEscrow.earnest_money_amount.toLocaleString()}</span>
                          </>
                        )}
                      </div>
                      {/* The closing-blocking verdict the triage produces. An open
                          CRITICAL title issue stops a closing; nothing on this page
                          said so before. */}
                      {titleIssueSummary && !titleIssueSummary.canClose && (
                        <p className="text-[11px] text-destructive">
                          Cannot close — {titleIssueSummary.critical.length} critical title issue
                          {titleIssueSummary.critical.length === 1 ? "" : "s"} unresolved.
                        </p>
                      )}
                      {titleIssueSummary && titleIssueSummary.canClose && titleIssueSummary.totalUnresolved > 0 && (
                        <p className="text-[11px] text-amber-600">
                          {titleIssueSummary.totalUnresolved} unresolved title issue
                          {titleIssueSummary.totalUnresolved === 1 ? "" : "s"} — none closing-blocking.
                        </p>
                      )}
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
      <Dialog
        open={showBlockersModal}
        onOpenChange={(open) => {
          setShowBlockersModal(open)
          if (!open) {
            setShowOverridePanel(false)
            setOverrideReason("")
            setOverrideError(null)
          }
        }}
      >
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

          {/* Manual override — visible only to broker / admin / compliance.
              Server-side requireOverrideActor enforces the same gate; this is
              just UX. Override writes a full audit row with the reason. */}
          {canOverrideStage && !showOverridePanel && (
            <div className="border-t pt-3 mt-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full text-amber-700 border-amber-300 hover:bg-amber-50"
                onClick={() => setShowOverridePanel(true)}
              >
                <AlertTriangle className="h-4 w-4 mr-1.5" />
                Force advance with override
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Requires broker / admin / compliance role. Bypasses the blockers above and
                writes an audit row with your reason.
              </p>
            </div>
          )}

          {canOverrideStage && showOverridePanel && (
            <div className="border-t pt-3 mt-2 space-y-2">
              <Label htmlFor="override_reason" className="text-xs font-medium text-amber-700">
                Override reason (required, min 10 characters)
              </Label>
              <Textarea
                id="override_reason"
                placeholder="e.g. Lender confirmed CTC by phone — uploading the doc tomorrow"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={3}
                className="text-sm"
              />
              {overrideError && (
                <p className="text-xs text-red-600">{overrideError}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                This action is logged as <code className="text-[10px]">transaction.stage_overridden</code>
                {" "}with your user id + user_type for compliance audit.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBlockersModal(false)}>
              Close
            </Button>
            {canOverrideStage && showOverridePanel && (
              <Button
                onClick={handleForceAdvance}
                disabled={isPending || overrideReason.trim().length < 10}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {isPending ? "Overriding..." : "Force Advance"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Appraisal completion — the value is required, because the gap detector
          compares it to transactions.purchase_price. */}
      <Dialog open={appraisalDialogOpen} onOpenChange={setAppraisalDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record the appraisal</DialogTitle>
            <DialogDescription>
              The appraised value is compared to the contract price. If it comes in short, the
              buyer and seller portals get the explanation, the deal team is convened, and you get
              the three priced negotiation plays.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {appraisalError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {appraisalError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="appraisal-value">Appraised value</Label>
              <Input
                id="appraisal-value"
                type="number"
                min="0"
                placeholder="e.g. 495000"
                value={appraisalValue}
                onChange={(e) => setAppraisalValue(e.target.value)}
              />
              {transaction.purchase_price ? (
                <p className="text-xs text-muted-foreground">
                  Contract price on file: ${Number(transaction.purchase_price).toLocaleString()}
                </p>
              ) : (
                <p className="text-xs text-amber-600">
                  No contract price on this transaction — the gap check has nothing to compare
                  against and will not run.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppraisalDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitAppraisalComplete} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Record appraisal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Final walkthrough scheduling */}
      <Dialog open={walkthroughDialogOpen} onOpenChange={setWalkthroughDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule the final walkthrough</DialogTitle>
            <DialogDescription>
              Sets the milestone date and fans the walkthrough out to the buyer, seller, lender and
              title portals.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {walkthroughError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {walkthroughError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="walkthrough-date">Walkthrough date</Label>
              <Input
                id="walkthrough-date"
                type="date"
                value={walkthroughDate}
                onChange={(e) => setWalkthroughDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWalkthroughDialogOpen(false)}>Cancel</Button>
            <Button onClick={submitWalkthroughSchedule} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Milestone Override Dialog */}
      <Dialog
        open={!!milestoneOverrideName}
        onOpenChange={(open) => {
          if (!open) {
            setMilestoneOverrideName(null)
            setMilestoneOverrideReason("")
            setMilestoneOverrideError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5" />
              Override Milestone
            </DialogTitle>
            <DialogDescription>
              Override milestone{" "}
              <strong>{milestoneOverrideName?.replace(/_/g, " ")}</strong>. The action will be logged as{" "}
              <code className="text-[11px]">milestone.overridden</code> with your user id +
              user_type and the reason below — for compliance audit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="milestone_override_reason" className="text-xs font-medium text-amber-700">
              Override reason (required, min 10 characters)
            </Label>
            <Textarea
              id="milestone_override_reason"
              placeholder="e.g. Inspection performed on-site by buyer's contractor — formal report uploading by 5pm"
              value={milestoneOverrideReason}
              onChange={(e) => setMilestoneOverrideReason(e.target.value)}
              rows={3}
              className="text-sm"
            />
            {milestoneOverrideError && (
              <p className="text-xs text-red-600">{milestoneOverrideError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setMilestoneOverrideName(null)
                setMilestoneOverrideReason("")
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMilestoneOverride}
              disabled={isPending || milestoneOverrideReason.trim().length < 10}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {isPending ? "Overriding..." : "Override Milestone"}
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
