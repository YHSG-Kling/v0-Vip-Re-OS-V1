"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, DollarSign, ArrowRight, ExternalLink } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface LenderCommandStripProps {
  lenderId: string
}

interface PriorityAction {
  id: string
  type: "urgent" | "warning" | "info"
  title: string
  description: string
  cta: string
  href: string
  count?: number
  /** WHO the count is about — the strip used to be a bare number */
  who?: string | null
  /** the lender's own application page, when exactly one row is waiting */
  applicationUrl?: string | null
}

// The strip ran THREE `select("id")` reads and rendered a bare count: "3
// applications need review" — which three, nobody could say. All three
// discarded their error too, so a refused read rendered the green
// "Pipeline clear - no pending actions" banner: a false all-clear.
// One read now covers the same status buckets, its error is READ (§3), and
// borrower identity comes through the FK COLUMN embed so neither
// `contacts.id`/`contacts.contact_id` nor any agents/users id is ever picked
// by hand (§3). lender_applications↔contacts has ONE FK — not the PGRST201 shape.
const STRIP_STATUSES = ["pending", "docs_needed", "approved", "processing", "underwriting"] as const

/** "Dana Reed", or "Dana Reed +2 more", or null when no row names a borrower. */
function namesOf(rows: Array<{ borrower: string | null }>): string | null {
  const named = rows.map((r) => r.borrower).filter((n): n is string => !!n)
  if (named.length === 0) return null
  if (named.length === 1) return named[0]
  return `${named[0]} +${named.length - 1} more`
}

export function LenderCommandStrip({ lenderId }: LenderCommandStripProps) {
  const [actions, setActions] = useState<PriorityAction[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPriorityActions() {
      const supabase = createClient()
      const priorityActions: PriorityAction[] = []

      const { data: apps, error: appsError } = await supabase
        .from("lender_applications")
        .select(
          "id, status, application_url, contact:contact_id(first_name, last_name)"
        )
        .eq("lender_id", lenderId)
        .in("status", [...STRIP_STATUSES])
        .order("created_at", { ascending: true })

      if (appsError) {
        // FAIL CLOSED: "nobody checked" must never render as "pipeline clear".
        console.error("[LenderCommandStrip] lender_applications read refused:", appsError.message)
        setLoadError(appsError.message)
        setActions([])
        setLoading(false)
        return
      }

      const one = (v: any) => (Array.isArray(v) ? v[0] ?? null : v ?? null)
      const rows = ((apps ?? []) as any[]).map((a: any) => {
        const c = one(a.contact)
        const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim()
        return {
          id: a.id as string,
          status: a.status as string,
          applicationUrl: (a.application_url as string | null) ?? null,
          borrower: name.length > 0 ? name : null,
        }
      })

      const pendingApps = rows.filter((r) => r.status === "pending")
      const docsNeeded = rows.filter((r) => r.status === "docs_needed")
      const activeLoans = rows.filter((r) => ["approved", "processing", "underwriting"].includes(r.status))

      // Check for pending loan applications
      if (pendingApps.length > 0) {
        priorityActions.push({
          id: "pending-apps",
          type: "urgent",
          title: "Pending Applications",
          description: `${pendingApps.length} application${pendingApps.length === 1 ? "" : "s"} need${pendingApps.length === 1 ? "s" : ""} review`,
          cta: "Review Now",
          href: "/lender/approvals?filter=pending",
          count: pendingApps.length,
          who: namesOf(pendingApps),
          applicationUrl: pendingApps.length === 1 ? pendingApps[0].applicationUrl : null,
        })
      }

      // Check for applications needing documents
      if (docsNeeded.length > 0) {
        priorityActions.push({
          id: "docs-needed",
          type: "warning",
          title: "Documents Needed",
          description: `${docsNeeded.length} application${docsNeeded.length === 1 ? "" : "s"} awaiting documents`,
          cta: "View",
          href: "/lender/documents?filter=needed",
          count: docsNeeded.length,
          who: namesOf(docsNeeded),
          applicationUrl: docsNeeded.length === 1 ? docsNeeded[0].applicationUrl : null,
        })
      }

      // Check for active loans
      if (activeLoans.length > 0) {
        priorityActions.push({
          id: "active-loans",
          type: "info",
          title: "Active Pipeline",
          description: `${activeLoans.length} loan${activeLoans.length === 1 ? "" : "s"} in progress`,
          cta: "View Pipeline",
          href: "/lender/pipeline",
          count: activeLoans.length,
          who: namesOf(activeLoans),
          applicationUrl: activeLoans.length === 1 ? activeLoans[0].applicationUrl : null,
        })
      }

      setActions(priorityActions)
      setLoading(false)
    }

    loadPriorityActions()
  }, [lenderId])

  if (loading) {
    return (
      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading pipeline status...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  // An unreadable ledger is not a clear pipeline.
  if (loadError) {
    return (
      <Card className="border-destructive/20 bg-gradient-to-r from-destructive/5 to-transparent">
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <div>
            <span className="font-medium">Pipeline status unavailable</span>
            <p className="text-xs text-muted-foreground">
              Your applications could not be read, so this is not an all-clear. {loadError}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (actions.length === 0) {
    return (
      <Card className="border-green-500/20 bg-gradient-to-r from-green-500/5 to-transparent">
        <CardContent className="flex items-center gap-3 p-4">
          <CheckCircle className="h-5 w-5 text-green-500" />
          <span className="font-medium text-green-700">Pipeline clear - no pending actions</span>
        </CardContent>
      </Card>
    )
  }

  const primaryAction = actions[0]

  return (
    <Card className={`border-${primaryAction.type === "urgent" ? "destructive" : primaryAction.type === "warning" ? "yellow-500" : "primary"}/20 bg-gradient-to-r from-${primaryAction.type === "urgent" ? "destructive" : primaryAction.type === "warning" ? "yellow-500" : "primary"}/5 to-transparent`}>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            {primaryAction.type === "urgent" && <AlertTriangle className="h-6 w-6 text-destructive" />}
            {primaryAction.type === "warning" && <Clock className="h-6 w-6 text-yellow-500" />}
            {primaryAction.type === "info" && <DollarSign className="h-6 w-6 text-primary" />}
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{primaryAction.title}</h3>
                {primaryAction.count && (
                  <Badge variant={primaryAction.type === "urgent" ? "destructive" : "secondary"}>
                    {primaryAction.count}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {primaryAction.description}
                {primaryAction.who ? ` — ${primaryAction.who}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {primaryAction.applicationUrl && (
              <a href={primaryAction.applicationUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  Open application
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </Button>
              </a>
            )}
            <Link href={primaryAction.href}>
              <Button variant={primaryAction.type === "urgent" ? "destructive" : "default"} size="sm">
                {primaryAction.cta}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            {actions.length > 1 && (
              <Badge variant="outline" className="text-xs">
                +{actions.length - 1} more
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
