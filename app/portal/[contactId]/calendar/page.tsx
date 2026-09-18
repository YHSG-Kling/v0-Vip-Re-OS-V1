import { createClient } from "@/lib/supabase/server"
import { Suspense } from "react"
import PortalCalendarDashboard from "@/components/portal/PortalCalendarDashboard"

export default async function CalendarPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact info.
  //
  // AMBIGUOUS EMBED REMOVED (PGRST201). contacts ↔ listings carries TWO FKs
  // (listings_contact_id_fkey, listings_seller_contact_id_fkey), so the bare
  // `listings(*)` was ambiguous and PostgREST refused the ENTIRE request — not just
  // the embed. supabase-js resolves that refusal, so `contact` was null and this page
  // rendered "Contact not found" for every client with a perfectly valid portal.
  // Nothing consumes it: PortalCalendarDashboard takes `contact` only to pass it
  // along and never reads `contact.listings`. So the embed is dropped rather than
  // hinted — a calendar has no use for a listing, and the cheapest correct read is
  // the one that doesn't join at all.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  // Check the error — an unchecked read reports a refusal as an absence, which is why
  // a broken query looked exactly like a missing contact.
  if (contactError || !contact) {
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

  // Check the error on every read; a resolved failure must not render as an empty day.
  for (const [label, res] of [
    ["showing_requests", showingsResult],
    ["transactions", transactionsResult],
    ["client_documents", documentsResult],
  ] as const) {
    if (res.error) console.error(`[PortalCalendar] ${label} read failed:`, res.error)
  }

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
