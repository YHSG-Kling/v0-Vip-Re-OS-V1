"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DollarSign, Clock, CheckCircle, AlertTriangle, ArrowRight, ExternalLink } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"
import { VENDOR_CATEGORY_LENDER } from "@/lib/kernel/vendor-categories"

interface LenderStatusPanelProps {
  brokerageId: string
}

interface LenderMetrics {
  activeLenders: number
  pendingPreApprovals: number
  activeLoans: number
  avgProcessingDays: number
  recentUpdates: {
    id: string
    lenderName: string
    status: string
    updatedAt: string
    /** WHOSE loan — null when the row names no contact. Never faked. */
    borrower: string | null
    /** the deal it belongs to, by address. NOT its price. */
    deal: string | null
    /** the lender's own application page */
    applicationUrl: string | null
  }[]
}

export function LenderStatusPanel({ brokerageId }: LenderStatusPanelProps) {
  const [metrics, setMetrics] = useState<LenderMetrics | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // vendors.category is Title Case in the CHECK. This asked for 'lender'
      // and Postgres compares case-sensitively, so the panel showed 0 lenders.
      const { data: lenders, count: lenderCount } = await supabase
        .from("vendors")
        .select("id, name", { count: "exact" })
        .eq("brokerage_id", brokerageId)
        .eq("category", VENDOR_CATEGORY_LENDER)
        .eq("status", "active")

      // Get loan applications from lender_applications table.
      // §5 boundary held EXACTLY where it was: this agent-facing panel gains
      // borrower + deal + the lender's application link — the three things that
      // make a row identifiable — and NO financial column it did not already
      // have. loan_amount is deliberately still not selected here; no
      // commission, no purchase price, no brokerage financials.
      // Borrower comes through the FK COLUMN (`contact:contact_id(…)`) so
      // PostgREST follows the declared key and the `contacts.id` vs
      // `contacts.contact_id` trap (CLAUDE.md §3) is never ours to get wrong;
      // lender_applications↔contacts carries one FK, so no PGRST201 either.
      const { data: loanApps, error: loanAppsError } = await supabase
        .from("lender_applications")
        .select(
          "id, status, lender_id, updated_at, application_url, vendors(name), " +
            "contact:contact_id(first_name, last_name), " +
            "transaction:transaction_id(deal_name, property_address)"
        )
        .eq("brokerage_id", brokerageId)
        .order("updated_at", { ascending: false })
        .limit(20)

      // §3: the refusal used to be discarded, so an unreadable ledger rendered
      // "0 pending pre-approvals / 0 active loans" as fact.
      if (loanAppsError) {
        console.error("[LenderStatusPanel] lender_applications read refused:", loanAppsError.message)
        setLoadError(loanAppsError.message)
        setMetrics(null)
        setLoading(false)
        return
      }

      const pendingPreApprovals = loanApps?.filter((a: any) => a.status === "pending" || a.status === "pre_approval").length || 0
      const activeLoans = loanApps?.filter((a: any) => a.status === "active" || a.status === "processing").length || 0

      // Recent updates
      const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v ?? null)
      const recentUpdates = (loanApps || []).slice(0, 5).map((app: any) => {
        const c = one(app.contact)
        const t = one(app.transaction)
        const borrower = [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim()
        return {
          id: app.id,
          lenderName: one(app.vendors)?.name || "Unknown Lender",
          status: app.status,
          updatedAt: app.updated_at,
          borrower: borrower.length > 0 ? borrower : null,
          deal: t?.property_address || t?.deal_name || null,
          applicationUrl: (app.application_url as string | null) ?? null,
        }
      })

      setMetrics({
        activeLenders: lenderCount || 0,
        pendingPreApprovals,
        activeLoans,
        avgProcessingDays: 14, // Would need historical data to calculate
        recentUpdates,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Lender Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  // An unreadable ledger is not an empty pipeline.
  if (loadError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Lender Status</CardTitle>
          <CardDescription>Loan pipeline overview</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Loan applications could not be read, so no counts are shown — an unreadable
            ledger is not an empty one.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">{loadError}</p>
        </CardContent>
      </Card>
    )
  }

  if (!metrics) return null

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "approved":
      case "active":
        return <CheckCircle className="h-3 w-3 text-green-500" />
      case "pending":
      case "pre_approval":
        return <Clock className="h-3 w-3 text-yellow-500" />
      case "denied":
      case "expired":
        return <AlertTriangle className="h-3 w-3 text-red-500" />
      default:
        return <Clock className="h-3 w-3 text-muted-foreground" />
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Lender Status</CardTitle>
            <CardDescription>Loan pipeline overview</CardDescription>
          </div>
          <Link href="/dashboard/vendors?category=lender">
            <Button variant="ghost" size="sm">
              Manage
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-950/20">
            <DollarSign className="h-4 w-4 text-blue-600" />
            <p className="mt-1 text-xl font-bold text-blue-600">{metrics.activeLenders}</p>
            <p className="text-xs text-blue-600/70">Active Lenders</p>
          </div>
          <div className="rounded-lg bg-yellow-50 p-3 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <p className="mt-1 text-xl font-bold text-yellow-600">{metrics.pendingPreApprovals}</p>
            <p className="text-xs text-yellow-600/70">Pending Pre-Approvals</p>
          </div>
        </div>

        {/* Active Loans */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <span className="text-sm font-medium">Active Loans in Pipeline</span>
          <Badge variant="secondary">{metrics.activeLoans}</Badge>
        </div>

        {/* Recent Updates */}
        {metrics.recentUpdates.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Recent Updates</span>
            {metrics.recentUpdates.slice(0, 3).map(update => (
              <div key={update.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-1">{getStatusIcon(update.status)}</span>
                  <div className="min-w-0">
                    <span className="block truncate">
                      {update.borrower ?? <span className="text-muted-foreground">Borrower not named</span>}
                      <span className="text-muted-foreground"> · {update.lenderName}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {update.deal ?? "No deal linked yet"}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {update.applicationUrl && (
                    <a
                      href={update.applicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary"
                      title="Open the lender's application page"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <Badge variant="outline" className="text-xs capitalize">
                    {update.status.replace("_", " ")}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
