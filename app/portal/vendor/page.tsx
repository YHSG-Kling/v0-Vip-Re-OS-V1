import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getVendorBookings } from "@/app/actions/multi-persona"
import { getVendorJobs } from "@/app/actions/vendor-portal"
import { createClient } from "@/lib/supabase/server"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Wrench, Calendar, CheckCircle2, Clock, DollarSign, FileText, MessageSquare, Users } from "lucide-react"
import { VendorJobsList } from "@/components/vendor/jobs-list"
import { VendorJobDetail } from "@/components/vendor/job-detail"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"
import { VendorCoveragePanel } from "./vendor-coverage-panel"

export default async function VendorPortalDashboard({ searchParams }: { searchParams: Promise<{ vendorId?: string; jobId?: string }> }) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let vendorId = params.vendorId
  let vendorLookupFailed = false
  if (!vendorId) {
    // Look up vendor via user_role_assignments.vendor_id first.
    //
    // This is the harder of the two shapes to spot: the failure of
    // `.maybeSingle()` over several vendor-bearing grants did not just blank the
    // page, it fell THROUGH to the email fallback below and resolved a vendor by
    // matching on an email address. A silent read error was therefore quietly
    // downgrading the identity check from a role grant to a string match.
    const grantsResult = await readRoleGrants(supabase, user.id)
    if (!grantsResult.ok) {
      console.error("[portal/vendor] role grant read failed:", grantsResult.error)
      vendorLookupFailed = true
    }
    const { vendorId: grantVendorId, ambiguous } = grantsResult.ok
      ? selectVendorId(grantsResult.grants)
      : { vendorId: null, ambiguous: false }
    if (ambiguous) {
      console.error("[portal/vendor] user", user.id, "is linked to more than one vendor")
      vendorLookupFailed = true
    }

    if (grantVendorId) {
      vendorId = grantVendorId
    } else if (vendorLookupFailed) {
      // Do NOT fall through to the email match on a failed or ambiguous grant
      // read — that substitutes a weaker identity check for the one that broke.
    } else {
      // Fallback: match by email
      const { data: userRow } = await supabase
        .from("users")
        .select("email, brokerage_id")
        .eq("id", user.id)
        .maybeSingle()

      if (userRow?.email) {
        // tenant anchor (scope burn-down): the email identity match is pinned
        // to the caller's own brokerage when their profile carries one.
        let vendorQuery = supabase
          .from("vendors")
          .select("id")
          .eq("email", userRow.email)
          .limit(1)
        if (userRow.brokerage_id) vendorQuery = vendorQuery.eq("brokerage_id", userRow.brokerage_id)
        const { data: vendor } = await vendorQuery.maybeSingle()
        vendorId = vendor?.id
      }
    }
  }

  if (!vendorId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Wrench className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">
              {vendorLookupFailed
                ? "We could not verify your vendor account just now. Please refresh, or contact your administrator if this persists."
                : "No vendor profile found. Please contact your administrator."}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Parallel fetch jobs and bookings
  const [jobs, bookings] = await Promise.all([
    getVendorJobs(vendorId),
    getVendorBookings(vendorId),
  ])

  const selectedJobId = params.jobId
  const selectedJob = selectedJobId ? jobs.find(j => j.id === selectedJobId) : null

  // SERVICE AREAS (m551). Read here rather than in the client panel so the page
  // is one round trip, and read through the SESSION's own vendor row — the
  // coverage rows hang off the GLOBAL identity this bench row points at, so a
  // bench row with no platform_vendor_id simply has none, which the panel says
  // plainly instead of showing a form that cannot save.
  //
  // Errors are destructured and READ (CLAUDE.md §3): a refused coverage read
  // resolving to `data: null` would render as "you have declared no service
  // areas", which is the opposite of the truth and would invite the vendor to
  // re-declare coverage they already hold.
  const { data: vendorRow, error: vendorRowErr } = await supabase
    .from("vendors")
    .select("platform_vendor_id, category")
    .eq("id", vendorId)
    .maybeSingle()
  if (vendorRowErr) console.error("[portal/vendor] vendor row read failed:", vendorRowErr)

  let coverageRows: any[] = []
  let coverageReadFailed = false
  if (vendorRow?.platform_vendor_id) {
    const { data: cov, error: covErr } = await supabase
      .from("vendor_service_areas")
      .select("id, state, zip_code, trade_category, status, license")
      .eq("platform_vendor_id", vendorRow.platform_vendor_id)
      .order("state", { ascending: true })
    if (covErr) {
      console.error("[portal/vendor] service-area read failed:", covErr)
      coverageReadFailed = true
    } else {
      coverageRows = cov ?? []
    }
  }

  const upcomingCount = jobs?.filter((j: any) => j.status === "scheduled" && new Date(j.vendor_assignments?.scheduled_date) >= new Date())?.length || 0
  const completedCount = jobs?.filter((j: any) => j.status === "completed")?.length || 0
  const activeCount = jobs?.filter((j: any) => j.status === "in_progress")?.length || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My Jobs</h1>
          <p className="text-muted-foreground">Manage your service assignments and deliverables</p>
        </div>
        {/* Orphan-route sweep: the scoped assigned-contacts surface was unreachable from any nav. */}
        <Link
          href="/portal/vendor/contacts"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <Users className="h-4 w-4" />
          My Contacts
        </Link>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Upcoming
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{upcomingCount}</div>
            <p className="text-xs text-muted-foreground">Scheduled</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              In Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{activeCount}</div>
            <p className="text-xs text-muted-foreground">Active now</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{completedCount}</div>
            <p className="text-xs text-muted-foreground">This period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Total Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{jobs?.length || 0}</div>
            <p className="text-xs text-muted-foreground">All time</p>
          </CardContent>
        </Card>
      </div>

      {/* WHERE THIS COMPANY WORKS (m551). Without a declared service area the
          booking gate refuses every booking with `vendor_coverage_unknown` —
          correctly, and permanently, so this panel is not optional furniture. */}
      {coverageReadFailed ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            We could not load your service areas just now. Please refresh — this is a read
            failure, not a sign that you have none.
          </CardContent>
        </Card>
      ) : (
        <VendorCoveragePanel
          platformVendorId={(vendorRow?.platform_vendor_id as string) ?? null}
          tradeCategory={(vendorRow?.category as string) ?? null}
          rows={coverageRows as any}
        />
      )}

      {/* Jobs List and Detail View */}
      {!selectedJobId ? (
        <VendorJobsList jobs={jobs || []} vendorId={vendorId} />
      ) : selectedJob ? (
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2">
            <VendorJobDetail job={selectedJob} vendorId={vendorId} />
          </div>
          <VendorJobsList jobs={jobs || []} vendorId={vendorId} selectedJobId={selectedJobId} />
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Job not found</p>
          </CardContent>
        </Card>
      )}
      <InternalAIAssistant role="vendor" />
    </div>
  )
}
