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
import { generateCDAPreview, submitCDA, approveCDA } from "@/lib/transactions/cda-workflow"

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
  } | null
  agent: {
    id: string
    user_id: string
    commission_split: number | null
    cap_amount: number | null
    cap_progress: number | null
  } | null
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
  agent,
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

  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [showSubmitDialog, setShowSubmitDialog] = useState(false)
  const [showApproveDialog, setShowApproveDialog] = useState(false)
  const [notes, setNotes] = useState("")

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
  const canSubmit = cda && cdaStatus === "pending" && isAgent
  const canApprove = cda && cdaStatus === "submitted" && isCompliance

  function handleGeneratePreview() {
    startTransition(async () => {
      try {
        await generateCDAPreview({
          transactionId: transaction.id,
          brokerageId,
          agentId: transaction.agent_id,
        })
        setShowGenerateDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Generate preview failed:", error)
      }
    })
  }

  function handleSubmitCDA() {
    if (!cda) return
    startTransition(async () => {
      try {
        await submitCDA(cda.id, userId)
        setShowSubmitDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Submit failed:", error)
      }
    })
  }

  function handleApproveCDA() {
    if (!cda) return
    startTransition(async () => {
      try {
        await approveCDA({
          cdaId: cda.id,
          approverId: userId,
          approverRole: userType,
        })
        setShowApproveDialog(false)
        router.refresh()
      } catch (error) {
        console.error("[CDA] Approve failed:", error)
      }
    })
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "approved":
        return <Badge className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" />Approved</Badge>
      case "submitted":
        return <Badge className="bg-blue-500"><Send className="h-3 w-3 mr-1" />Submitted</Badge>
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
                        <p className="font-medium">
                          {formatCurrency(agent?.cap_progress ?? 0)} / {formatCurrency(agent?.cap_amount ?? 0)}
                        </p>
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
                            // Create agent notification
                            await supabase.from("notifications").insert({
                              user_id: transaction.agent_id,
                              brokerage_id: transaction.brokerage_id,
                              type: "commission_paid",
                              title: "Your commission has been disbursed",
                              body: `Your commission for ${transaction.property_address} has been marked as paid.`,
                              entity_type: "transaction",
                              entity_id: transaction.id,
                              is_read: false,
                            }).catch(() => {})
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
