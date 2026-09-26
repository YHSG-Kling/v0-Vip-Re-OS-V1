"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { DollarSign, TrendingUp, Clock, CheckCircle, XCircle, ExternalLink } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface LenderPipelinePanelProps {
  lenderId: string
}

// WHOSE LOAN IS IT. app/actions/partner-orders.ts:44-51 records contact_id,
// transaction_id AND the lender's own application_url on every row; this panel
// selected `id, status, loan_amount, created_at, approved_at` and rendered a
// list of anonymous status/amount pairs — nothing a lender could act on.
// Borrower identity is resolved through the FK COLUMN (`contact:contact_id(…)`),
// which is what makes it immune to BOTH id-class traps in CLAUDE.md §3:
// PostgREST follows the declared foreign key, so the `contacts.id` vs
// `contacts.contact_id` choice is never ours to get wrong, and no agents/users
// id is crossed at all. lender_applications↔contacts carries exactly ONE FK
// (scripts/schema-fk-map.ts:451), so this is not the PGRST201 shape either.
interface PipelineApplication {
  id: string
  status: string
  loanAmount: number | null
  /** null = the row names no contact, or this session may not read it. Never faked. */
  borrower: string | null
  /** the deal the loan belongs to — address/name only, no deal financials */
  deal: string | null
  /** the lender's OWN application page */
  applicationUrl: string | null
  createdAt: string | null
}

interface PipelineMetrics {
  totalApplications: number
  approved: number
  pending: number
  denied: number
  approvalRate: number
  totalVolume: number
  avgProcessingDays: number
  applications: PipelineApplication[]
  /** rows whose borrower could not be named — published beside the list, not hidden */
  unnamedBorrowers: number
}

const EMPTY_METRICS: PipelineMetrics = {
  totalApplications: 0,
  approved: 0,
  pending: 0,
  denied: 0,
  approvalRate: 0,
  totalVolume: 0,
  avgProcessingDays: 0,
  applications: [],
  unnamedBorrowers: 0,
}

export function LenderPipelinePanel({ lenderId }: LenderPipelinePanelProps) {
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get all applications for this lender. §5 boundary: nothing here reaches
      // past THIS lender's own application — loan_amount is the lender's own
      // figure, and the deal is named by address only. No purchase price, no
      // commission, no brokerage financials.
      const { data: applications, error: applicationsError } = await supabase
        .from("lender_applications")
        .select(
          "id, status, loan_amount, created_at, approved_at, application_url, " +
            "contact:contact_id(first_name, last_name), " +
            "transaction:transaction_id(id, deal_name, property_address)"
        )
        .eq("lender_id", lenderId)
        .order("created_at", { ascending: false })

      // §3: supabase-js RESOLVES refusals. A discarded error here rendered a
      // 0% approval rate and a $0 book as FACT — indistinguishable from a
      // lender with no applications. Fail closed and say so.
      if (applicationsError) {
        console.error("[LenderPipelinePanel] lender_applications read refused:", applicationsError.message)
        setLoadError(applicationsError.message)
        setMetrics(null)
        setLoading(false)
        return
      }

      if (!applications || applications.length === 0) {
        setMetrics(EMPTY_METRICS)
        setLoading(false)
        return
      }

      const totalApplications = applications.length
      const approved = applications.filter((a: any) => a.status === "approved" || a.status === "funded").length
      const pending = applications.filter((a: any) => ["pending", "processing", "underwriting"].includes(a.status)).length
      const denied = applications.filter((a: any) => a.status === "denied").length
      
      const decisioned = approved + denied
      const approvalRate = decisioned > 0 ? (approved / decisioned) * 100 : 0

      const totalVolume = applications
        .filter((a: any) => a.status === "approved" || a.status === "funded")
        .reduce((sum: any, a: any) => sum + (a.loan_amount || 0), 0)

      // Calculate avg processing time for approved loans
      const processedLoans = applications.filter((a: any) => a.approved_at && a.created_at)
      const avgProcessingDays = processedLoans.length > 0
        ? processedLoans.reduce((sum: any, a: any) => {
            const days = (new Date(a.approved_at).getTime() - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24)
            return sum + days
          }, 0) / processedLoans.length
        : 0

      // PostgREST returns a to-one embed as an object; a defensive array unwrap
      // keeps this honest if the relationship is ever re-declared to-many.
      const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v ?? null)
      const rows: PipelineApplication[] = (applications as any[]).map((a: any) => {
        const c = one(a.contact)
        const t = one(a.transaction)
        const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim()
        return {
          id: a.id,
          status: a.status,
          loanAmount: a.loan_amount ?? null,
          borrower: name.length > 0 ? name : null,
          deal: t?.property_address || t?.deal_name || null,
          applicationUrl: a.application_url ?? null,
          createdAt: a.created_at ?? null,
        }
      })

      setMetrics({
        totalApplications,
        approved,
        pending,
        denied,
        approvalRate,
        totalVolume,
        avgProcessingDays,
        applications: rows,
        unnamedBorrowers: rows.filter((r) => !r.borrower).length,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [lenderId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pipeline Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  // A refused read is NOT an empty pipeline. Say which one this is.
  if (loadError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Pipeline Overview</CardTitle>
          <CardDescription>Loan application metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your applications could not be read, so no pipeline figures are shown — an
            unreadable ledger is not an empty one.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">{loadError}</p>
        </CardContent>
      </Card>
    )
  }

  if (!metrics) return null

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Pipeline Overview</CardTitle>
        <CardDescription>Loan application metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Approval Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Approval Rate</span>
            <span className="text-sm font-bold">{metrics.approvalRate.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.approvalRate} className="h-2" />
        </div>

        {/* Status Breakdown */}
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col items-center rounded-lg bg-green-50 p-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="mt-1 text-lg font-bold text-green-600">{metrics.approved}</span>
            <span className="text-xs text-green-600/70">Approved</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-yellow-50 p-2 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="mt-1 text-lg font-bold text-yellow-600">{metrics.pending}</span>
            <span className="text-xs text-yellow-600/70">Pending</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-red-50 p-2 dark:bg-red-950/20">
            <XCircle className="h-4 w-4 text-red-600" />
            <span className="mt-1 text-lg font-bold text-red-600">{metrics.denied}</span>
            <span className="text-xs text-red-600/70">Denied</span>
          </div>
        </div>

        {/* Volume & Processing */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              Total Volume
            </span>
            <Badge variant="secondary">{formatCurrency(metrics.totalVolume)}</Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Avg Processing
            </span>
            <Badge variant="outline">{metrics.avgProcessingDays.toFixed(1)} days</Badge>
          </div>
        </div>

        {/* WHOSE LOANS — the rows the panel used to render as anonymous
            status/amount pairs. Borrower + deal + the lender's own application
            link is what makes a row actionable. */}
        {metrics.applications.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Recent Applications</span>
              {metrics.unnamedBorrowers > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {metrics.unnamedBorrowers} without a named borrower
                </span>
              )}
            </div>
            {metrics.applications.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {a.borrower ?? (
                      <span className="font-normal text-muted-foreground">Borrower not named on this application</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.deal ?? "No deal linked yet"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="outline" className="text-xs capitalize">
                    {String(a.status ?? "").replace(/_/g, " ")}
                  </Badge>
                  {a.loanAmount != null && (
                    <Badge variant="secondary" className="text-xs">{formatCurrency(a.loanAmount)}</Badge>
                  )}
                  {a.applicationUrl && (
                    <a
                      href={a.applicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary"
                      title="Open the application on your own site"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
