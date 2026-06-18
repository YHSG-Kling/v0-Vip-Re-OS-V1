import { createClient } from "@/lib/supabase/server"
import { Suspense } from "react"
import PortalCalendarDashboard from "@/components/portal/PortalCalendarDashboard"

export default async function CalendarPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact info
  const { data: contact } = await supabase.from("contacts").select("*, listings(*)").eq("id", contactId).single()

  if (!contact) {
    return <div>Contact not found</div>
  }

  // Fetch all date-sensitive items for this contact
  const [showingsResult, transactionsResult, documentsResult] = await Promise.all([
    // Showings
    supabase
      .from("showing_requests")
      .select("*")
      .eq("contact_id", contactId)
      .order("requested_date", { ascending: true }),

    supabase
      .from("transactions")
      .select("*, transaction_milestones(*), transaction_deadlines(*)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),

    // Documents needing signature/attention
    supabase
      .from("client_documents")
      .select("*")
      .eq("contact_id", contactId)
      .in("status", ["pending_signature", "action_required"])
      .order("created_at", { ascending: false }),
  ])

  const showings = showingsResult.data || []
  const transactions = transactionsResult.data || []
  const pendingDocuments = documentsResult.data || []

  const milestones = transactions.flatMap((t: any) =>
    (t.transaction_milestones || []).map((m: any) => ({
      ...m,
      transaction_address: t.property_address,
    })),
  )

  const deadlines = transactions.flatMap((t: any) =>
    (t.transaction_deadlines || []).map((d: any) => ({
      ...d,
      deadline: d.due_date, // Map due_date to deadline for component compatibility
      transaction_address: t.property_address,
    })),
  )

  return (
    <Suspense fallback={<div className="animate-pulse">Loading calendar...</div>}>
      <PortalCalendarDashboard
        contact={contact}
        contactId={contactId}
        showings={showings}
        milestones={milestones}
        deadlines={deadlines}
        pendingDocuments={pendingDocuments}
      />
    </Suspense>
  )
}
