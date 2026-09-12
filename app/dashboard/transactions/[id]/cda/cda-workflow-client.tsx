"use client"

import { useState, useTransition, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ArrowLeft,
  FileText,
  DollarSign,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Shield,
  Send,
  ThumbsUp,
  Loader2,
  History,
} from "lucide-react"
// ONE CDA RAIL. This page used to call lib/transactions/cda-workflow.ts — a second
// implementation over the same closing_disclosure_agreement table with weaker gates
// (no signature check, no contract/split check, and it shipped the disbursement
// authorization to title the moment compliance approved, skipping the broker's
// signature). Its create path also inserted transaction.agent_id — an agents.id —
// into agent_id, which FKs users, so "Generate CDA Preview" threw on every click.
// Repointed to app/actions/cda-portal.ts, the rail the compliance review panel
// already uses; the duplicate file is deleted.
import {
  draftOrUpdateCdaAction,
  submitCdaForApprovalAction,
  approveCdaAction,
  uploadPreliminaryCdAction,
  // THE TAIL OF THE MONEY RAIL. These four were complete, tenant-scoped and had no
  // caller anywhere: the final CD coming back from title (which is also one of the two
  // events that FINALIZES the transaction's commission), the copy of the commission
  // check, closing the CDA file, and — for a brokerage that doesn't do CDAs at all —
  // the agent's payout preference. getCdaForTransactionAction is the only reader of
  // closing_disclosure_agreement_revisions, the audit log every state change writes.
  recordCdaClosingArtifactAction,
  closeCdaAction,
  recordNonCdaPayoutPreferenceAction,
  getCdaForTransactionAction,
} from "@/app/actions/cda-portal"
import { CdaTemplateFieldsCard } from "./cda-template-fields-card"
// agents.id → users.id. transactions.agent_id is an agents FK;
// notifications.user_id is a users FK. Resolve, never substitute.
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"

interface CDAWorkflowClientProps {
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
    commission_percentage: number | null
    deal_type: string | null
    created_at: string
    updated_at: string
  }
  brokerageId: string
  userType: string
  userId: string
  cda: {
    id: string
    transaction_id: string
    status: string
    gross_commission: number | null
    agent_net: number | null
    brokerage_net: number | null
    calculation_version: string | null
    agent_submitted_at: string | null
    agent_submitted_by: string | null
    compliance_approved_at: string | null
    compliance_approved_by: string | null
    notes: string | null
    created_at: string
    preliminary_cd_uploaded_at: string | null
    preliminary_cd_document_id: string | null
    broker_approved_at: string | null
    sent_to_title_at: string | null
    sent_to_title_recipient: string | null
    sent_to_title_method: string | null
    final_cd_document_id: string | null
    final_cd_uploaded_at: string | null
    check_copy_document_id: string | null
    check_copy_uploaded_at: string | null
    closed_at: string | null
    uses_cda: boolean | null
    non_cda_payout_method: string | null
  } | null
  /** brokerages.offers_cda — false routes the agent to the payout-preference path. */
  offersCda: boolean
  agent: {
    id: string
    user_id: string
    commission_split: number | null
  } | null
  /**
   * Cap progress from `agent_cap_tracking` — the ledger the commission engine
   * reads — for the anniversary window containing today. BOTH figures are
   * dollars, which is what this card always claimed to show and never did: it
   * used to render `agents.cap_progress`, a 0-100 percentage, through
   * formatCurrency. `null` = this agent has no cap window (correctly uncapped),
   * or the read was refused — see `capUnavailable`, which tells the two apart.
   */
  agentCap: {
    capAmount: number | null
    capPaidToDate: number | null
    isCapped: boolean
  } | null
  /** True when the cap ledger read was REFUSED. "Unknown" is not "$0". */
  capUnavailable: boolean
  commissionCalc: {
    id: string
    gross_commission: number | null
    net_to_agent: number | null
    net_to_brokerage: number | null
    breakdown_json: Record<string, unknown> | null
    calculated_at: string
  } | null
  complianceChecks: Array<{
    id: string
    check_type: string
    check_label: string
    status: string
    is_blocking: boolean
    failure_reason: string | null
  }>
  cdaTimeline: Array<{
    id: string
    activity_type: string
    description: string
    created_at: string
    performed_by: string | null
  }>
}

export function CDAWorkflowClient({
  transaction,
  brokerageId,
  userType,
  userId,
  cda,
  offersCda,
  agent,
  agentCap,
  capUnavailable,
  commissionCalc,
  complianceChecks,
  cdaTimeline,
}: CDAWorkflowClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [distributions, setDistributions] = useState<Array<{
    id: string
    distribution_type: string
    calculation_type: string
    calculation_value: number | null
    calculated_amount: number | null
    source_of_funds: string | null
    cap_applied: boolean | null
    status: string
    paid_at: string | null
  }>>([])
  const [markingPaid, setMarkingPaid] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("commission_distributions")
      .select("id, distribution_type, calculation_type, calculation_value, calculated_amount, source_of_funds, cap_applied, status, paid_at")
      .eq("transaction_id", transaction.id)
      .then(({ data }: { data: any }) => {
        if (data) setDistributions(data)
      })
  }, [transaction.id])

  // STEP 1 OF THE CDA CHAIN — the preliminary HUD / settlement statement arriving
  // from the title company or the closing attorney. uploadPreliminaryCdAction and
  // notifyAgentOfPreliminaryCdAction were both complete and had NO caller anywhere,
  // so the chain had no beginning: nothing told the agent the HUD was in, no task
  // was created, and the CD_RECEIVED kernel event never fanned out.
  const [uploadingPrelim, setUploadingPrelim] = useState(false)
  const [prelimError, setPrelimError] = useState<string | null>(null)
  const [prelimRole, setPrelimRole] = useState<"title_agent" | "closing_attorney" | "tc">("title_agent")

  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [showSubmitDialog, setShowSubmitDialog] = useState(false)
  const [showApproveDialog, setShowApproveDialog] = useState(false)
  const [notes, setNotes] = useState("")
  // Blockers from the final-compliance gate (submit) or the authority gate (approve).
  const [gateError, setGateError] = useState<string[] | null>(null)

  const isAgent = userType === "agent" || transaction.agent_id === userId
  const isCompliance = ["broker", "admin", "compliance_officer"].includes(userType)

  // Check if there are blocking compliance failures
  // Normalized status values: pending, pass, fail, waived, needs_review
  const blockingFailures = complianceChecks.filter(
    c => c.is_blocking && c.status === "fail"
  )
  const pendingBlockingChecks = complianceChecks.filter(
    c => c.is_blocking && (c.status === "pending" || c.status === "needs_review")
  )
  const hasComplianceBlockers = blockingFailures.length > 0 || pendingBlockingChecks.length > 0

  // CDA status
  const cdaStatus = cda?.status ?? "not_started"
  const canGeneratePreview = !cda
  // THE SEVERED MIDDLE. This read `cdaStatus === "pending"` — but the moment the agent
  // opens the CDA for drafting, draftOrUpdateCdaAction moves the row pending → DRAFTING,
  // and compliance sending it back moves it changes_requested → drafting on the next
  // edit. So the "Submit CDA for Approval" button vanished the instant the agent started
  // work and never came back: the agent could draft a disbursement and had no way to
  // submit it. The set below is exactly the set submitCdaForApprovalAction itself accepts.
  const SUBMITTABLE = ["pending", "drafting", "changes_requested"]
  const canSubmit = !!cda && SUBMITTABLE.includes(cdaStatus) && isAgent
  const canApprove = cda && cdaStatus === "submitted" && isCompliance

  // ─── POST-CLOSE / NON-CDA STATE ────────────────────────────────────────────
  const [artifactBusy, setArtifactBusy] = useState<"final_cd" | "check_copy" | null>(null)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [closingCda, setClosingCda] = useState(false)
  const [payoutMethod, setPayoutMethod] = useState<"direct_deposit" | "check">("direct_deposit")
  const [payoutSaving, setPayoutSaving] = useState(false)
  const [payoutError, setPayoutError] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<Array<{
    id: string
    revision_number: number
    action: string
    status_at_snapshot: string
    /** Money snapshot at this state change (free-form split map from the draft
        form). The audit trail without it recorded who acted but not the numbers. */
    commission_breakdown: Record<string, unknown> | null
    notes: string | null
    changes_requested_notes: string | null
    acted_at: string
  }>>([])

  // The revision log is written on every state change of this money instruction and
  // getCdaForTransactionAction is its only reader — an audit trail nobody can see.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await getCdaForTransactionAction(transaction.id)
      if (!cancelled && res.success && res.revisions) setRevisions(res.revisions as typeof revisions)
    })()
    return () => { cancelled = true }
  }, [transaction.id, cda?.status, cda?.closed_at])

  /** Upload a post-close artifact to storage, then record + attach it to the CDA. */
  async function handleArtifactUpload(
    kind: "final_cd" | "check_copy",
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0]
    if (!file || !cda) return
    setArtifactError(null)
    setArtifactBusy(kind)
    try {
      const supabase = createClient()
      const path = `transactions/${transaction.id}/${kind}/${Date.now()}_${file.name}`
      // Store and sign as ONE step — the previous shape returned after the bytes
      // were already in the bucket whenever the signer failed, leaving a final CD
      // or a commission-check copy behind with no CDA artifact row.
      const { putAndSign, removeOrRecordOrphan } = await import("@/lib/storage/put-and-sign")
      const stored = await putAndSign(supabase, {
        bucket:      "transaction-documents",
        path,
        body:        file,
        contentType: file.type || undefined,
        reason:      `cda_${kind}_upload`,
      })
      if (!stored.ok) {
        setArtifactError(`Upload failed: ${stored.error}`)
        return
      }
      const res = await recordCdaClosingArtifactAction({
        cdaId: cda.id,
        kind,
        fileName: file.name,
        fileUrl: stored.signedUrl,
      })
      if (!res?.success) {
        // The action refused; nothing references the file. Undo the upload.
        await removeOrRecordOrphan(supabase, {
          bucket:     "transaction-documents",
          objectPath: stored.path,
          reason:     `cda_${kind}_record_refused`,
          detail:     ("error" in res && res.error) || "the CDA artifact record was refused",
        })
        setArtifactError(("error" in res && res.error) || "Could not record the document.")
        return
      }
      router.refresh()
    } catch {
      setArtifactError("Upload failed — please try again.")
    } finally {
      setArtifactBusy(null)
      e.target.value = ""
    }
  }

  function handleCloseCda() {
    if (!cda) return
    setArtifactError(null)
    setClosingCda(true)
    startTransition(async () => {
      const res = await closeCdaAction({ cdaId: cda.id })
      setClosingCda(false)
      if (!res?.success) {
        setArtifactError(("error" in res && res.error) || "Could not close the CDA.")
        return
      }
      router.refresh()
    })
  }

  function handleSavePayoutPreference() {
    setPayoutError(null)
    setPayoutSaving(true)
    startTransition(async () => {
      const res = await recordNonCdaPayoutPreferenceAction({
        transactionId: transaction.id,
        method: payoutMethod,
      })
      setPayoutSaving(false)
      if (!res?.success) {
        setPayoutError(("error" in res && res.error) || "Could not save your payout preference.")
        return
      }
      router.refresh()
    })
  }

  async function handlePreliminaryCdUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPrelimError(null)
    setUploadingPrelim(true)
    try {
      const supabase = createClient()
      const path = `transactions/${transaction.id}/preliminary-cd/${Date.now()}_${file.name}`
      // Store and sign as ONE step — same defect as the artifact upload above.
      const { putAndSign, removeOrRecordOrphan } = await import("@/lib/storage/put-and-sign")
      const stored = await putAndSign(supabase, {
        bucket:      "transaction-documents",
        path,
        body:        file,
        contentType: file.type || undefined,
        reason:      "preliminary_cd_upload",
      })
      if (!stored.ok) {
        setPrelimError(`Upload failed: ${stored.error}`)
        return
      }
      const res = await uploadPreliminaryCdAction({
        transactionId:  transaction.id,
        fileName:       file.name,
        fileUrl:        stored.signedUrl,
        uploadedByRole: prelimRole,
      })
      if (!res?.success) {
        // The action refused; nothing references the file. Undo the upload.
        await removeOrRecordOrphan(supabase, {
          bucket:     "transaction-documents",
          objectPath: stored.path,
          reason:     "preliminary_cd_record_refused",
          detail:     res?.error ?? "the preliminary CD record was refused",
        })
        setPrelimError(res?.error ?? "Could not record the preliminary CD.")
        return
      }
      router.refresh()
    } catch {
      setPrelimError("Upload failed — please try again.")
    } finally {
      setUploadingPrelim(false)
      e.target.value = ""
    }
  }

  function handleGeneratePreview() {
    startTransition(async () => {
      try {
        // Opens the CDA for drafting. The money is NOT auto-filled — the agent
        // types it into the brokerage's own template below and the computed
        // waterfall is kept as the `expected` baseline the audit compares against.
        const res = await draftOrUpdateCdaAction({
          transactionId: transaction.id,
          commissionBreakdown: {},
        })
        if (!res?.success) {
          setGateError([res?.error ?? "Could not open the CDA for drafting."])
          return
        }
        setShowGenerateDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Open draft failed:", error)
        setGateError(["Could not open the CDA for drafting — please try again."])
      }
    })
  }

  function handleSubmitCDA() {
    if (!cda) return
    setGateError(null)
    startTransition(async () => {
      try {
        const res = await submitCdaForApprovalAction({ cdaId: cda.id })
        if (!res?.success) {
          // Full document compliance runs BEFORE the CDA can be accepted. When it
          // refuses, name what is missing rather than showing a bare failure.
          const blockers = (res as { blockers?: string[] })?.blockers
          setGateError(
            blockers?.length
              ? blockers
              : [res?.error ?? "Submission was blocked by the final compliance check."],
          )
          return
        }
        setShowSubmitDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Submit failed:", error)
        setGateError(["Submission failed — please try again."])
      }
    })
  }

  function handleApproveCDA() {
    if (!cda) return
    setGateError(null)
    startTransition(async () => {
      try {
        const res = await approveCdaAction({ cdaId: cda.id })
        if (!res?.success) {
          setGateError([res?.error ?? "Approval was not allowed."])
          return
        }
        setShowApproveDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Approve failed:", error)
        setGateError(["Approval failed — please try again."])
      }
    })
  }

  function getStatusBadge(status: string) {
    // "drafting" and "changes_requested" are both real values of the live status CHECK
    // and both were rendered as "Not Started" — a CDA the agent was actively working on,
    // or one compliance had sent back, looked like nothing had happened.
    if (cda?.closed_at) return <Badge className="bg-slate-600"><CheckCircle2 className="h-3 w-3 mr-1" />Closed</Badge>
    if (status === "approved" && cda?.sent_to_title_at) {
      return <Badge className="bg-emerald-600"><Send className="h-3 w-3 mr-1" />Delivered to closing agent</Badge>
    }
    switch (status) {
      case "approved":
        return <Badge className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" />Approved</Badge>
      case "submitted":
        return <Badge className="bg-blue-500"><Send className="h-3 w-3 mr-1" />Submitted</Badge>
      case "changes_requested":
        return <Badge className="bg-amber-500"><AlertTriangle className="h-3 w-3 mr-1" />Changes requested</Badge>
      case "drafting":
        return <Badge variant="secondary"><FileText className="h-3 w-3 mr-1" />Drafting</Badge>
      case "pending":
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
      default:
        return <Badge variant="outline">Not Started</Badge>
    }
  }

  function formatCurrency(amount: number | null | undefined) {
    if (amount === null || amount === undefined) return "N/A"
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(amount)
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Compliance Blocker Alert */}
      {hasComplianceBlockers && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Compliance Issues Detected</AlertTitle>
          <AlertDescription>
            {blockingFailures.length > 0 && (
              <span>{blockingFailures.length} blocking compliance check(s) have failed. </span>
            )}
            {pendingBlockingChecks.length > 0 && (
              <span>{pendingBlockingChecks.length} blocking check(s) are still pending. </span>
            )}
            CDA cannot be approved until all blocking issues are resolved.
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="border-b bg-card">
        <div className="container py-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/dashboard/transactions/${transaction.id}`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex-1">
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <FileText className="h-5 w-5" />
                CDA Workflow
              </h1>
              <p className="text-sm text-muted-foreground">
                {transaction.property_address}
              </p>
            </div>
            {getStatusBadge(cdaStatus)}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container py-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Commission Preview */}
          <div className="lg:col-span-2 space-y-6">
            {/* STEP 1 — the preliminary HUD from title / the closing attorney. This is
                what starts the CDA: it notifies the agent, opens a "Draft and submit
                CDA" task, and fans out CD_RECEIVED. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Preliminary closing statement (HUD)
                </CardTitle>
                <CardDescription>
                  The CDA starts when title or the closing attorney sends the preliminary
                  settlement statement. Recording it here notifies the agent and the
                  transaction coordinator and opens the CDA for drafting.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {cda?.preliminary_cd_uploaded_at ? (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Preliminary CD received</AlertTitle>
                    <AlertDescription>
                      Recorded {new Date(cda.preliminary_cd_uploaded_at).toLocaleString()}. The
                      agent has been notified to draft the CDA.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="text-sm">
                        <span className="block text-xs font-medium mb-1">Sent by</span>
                        <select
                          className="w-full border rounded px-2 py-1.5 text-sm"
                          value={prelimRole}
                          onChange={(e) => setPrelimRole(e.target.value as typeof prelimRole)}
                          disabled={uploadingPrelim}
                        >
                          <option value="title_agent">Title company</option>
                          <option value="closing_attorney">Closing attorney</option>
                          <option value="tc">Transaction coordinator</option>
                        </select>
                      </label>
                      <label className="text-sm">
                        <span className="block text-xs font-medium mb-1">Statement file</span>
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          className="w-full text-sm"
                          onChange={handlePreliminaryCdUpload}
                          disabled={uploadingPrelim}
                        />
                      </label>
                    </div>
                    {uploadingPrelim && (
                      <p className="text-xs text-muted-foreground flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" /> Recording and notifying the agent…
                      </p>
                    )}
                    {prelimError && <p className="text-xs text-red-600">{prelimError}</p>}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Commission Summary Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Commission Preview
                </CardTitle>
                <CardDescription>
                  Commission calculation based on current transaction details
                </CardDescription>
              </CardHeader>
              <CardContent>
                {cda || commissionCalc ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                      <div className="text-center p-4 bg-muted/50 rounded-lg">
                        <p className="text-sm text-muted-foreground mb-1">Gross Commission</p>
                        <p className="text-2xl font-bold">
                          {formatCurrency(cda?.gross_commission ?? commissionCalc?.gross_commission)}
                        </p>
                      </div>
                      <div className="text-center p-4 bg-green-50 rounded-lg border border-green-200">
                        <p className="text-sm text-muted-foreground mb-1">Agent Net</p>
                        <p className="text-2xl font-bold text-green-600">
                          {formatCurrency(cda?.agent_net ?? commissionCalc?.net_to_agent)}
                        </p>
                      </div>
                      <div className="text-center p-4 bg-blue-50 rounded-lg border border-blue-200">
                        <p className="text-sm text-muted-foreground mb-1">Brokerage Net</p>
                        <p className="text-2xl font-bold text-blue-600">
                          {formatCurrency(cda?.brokerage_net ?? commissionCalc?.net_to_brokerage)}
                        </p>
                      </div>
                    </div>

                    <Separator />

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Purchase Price</p>
                        <p className="font-medium">{formatCurrency(transaction.purchase_price)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Commission Rate</p>
                        <p className="font-medium">{transaction.commission_percentage ?? "N/A"}%</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Agent Split</p>
                        <p className="font-medium">{agent?.commission_split ?? "N/A"}%</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Cap Progress</p>
                        {/*
                          Dollars over dollars, from agent_cap_tracking. Each of
                          the three states below is a DIFFERENT fact and they used
                          to be one indistinguishable "$0.00 / $0.00":
                          refused read, no cap, and a real cap at zero progress.
                        */}
                        {capUnavailable ? (
                          <p className="font-medium text-muted-foreground">
                            Unavailable — the cap ledger could not be read
                          </p>
                        ) : agentCap?.capAmount == null ? (
                          <p className="font-medium text-muted-foreground">
                            No cap — the brokerage collects its full split on this deal
                          </p>
                        ) : (
                          <p className="font-medium">
                            {formatCurrency(agentCap.capPaidToDate ?? 0)} / {formatCurrency(agentCap.capAmount)}
                            {agentCap.isCapped ? " · capped" : ""}
                          </p>
                        )}
                      </div>
                    </div>

                    {cda?.calculation_version && (
                      <p className="text-xs text-muted-foreground">
                        Calculation version: {cda.calculation_version}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-4">
                      No CDA preview has been generated yet
                    </p>
                    <Button onClick={() => setShowGenerateDialog(true)} disabled={isPending}>
                      {isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FileText className="h-4 w-4 mr-2" />
                      )}
                      Generate CDA Preview
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* The brokerage's OWN CDA form — auto-filled from the waterfall. Renders
                only when the brokerage configured template-field bindings. */}
            {cda?.id && <CdaTemplateFieldsCard cdaId={cda.id} />}

            {/* Commission Breakdown */}
            {distributions.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <DollarSign className="h-5 w-5" />
                      Commission Breakdown
                    </CardTitle>
                    {isCompliance && distributions.some(d => d.distribution_type === "agent" && d.status === "pending") && (
                      <Button
                        size="sm"
                        disabled={markingPaid || isPending}
                        onClick={async () => {
                          setMarkingPaid(true)
                          const supabase = createClient()
                          const { error } = await supabase
                            .from("commission_distributions")
                            .update({ status: "paid", paid_at: new Date().toISOString() })
                            .eq("transaction_id", transaction.id)
                            .eq("distribution_type", "agent")
                          if (!error) {
                            setDistributions(prev =>
                              prev.map(d =>
                                d.distribution_type === "agent"
                                  ? { ...d, status: "paid", paid_at: new Date().toISOString() }
                                  : d
                              )
                            )
                            // Create agent notification.
                            //
                            // `transactions.agent_id` is `REFERENCES agents(id)`
                            // (measured on the live schema) and
                            // `notifications.user_id` is `REFERENCES users(id)` —
                            // DISJOINT spaces, so the id is RESOLVED across, never
                            // reused. Before this, Postgres refused every one of
                            // these rows 23503 and the `.catch(() => {})` never
                            // fired, because supabase-js RESOLVES a refused query:
                            // no agent has ever been told their commission was
                            // disbursed. The tenant was already correct, which is
                            // why the tenant census did not surface it — this
                            // wave's C7 id-space assertion did.
                            const paidRecipient = await resolveAgentRecipient(
                              supabase,
                              transaction.agent_id,
                            )
                            if (!paidRecipient.ok || !paidRecipient.userId) {
                              console.error(
                                "[cda-workflow] commission_paid notification NOT written:",
                                paidRecipient.ok
                                  ? `agents.id ${transaction.agent_id} has no user account`
                                  : paidRecipient.reason,
                              )
                            } else {
                              const { error: paidNotifyError } = await supabase.from("notifications").insert({
                                user_id: paidRecipient.userId,
                                brokerage_id: transaction.brokerage_id,
                                type: "commission_paid",
                                title: "Your commission has been disbursed",
                                body: `Your commission for ${transaction.property_address} has been marked as paid.`,
                                entity_type: "transaction",
                                entity_id: transaction.id,
                                is_read: false,
                              })
                              if (paidNotifyError) {
                                console.error("[cda-workflow] commission_paid notification insert refused:", paidNotifyError.message)
                              }
                            }
                            router.refresh()
                          }
                          setMarkingPaid(false)
                        }}
                      >
                        {markingPaid ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                        Mark Agent Paid
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipient</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {distributions.map(dist => (
                        <TableRow key={dist.id}>
                          <TableCell className="font-medium capitalize">
                            {dist.distribution_type === "agent" ? "Agent" :
                             dist.distribution_type === "brokerage" ? "Brokerage" :
                             dist.distribution_type === "fee" ? "Transaction Fee" :
                             dist.distribution_type}
                            {dist.cap_applied && (
                              <Badge className="ml-2 text-xs bg-amber-100 text-amber-800 border-amber-200">Capped</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {dist.calculation_type === "percent"
                              ? `${dist.calculation_value ?? 0}%`
                              : "Flat"}
                          </TableCell>
                          <TableCell className="font-semibold">
                            {formatCurrency(dist.calculated_amount)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm capitalize">
                            {dist.source_of_funds ?? "—"}
                          </TableCell>
                          <TableCell>
                            {dist.status === "paid" ? (
                              <Badge className="bg-green-100 text-green-800 border-green-200">
                                <CheckCircle2 className="h-3 w-3 mr-1" />Paid
                              </Badge>
                            ) : dist.status === "pending" ? (
                              <Badge variant="secondary">
                                <Clock className="h-3 w-3 mr-1" />Pending
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="capitalize">{dist.status}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Separator className="my-3" />
                  <div className="flex justify-between text-sm font-semibold px-1">
                    <span>Total</span>
                    <span>
                      {formatCurrency(
                        distributions.reduce((sum, d) => sum + (d.calculated_amount ?? 0), 0)
                      )}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Compliance Checks Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  Compliance Status
                </CardTitle>
                <CardDescription>
                  All blocking checks must pass before CDA approval
                </CardDescription>
              </CardHeader>
              <CardContent>
                {complianceChecks.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">
                    No compliance checks found for this transaction
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Check</TableHead>
                        <TableHead>Blocking</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {complianceChecks.map(check => (
                        <TableRow key={check.id}>
                          <TableCell>
                            <div className="font-medium">{check.check_label}</div>
                            {check.failure_reason && (
                              <div className="text-xs text-red-600">{check.failure_reason}</div>
                            )}
                          </TableCell>
                          <TableCell>
                            {check.is_blocking ? (
                              <Badge variant="destructive">Yes</Badge>
                            ) : (
                              <Badge variant="secondary">No</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {check.status === "pass" && (
                              <span className="text-green-600 flex items-center gap-1">
                                <CheckCircle2 className="h-4 w-4" /> Passed
                              </span>
                            )}
                            {check.status === "fail" && (
                              <span className="text-red-600 flex items-center gap-1">
                                <XCircle className="h-4 w-4" /> Failed
                              </span>
                            )}
                            {check.status === "pending" && (
                              <span className="text-amber-600 flex items-center gap-1">
                                <Clock className="h-4 w-4" /> Pending
                              </span>
                            )}
                            {check.status === "needs_review" && (
                              <span className="text-orange-600 flex items-center gap-1">
                                <AlertTriangle className="h-4 w-4" /> Needs Review
                              </span>
                            )}
                            {check.status === "waived" && (
                              <span className="text-muted-foreground flex items-center gap-1">
                                <Shield className="h-4 w-4" /> Waived
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            {/* ── NON-CDA PATH ──────────────────────────────────────────────
                Some brokerages don't issue CDAs at all: the brokerage collects the
                whole commission at closing and disburses to the agent afterwards.
                recordNonCdaPayoutPreferenceAction stores how the agent wants to be
                paid, and had no surface — the agent had nowhere to say it. */}
            {!offersCda && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5" />
                    How should the brokerage pay you?
                  </CardTitle>
                  <CardDescription>
                    Your brokerage doesn&apos;t issue a CDA at closing — it collects the commission
                    and disburses to you once funds clear. Record how you want that payment made.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {cda?.non_cda_payout_method ? (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Payout preference recorded</AlertTitle>
                      <AlertDescription>
                        {cda.non_cda_payout_method === "direct_deposit" ? "Direct deposit" : "Check"}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                      <span className="block text-xs font-medium mb-1">Payment method</span>
                      <select
                        className="border rounded px-2 py-1.5 text-sm"
                        value={payoutMethod}
                        onChange={(e) => setPayoutMethod(e.target.value as typeof payoutMethod)}
                        disabled={payoutSaving}
                      >
                        <option value="direct_deposit">Direct deposit</option>
                        <option value="check">Check</option>
                      </select>
                    </label>
                    <Button size="sm" onClick={handleSavePayoutPreference} disabled={payoutSaving || isPending}>
                      {payoutSaving && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                      Save payout preference
                    </Button>
                  </div>
                  {payoutError && <p className="text-xs text-red-600">{payoutError}</p>}
                </CardContent>
              </Card>
            )}

            {/* ── THE TAIL OF THE CHAIN ─────────────────────────────────────
                Delivery record → final CD back from title → copy of the commission
                check → close the file. Every one of these actions existed and none of
                them had a surface, so the money rail simply stopped after the send. */}
            {cda && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Send className="h-5 w-5" />
                    Closing record &amp; post-close file
                  </CardTitle>
                  <CardDescription>
                    The record of the send to the closing agent, and the documents that come
                    back from the closing table.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* RECORD OF THE SEND */}
                  {cda.sent_to_title_at ? (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Sent to the closing agent</AlertTitle>
                      <AlertDescription>
                        {new Date(cda.sent_to_title_at).toLocaleString()}
                        {cda.sent_to_title_recipient ? ` — ${cda.sent_to_title_recipient}` : ""}
                        {cda.sent_to_title_method ? ` (${cda.sent_to_title_method})` : ""}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert>
                      <Clock className="h-4 w-4" />
                      <AlertTitle>Not yet delivered</AlertTitle>
                      <AlertDescription>
                        {cda.broker_approved_at
                          ? "The broker has signed. Compliance sends the signed CDA to the closing agent from the CDA approval queue."
                          : "The CDA goes to the closing agent after compliance approves it and the broker signs it."}
                      </AlertDescription>
                    </Alert>
                  )}

                  <Separator />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Final Closing Disclosure</p>
                      {cda.final_cd_uploaded_at ? (
                        <p className="text-xs text-green-700 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          On file {new Date(cda.final_cd_uploaded_at).toLocaleDateString()}
                        </p>
                      ) : (
                        <>
                          <input
                            type="file"
                            accept="application/pdf,image/*"
                            className="w-full text-sm"
                            onChange={(e) => handleArtifactUpload("final_cd", e)}
                            disabled={artifactBusy !== null}
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Uploading the final CD finalizes this transaction&apos;s commission.
                          </p>
                        </>
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Copy of the commission check</p>
                      {cda.check_copy_uploaded_at ? (
                        <p className="text-xs text-green-700 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          On file {new Date(cda.check_copy_uploaded_at).toLocaleDateString()}
                        </p>
                      ) : (
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          className="w-full text-sm"
                          onChange={(e) => handleArtifactUpload("check_copy", e)}
                          disabled={artifactBusy !== null}
                        />
                      )}
                    </div>
                  </div>

                  {artifactBusy && (
                    <p className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" /> Recording the document…
                    </p>
                  )}
                  {artifactError && <p className="text-xs text-red-600">{artifactError}</p>}

                  {isCompliance && (
                    <div className="pt-1">
                      {cda.closed_at ? (
                        <p className="text-xs text-muted-foreground">
                          CDA file closed {new Date(cda.closed_at).toLocaleString()}.
                        </p>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCloseCda}
                          disabled={closingCda || isPending || !cda.sent_to_title_at}
                        >
                          {closingCda && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
                          Close CDA file
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Column: Actions & Timeline */}
          <div className="space-y-6">
            {/* Actions Card */}
            <Card>
              <CardHeader>
                <CardTitle>Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {canGeneratePreview && (
                  <Button 
                    className="w-full" 
                    onClick={() => setShowGenerateDialog(true)}
                    disabled={isPending}
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Generate CDA Preview
                  </Button>
                )}

                {canSubmit && (
                  <Button 
                    className="w-full" 
                    onClick={() => setShowSubmitDialog(true)}
                    disabled={isPending}
                  >
                    <Send className="h-4 w-4 mr-2" />
                    Submit CDA for Approval
                  </Button>
                )}

                {canApprove && (
                  <Button 
                    className="w-full" 
                    onClick={() => setShowApproveDialog(true)}
                    disabled={isPending || hasComplianceBlockers}
                  >
                    <ThumbsUp className="h-4 w-4 mr-2" />
                    Approve CDA
                  </Button>
                )}

                {cdaStatus === "approved" && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                    <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
                    <p className="font-medium text-green-800">CDA Approved</p>
                    <p className="text-sm text-green-600">
                      Approved on {new Date(cda!.compliance_approved_at!).toLocaleDateString()}
                    </p>
                  </div>
                )}

                {cdaStatus === "submitted" && !isCompliance && (
                  <Alert>
                    <Clock className="h-4 w-4" />
                    <AlertDescription>
                      CDA submitted and awaiting compliance approval
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* Timeline Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5" />
                  CDA Timeline
                </CardTitle>
              </CardHeader>
              <CardContent>
                {cdaTimeline.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4 text-sm">
                    No CDA activity yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {cdaTimeline.map(entry => (
                      <div key={entry.id} className="flex gap-3 text-sm">
                        <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                        <div>
                          <p>{entry.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(entry.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* CDA AUDIT TRAIL. Every state change of this disbursement instruction
                writes a row to closing_disclosure_agreement_revisions, and until now
                nothing anywhere read them back. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  CDA record &amp; audit trail
                </CardTitle>
                <CardDescription>Every state change, who made it and when</CardDescription>
              </CardHeader>
              <CardContent>
                {revisions.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4 text-sm">
                    No recorded CDA revisions yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {revisions.map(r => (
                      <div key={r.id} className="flex gap-3 text-sm">
                        <div className="w-2 h-2 rounded-full bg-muted-foreground mt-1.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="capitalize">
                            {r.action.replace(/_/g, " ")}
                            <span className="text-muted-foreground"> · rev {r.revision_number} · {r.status_at_snapshot}</span>
                          </p>
                          {(r.changes_requested_notes || r.notes) && (
                            <p className="text-xs text-muted-foreground italic break-words">
                              {r.changes_requested_notes || r.notes}
                            </p>
                          )}
                          {r.commission_breakdown && Object.keys(r.commission_breakdown).length > 0 && (
                            <p className="text-xs text-muted-foreground break-words">
                              {Object.entries(r.commission_breakdown)
                                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                                .slice(0, 6)
                                .map(([k, v]) => {
                                  const n = typeof v === "number" ? v : Number(v)
                                  const shown = Number.isFinite(n) && String(v).trim() !== "" && !isNaN(n)
                                    ? `$${n.toLocaleString()}`
                                    : String(v)
                                  return `${k.replace(/_/g, " ")}: ${shown}`
                                })
                                .join(" · ")}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {new Date(r.acted_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Generate Dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate CDA Preview</DialogTitle>
            <DialogDescription>
              This will run the commission engine and generate a CDA preview for review.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              The preview will include:
            </p>
            <ul className="list-disc list-inside text-sm text-muted-foreground mt-2 space-y-1">
              <li>Gross commission calculation</li>
              <li>Agent and brokerage splits</li>
              <li>Cap tracking</li>
              <li>Fee deductions</li>
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleGeneratePreview} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate Preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Submit Dialog */}
      <Dialog open={showSubmitDialog} onOpenChange={setShowSubmitDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit CDA for Approval</DialogTitle>
            <DialogDescription>
              Once submitted, the CDA will be reviewed by compliance.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {gateError && gateError.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-sm font-medium text-destructive">Can&apos;t submit yet — final compliance check:</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-destructive/90">
                  {gateError.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}
            <div className="space-y-2">
              <Label>Agent Net Amount</Label>
              <p className="text-2xl font-bold text-green-600">
                {formatCurrency(cda?.agent_net)}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="submit-notes">Notes (optional)</Label>
              <Textarea
                id="submit-notes"
                placeholder="Add any notes for compliance..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSubmitDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmitCDA} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit for Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve Dialog */}
      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve CDA</DialogTitle>
            <DialogDescription>
              Confirm that you have reviewed the commission breakdown and compliance status.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {gateError && gateError.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <ul className="list-disc pl-5 text-sm text-destructive/90">
                  {gateError.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <p className="text-sm text-muted-foreground">Agent Net</p>
                <p className="text-lg font-bold text-green-600">
                  {formatCurrency(cda?.agent_net)}
                </p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <p className="text-sm text-muted-foreground">Brokerage Net</p>
                <p className="text-lg font-bold text-blue-600">
                  {formatCurrency(cda?.brokerage_net)}
                </p>
              </div>
            </div>

            {hasComplianceBlockers && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Cannot approve: There are unresolved compliance issues.
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApproveDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleApproveCDA} 
              disabled={isPending || hasComplianceBlockers}
            >
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Approve CDA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
