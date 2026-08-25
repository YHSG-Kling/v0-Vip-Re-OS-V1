import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { getLenderTransactionDetail, LENDER_VISIBLE_MILESTONES } from "@/app/actions/lender-portal"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ArrowLeft,
  Building2,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  Calendar,
  User,
  Phone,
  Mail,
} from "lucide-react"
import { LenderDocumentUpload } from "./document-upload"
import { LenderActions } from "./lender-actions"
import { LenderConditionsPanel } from "./lender-conditions-panel"
import { Progress } from "@/components/ui/progress"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"

const LOAN_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
  in_review: { label: "In Review", color: "bg-amber-100 text-amber-800" },
  pending_conditions: { label: "Pending Conditions", color: "bg-orange-100 text-orange-800" },
  approved: { label: "Approved", color: "bg-green-100 text-green-800" },
  clear_to_close: { label: "Clear to Close", color: "bg-emerald-100 text-emerald-800" },
  funded: { label: "Funded", color: "bg-slate-100 text-slate-600" },
  denied: { label: "Denied", color: "bg-red-100 text-red-800" },
}

const MILESTONE_STATUS_CONFIG: Record<string, { icon: any; color: string }> = {
  completed: { icon: CheckCircle2, color: "text-green-600" },
  in_progress: { icon: Clock, color: "text-blue-600" },
  pending: { icon: Clock, color: "text-muted-foreground" },
  overdue: { icon: AlertCircle, color: "text-red-600" },
  // A milestone the transaction has no row for yet. Distinct from "pending",
  // which means the row exists and is waiting.
  not_started: { icon: Clock, color: "text-muted-foreground" },
}

/**
 * The five lender-visible milestones, each either its real row or a NOT-STARTED
 * placeholder.
 *
 * This card used to render `milestones` — the rows that happen to exist — so a
 * lender saw a partial list and could not tell an outstanding step from one
 * nobody had recorded. `LENDER_VISIBLE_MILESTONES` (app/actions/lender-portal.ts:4)
 * is the same list the server action filters the query by
 * (app/actions/lender-portal-actions.ts:73), so the entitlement and the display
 * are now driven by ONE vocabulary rather than two — and a milestone added to
 * that list shows up here as an outstanding step instead of silently not
 * existing.
 */
function mergeLenderMilestones(rows: any[]) {
  const byName = new Map<string, any>()
  for (const r of rows) if (r?.milestone_name && !byName.has(r.milestone_name)) byName.set(r.milestone_name, r)
  return LENDER_VISIBLE_MILESTONES.map((name) => {
    const row = byName.get(name)
    return row ?? { id: `not-started:${name}`, milestone_name: name, status: "not_started", target_date: null }
  })
}

function formatCurrency(amount: number | null | undefined): string {
  if (!amount) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDate(date: string | null | undefined): string {
  if (!date) return "TBD"
  return new Date(date).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

export default async function LenderTransactionDetailPage({
  params,
}: {
  params: Promise<{ transactionId: string }>
}) {
  const { transactionId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Lenders are vendors — resolve the caller's LENDER VENDOR identity for the header.
  // Authorization itself is enforced inside getLenderTransactionDetail (vendor rail).
  const { data: roleRows } = await supabase
    .from("user_role_assignments")
    .select("vendor_id, vendors!inner(id, name, category)")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
  const { isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
  const lenderVendor = ((roleRows ?? []) as any[]).map((r) => r.vendors).find((v) => v && isLenderVendorCategory(v.category))
  const lender = lenderVendor ? { id: lenderVendor.id as string, lender_company: (lenderVendor.name as string) ?? null } : null

  if (!lender) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No lender profile found.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  let detail
  try {
    detail = await getLenderTransactionDetail(transactionId, lender.id)
  } catch (error: any) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-500" />
            <p className="text-red-600 font-medium">{error.message || "Access denied"}</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href="/portal/lender">Back to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { transaction, lenderAssignment, milestones, documents, daysUntilClose } = detail
  const loanStatus = lenderAssignment?.loan_status || "submitted"
  const statusConfig = LOAN_STATUS_CONFIG[loanStatus] || LOAN_STATUS_CONFIG.submitted
  const isClearToClose = loanStatus === "clear_to_close"

  // Loan status progress — ordered pipeline stages
  const LOAN_PIPELINE = ["submitted", "in_review", "pending_conditions", "approved", "clear_to_close", "funded"]
  const loanStatusIndex = LOAN_PIPELINE.indexOf(loanStatus)
  const loanProgressPct = loanStatusIndex >= 0
    ? Math.round(((loanStatusIndex + 1) / LOAN_PIPELINE.length) * 100)
    : 10

  // Conditions from lenderAssignment (stored in conditions_list jsonb)
  const existingConditions: Array<{ condition: string; status: string; documents: string[] }> =
    (lenderAssignment as any)?.conditions_list ?? []

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href="/portal/lender">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">{transaction.property_address || "Transaction Details"}</h1>
          <p className="text-muted-foreground">{lender.lender_company}</p>
        </div>
        <Badge variant="secondary" className={`${statusConfig.color} text-sm px-3 py-1`}>
          {statusConfig.label}
        </Badge>
      </div>

      {/* Closing Countdown */}
      {daysUntilClose !== null && (
        <Card className={daysUntilClose <= 7 ? "bg-amber-50 border-amber-200" : "bg-blue-50 border-blue-200"}>
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Calendar className={`h-6 w-6 ${daysUntilClose <= 7 ? "text-amber-600" : "text-blue-600"}`} />
                <div>
                  <p className="font-semibold">
                    {daysUntilClose > 0
                      ? `${daysUntilClose} days until closing`
                      : daysUntilClose === 0
                        ? "Closing Today!"
                        : `${Math.abs(daysUntilClose)} days past scheduled close`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Scheduled: {formatDate(transaction.close_date)}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Loan Status Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Loan Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Loan Amount</p>
                  <p className="font-semibold text-lg">{formatCurrency(transaction.loan_amount || transaction.purchase_price)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Purchase Price</p>
                  <p className="font-semibold text-lg">{formatCurrency(transaction.purchase_price)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Contract Date</p>
                  <p className="font-medium">{formatDate(transaction.contract_date)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Closing Date</p>
                  <p className="font-medium">{formatDate(transaction.close_date)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Loan Status Progress Bar */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Loan Progress</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-xs text-muted-foreground">
                {LOAN_PIPELINE.map((stage, idx) => (
                  <span
                    key={stage}
                    className={idx <= loanStatusIndex ? "text-foreground font-medium" : ""}
                  >
                    {stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())}
                  </span>
                ))}
              </div>
              <Progress value={loanProgressPct} className="h-2" />
              <p className="text-xs text-muted-foreground text-right">{loanProgressPct}% complete</p>
            </CardContent>
          </Card>

          {/* Milestones */}
          <Card>
            <CardHeader>
              <CardTitle>Loan Milestones</CardTitle>
              <CardDescription>Key milestones for this loan</CardDescription>
            </CardHeader>
            <CardContent>
              {mergeLenderMilestones(milestones).length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No milestones set yet</p>
              ) : (
                <div className="space-y-3">
                  {mergeLenderMilestones(milestones).map((milestone: any) => {
                    const statusCfg = MILESTONE_STATUS_CONFIG[milestone.status] || MILESTONE_STATUS_CONFIG.pending
                    const StatusIcon = statusCfg.icon

                    return (
                      <div
                        key={milestone.id}
                        className="flex items-center justify-between p-3 rounded-lg border"
                      >
                        <div className="flex items-center gap-3">
                          <StatusIcon className={`h-5 w-5 ${statusCfg.color}`} />
                          <div>
                            <p className="font-medium capitalize">
                              {milestone.milestone_name.replace(/_/g, " ")}
                            </p>
                            {milestone.target_date && (
                              <p className="text-sm text-muted-foreground">
                                {formatDate(milestone.target_date)}
                              </p>
                            )}
                          </div>
                        </div>
                        <Badge
                          variant={milestone.status === "completed" ? "default" : "secondary"}
                        >
                          {String(milestone.status).replace(/_/g, " ")}
                        </Badge>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Document Upload */}
          <LenderDocumentUpload
            transactionId={transactionId}
            lenderId={lender.id}
            existingDocuments={documents}
          />

          {/* Loan Conditions */}
          <LenderConditionsPanel
            loanId={lenderAssignment?.id ?? ""}
            initialConditions={existingConditions as any}
          />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Actions Card */}
          <LenderActions
            transactionId={transactionId}
            lenderId={lender.id}
            currentStatus={loanStatus}
            isClearToClose={isClearToClose}
          />

          {/* Buyer Info */}
          {transaction.contacts && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Buyer
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="font-medium">
                  {(transaction.contacts as any).first_name} {(transaction.contacts as any).last_name}
                </p>
                {(transaction.contacts as any).email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${(transaction.contacts as any).email}`} className="text-primary hover:underline">
                      {(transaction.contacts as any).email}
                    </a>
                  </div>
                )}
                {(transaction.contacts as any).phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${(transaction.contacts as any).phone}`} className="text-primary hover:underline">
                      {(transaction.contacts as any).phone}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Agent Info */}
          {transaction.agents && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <User className="h-4 w-4" />
                  Agent
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="font-medium">
                  {(transaction.agents as any).first_name} {(transaction.agents as any).last_name}
                </p>
                {(transaction.agents as any).email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${(transaction.agents as any).email}`} className="text-primary hover:underline">
                      {(transaction.agents as any).email}
                    </a>
                  </div>
                )}
                {(transaction.agents as any).phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${(transaction.agents as any).phone}`} className="text-primary hover:underline">
                      {(transaction.agents as any).phone}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <InternalAIAssistant role="lender" />
    </div>
  )
}
