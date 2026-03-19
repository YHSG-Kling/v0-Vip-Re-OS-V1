import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getVendorBookings } from "@/app/actions/multi-persona"
import { getVendorJobs } from "@/app/actions/vendor-portal"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Wrench, Calendar, CheckCircle2, Clock, DollarSign, FileText, MessageSquare } from "lucide-react"
import { VendorJobsList } from "@/components/vendor/jobs-list"
import { VendorJobDetail } from "@/components/vendor/job-detail"

export default async function VendorPortalDashboard({ searchParams }: { searchParams: Promise<{ vendorId?: string; jobId?: string }> }) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let vendorId = params.vendorId
  if (!vendorId) {
    const { data: vendor } = await supabase.from("vendor_directory").select("id").eq("user_id", user.id).single()
    vendorId = vendor?.id
  }

  if (!vendorId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Wrench className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No vendor profile found. Please contact your administrator.</p>
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
    </div>
  )
}
