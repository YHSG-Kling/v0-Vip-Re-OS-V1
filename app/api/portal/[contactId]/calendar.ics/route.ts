import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"

export async function GET(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch all events for this contact
  const [showingsResult, transactionsResult] = await Promise.all([
    supabase.from("showing_requests").select("*").eq("contact_id", contactId),
    supabase.from("transactions").select("*, transaction_milestones(*)").eq("contact_id", contactId),
  ])

  const showings = showingsResult.data || []
  const transactions = transactionsResult.data || []

  // transaction_deadlines is transaction-keyed (no contact_id) — fetch via the
  // contact's transactions.
  const txnIds = transactions.map((t: any) => t.id)
  const deadlinesResult = txnIds.length
    ? await supabase.from("transaction_deadlines").select("*").in("transaction_id", txnIds)
    : { data: [], error: null }
  const deadlines = deadlinesResult.error ? [] : deadlinesResult.data || []

  // Extract milestones
  const milestones = transactions.flatMap((t: any) => t.transaction_milestones || [])

  // Generate iCal format
  const formatDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"

  const events = [
    ...showings
      .filter((s: any) => s.requested_date)
      .map((s: any) => ({
        uid: `showing-${s.id}@realestate-portal`,
        dtstart: formatDate(new Date(s.requested_date)),
        summary: `Property Showing: ${s.property_address || "Scheduled Viewing"}`,
        description: `Status: ${s.status || "pending"}`,
      })),
    ...milestones
      .filter((m: any) => m.target_date)
      .map((m: any) => ({
        uid: `milestone-${m.id}@realestate-portal`,
        dtstart: formatDate(new Date(m.target_date)),
        summary: m.milestone_name || m.name || "Transaction Milestone",
        description: `Status: ${m.status || "pending"}`,
      })),
    ...deadlines
      .filter((d: any) => d.deadline_date)
      .map((d: any) => ({
        uid: `deadline-${d.id}@realestate-portal`,
        dtstart: formatDate(new Date(d.deadline_date)),
        summary: `DEADLINE: ${d.deadline_type || d.description || "Important Deadline"}`,
        description: `Status: ${d.status || "pending"} - ACTION REQUIRED`,
      })),
  ]

  const icalContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Real Estate Portal//Calendar//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:My Real Estate Journey
X-WR-TIMEZONE:America/New_York
${events
  .map(
    (e) => `BEGIN:VEVENT
UID:${e.uid}
DTSTART:${e.dtstart}
SUMMARY:${e.summary}
DESCRIPTION:${e.description}
END:VEVENT`,
  )
  .join("\n")}
END:VCALENDAR`

  return new NextResponse(icalContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="real-estate-calendar.ics"',
    },
  })
}
