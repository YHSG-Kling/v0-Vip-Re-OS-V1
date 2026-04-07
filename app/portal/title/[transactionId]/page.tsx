import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { getTitleTransactionDetail, TITLE_VISIBLE_MILESTONES } from "@/app/actions/title-portal"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ArrowLeft,
  Building,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  Calendar,
  User,
  Phone,
  Mail,
  DollarSign,
  AlertTriangle,
} from "lucide-react"
import { TitleDocumentUpload } from "./document-upload"
import { TitleActions } from "./title-actions"
import { ClosingChecklist } from "./closing-checklist"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"

const TITLE_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  title_search: { label: "Title Search", color: "bg-blue-100 text-blue-800" },
  pending: { label: "Pending", color: "bg-slate-100 text-slate-800" },
  commitment_issued: { label: "Commitment Issued", color: "bg-amber-100 text-amber-800" },
  closing_ready: { label: "Closing Ready", color: "bg-green-100 text-green-800" },
  clear: { label: "Clear", color: "bg-emerald-100 text-emerald-800" },
  closed: { label: "Closed", color: "bg-slate-100 text-slate-600" },
}

const EMD_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-orange-100 text-orange-800" },
  received: { label: "Received", color: "bg-green-100 text-green-800" },
  released: { label: "Released", color: "bg-slate-100 text-slate-600" },
}

const MILESTONE_STATUS_CONFIG: Record<string, { icon: any; color: string }> = {
  completed: { icon: CheckCircle2, color: "text-green-600" },
  in_progress: { icon: Clock, color: "text-blue-600" },
  pending: { icon: Clock, color: "text-muted-foreground" },
  overdue: { icon: AlertCircle, color: "text-red-600" },
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

export default async function TitleTransactionDetailPage({
  params,
}: {
  params: Promise<{ transactionId: string }>
}) {
  const { transactionId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Get title user profile
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, email, company_name")
    .eq("user_id", user.id)
    .single()

  if (!titleUser) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Building className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No title company profile found.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  let detail
  try {
    detail = await getTitleTransactionDetail(transactionId, titleUser.id)
  } catch (error: any) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-500" />
            <p className="text-red-600 font-medium">{error.message || "Access denied"}</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href="/portal/title">Back to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { transaction, titleEscrow, milestones, documents, closingPrep, daysUntilClose } = detail
  const titleStatus = titleEscrow?.title_status || "pending"
  const emdStatus = titleEscrow?.earnest_money_status || "pending"
  const titleStatusConfig = TITLE_STATUS_CONFIG[titleStatus] || TITLE_STATUS_CONFIG.pending
  const emdStatusConfig = EMD_STATUS_CONFIG[emdStatus] || EMD_STATUS_CONFIG.pending
  const titleIssues = titleEscrow?.title_issues || []
  const hasIssues = titleIssues.length > 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href="/portal/title">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-2xl font-bold">{transaction.property_address || "Transaction Details"}</h1>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>{titleUser.company_name}</span>
            {titleEscrow?.escrow_number && (
              <>
                <span>|</span>
                <span className="font-mono">Escrow #{titleEscrow.escrow_number}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className={titleStatusConfig.color}>
            {titleStatusConfig.label}
          </Badge>
          <Badge variant="secondary" className={emdStatusConfig.color}>
            EMD: {emdStatusConfig.label}
          </Badge>
        </div>
      </div>

      {/* Title Issues Alert */}
      {hasIssues && (
        <Card className="bg-red-50 border-red-200">
          <CardContent className="py-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800">
                  {titleIssues.length} Title Issue{titleIssues.length !== 1 ? "s" : ""} Require Attention
                </p>
                <ul className="mt-2 space-y-1">
                  {titleIssues.map((issue: any, idx: number) => (
                    <li key={idx} className="text-sm text-red-700 flex items-center gap-2">
                      <Badge
                        variant={issue.severity === "critical" ? "destructive" : "secondary"}
                        className="text-xs"
                      >
                        {issue.severity || "warning"}
                      </Badge>
                      {issue.description || issue.type || "Unspecified issue"}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                    Scheduled: {formatDate(transaction.close_date || transaction.closing_date)}
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
          {/* Transaction Details Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Transaction Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Purchase Price</p>
                  <p className="font-semibold text-lg">{formatCurrency(transaction.purchase_price)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Earnest Money</p>
                  <p className="font-semibold text-lg">{formatCurrency(titleEscrow?.earnest_money_amount)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Contract Date</p>
                  <p className="font-medium">{formatDate(transaction.contract_date)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Closing Date</p>
                  <p className="font-medium">{formatDate(transaction.close_date || transaction.closing_date)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Closing Checklist */}
          <ClosingChecklist
            transactionId={transactionId}
            titleUserId={titleUser.id}
            closingPrep={closingPrep}
          />

          {/* Milestones */}
          <Card>
            <CardHeader>
              <CardTitle>Closing Milestones</CardTitle>
              <CardDescription>Key milestones for this closing</CardDescription>
            </CardHeader>
            <CardContent>
              {milestones.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No milestones set yet</p>
              ) : (
                <div className="space-y-3">
                  {milestones.map((milestone: any) => {
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
                            {milestone.milestone_date && (
                              <p className="text-sm text-muted-foreground">
                                {formatDate(milestone.milestone_date)}
                              </p>
                            )}
                          </div>
                        </div>
                        <Badge
                          variant={milestone.status === "completed" ? "default" : "secondary"}
                        >
                          {milestone.status}
                        </Badge>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Document Upload */}
          <TitleDocumentUpload
            transactionId={transactionId}
            titleUserId={titleUser.id}
            existingDocuments={documents}
          />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Actions Card */}
          <TitleActions
            transactionId={transactionId}
            titleUserId={titleUser.id}
            currentStatus={titleStatus}
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
                  {transaction.contacts.first_name} {transaction.contacts.last_name}
                </p>
                {transaction.contacts.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${transaction.contacts.email}`} className="text-primary hover:underline">
                      {transaction.contacts.email}
                    </a>
                  </div>
                )}
                {transaction.contacts.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${transaction.contacts.phone}`} className="text-primary hover:underline">
                      {transaction.contacts.phone}
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
                  {transaction.agents.first_name} {transaction.agents.last_name}
                </p>
                {transaction.agents.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${transaction.agents.email}`} className="text-primary hover:underline">
                      {transaction.agents.email}
                    </a>
                  </div>
                )}
                {transaction.agents.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${transaction.agents.phone}`} className="text-primary hover:underline">
                      {transaction.agents.phone}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
      <InternalAIAssistant role="title" />
    </div>
  )
}
