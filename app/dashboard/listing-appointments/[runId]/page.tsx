import { redirect, notFound } from "next/navigation"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { getListingAppointmentPrepDetail } from "@/app/actions/listing-appointment-copilot"
import { ListingApptCoPilotPanel } from "@/app/components/features/listing-appointment/listing-appt-copilot-panel"

/**
 * /dashboard/listing-appointments/[runId]
 *
 * Per-prep deep dive — server-loaded via getListingAppointmentPrepDetail
 * which aggregates workflow_runs + workflow_run_steps + dereferenced
 * cma_reports / listing_presentations / video_projects rows.
 *
 * Auth: the action enforces auth.getUser(); RLS gates by brokerage_id on
 * each underlying table. We additionally redirect unauth users from here.
 */

interface PageProps {
  params: Promise<{ runId: string }>
}

export default async function ListingAppointmentPrepPage({ params }: PageProps) {
  const { runId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const result = await getListingAppointmentPrepDetail({ runId })
  if (!result.success || !result.data) {
    notFound()
  }

  const prep = result.data
  const backHref = prep.contactId
    ? `/crm?contact=${prep.contactId}`
    : "/dashboard/agent"

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground truncate">
          Listing Appointment Co-Pilot
          {prep.contactName && <> · {prep.contactName}</>}
        </span>
      </div>

      <div className="flex-1 overflow-auto p-6 max-w-3xl">
        <ListingApptCoPilotPanel prep={prep} />
      </div>
    </div>
  )
}
