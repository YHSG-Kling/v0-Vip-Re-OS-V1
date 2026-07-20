// app/dashboard/meetings/[eventId]/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE MEETING ROOM IN THE OS (round 39) — the page a Zoom appointment opens in.
// Shows the meeting context (contact, appointment, prep notes) beside the Zoom
// window.
//
// EMBED TIER (honest): this page embeds the meeting's REAL join URL in an
// iframe and always offers the join-launch button. Zoom's own pages may refuse
// third-party framing — the stated NEXT STEP for a fully in-page experience is
// the Zoom Meeting Component SDK (separate SDK credentials: ZOOM_SDK_KEY /
// ZOOM_SDK_SECRET + the @zoom/meetingsdk embedded client), which renders the
// meeting inside this pane natively. Nothing here pretends to be that SDK.

import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, Video, FileText, User } from "lucide-react"

export const dynamic = "force-dynamic"

export default async function MeetingRoomPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // RLS-scoped read: the event resolves only within the viewer's brokerage.
  const { data: event } = await supabase
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_type, entity_id, event_type, title, start_at, end_at, location, metadata, status")
    .eq("id", eventId)
    .maybeSingle()
  if (!event) notFound()

  const meta = (event.metadata ?? {}) as Record<string, any>
  const zoom = (meta.zoom ?? null) as
    | { meeting_id?: string; join_url?: string; start_url?: string; host_owner_type?: string; transcript_attached?: boolean; transcript_attached_to?: string }
    | null
  const zoomOutcome = (meta.zoom_outcome ?? null) as { created?: boolean; reason?: string; detail?: string } | null

  // ── Meeting context: the contact tied to this event ────────────────────────
  let contactId: string | null = null
  if (event.entity_type === "contact") contactId = event.entity_id
  else if (event.entity_type === "lead" && event.entity_id) {
    const { data: lead } = await supabase.from("leads").select("contact_id").eq("id", event.entity_id).maybeSingle()
    contactId = (lead?.contact_id as string | null) ?? null
  }
  if (!contactId && meta.contact_id) contactId = meta.contact_id as string

  let contact: { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null = null
  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone")
      .eq("id", contactId)
      .maybeSingle()
    contact = (data as any) ?? null
  }

  const contactName = contact
    ? [contact.first_name ?? "", contact.last_name ?? ""].join(" ").trim() || "Contact"
    : null
  const startAt = event.start_at ? new Date(event.start_at) : null
  const isHost = event.agent_user_id === user.id

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Video className="h-6 w-6" />
            {event.title ?? "Meeting"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {startAt ? startAt.toLocaleString() : "Unscheduled"}
            {event.event_type ? ` · ${String(event.event_type).replace(/_/g, " ")}` : ""}
          </p>
        </div>
        {zoom?.join_url && <Badge>Zoom meeting</Badge>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── The Zoom window ─────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Zoom</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {zoom?.join_url ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <a href={zoom.join_url} target="_blank" rel="noopener noreferrer">
                    <Button>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Join Zoom meeting
                    </Button>
                  </a>
                  {isHost && zoom.start_url && (
                    <a href={zoom.start_url} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline">Start as host</Button>
                    </a>
                  )}
                </div>
                {/* Honest embed tier: the real join URL in an iframe. Zoom may
                    refuse framing — the launch buttons above always work. The
                    full in-page experience is the Component SDK upgrade (see
                    file header): ZOOM_SDK_KEY/SECRET + @zoom/meetingsdk. */}
                <div className="aspect-video w-full rounded-lg border bg-muted/30 overflow-hidden">
                  <iframe
                    src={zoom.join_url}
                    className="h-full w-full"
                    allow="camera; microphone; fullscreen; display-capture; autoplay"
                    title="Zoom meeting"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  If the embedded window stays blank, Zoom is refusing to render inside the OS —
                  use “Join Zoom meeting” above. A fully in-page meeting requires the Zoom Meeting
                  Component SDK (separate SDK credentials), which is the stated next step for this
                  surface.
                </p>
                {zoom.transcript_attached && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    Transcript attached to {zoom.transcript_attached_to === "tenant" ? "the tenant record" : "the contact"} and analyzed.
                  </p>
                )}
              </>
            ) : (
              <div className="py-8 text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  This appointment has no Zoom meeting.
                </p>
                <p className="text-xs text-muted-foreground max-w-md mx-auto">
                  {zoomOutcome?.detail ??
                    (event.location
                      ? `Location: ${event.location}`
                      : "It was booked as in-person/phone. Book with meeting mode “Zoom” — and connect a Zoom account in Settings — to host it here.")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Meeting context beside the window ───────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <User className="h-4 w-4" />
                {contactName ?? "No linked contact"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {contact ? (
                <>
                  {contact.email && <div><span className="text-muted-foreground">Email: </span>{contact.email}</div>}
                  {contact.phone && <div><span className="text-muted-foreground">Phone: </span>{contact.phone}</div>}
                  <Link href={`/crm?contact=${contact.id}`} className="inline-block">
                    <Button variant="outline" size="sm" className="mt-2">Open in CRM</Button>
                  </Link>
                </>
              ) : (
                <p className="text-muted-foreground">
                  This meeting isn&apos;t tied to a contact record{event.entity_type === "lead" ? " yet (lead without a linked contact)" : ""}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Prep notes</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {meta.notes ? (
                <p className="whitespace-pre-wrap">{String(meta.notes)}</p>
              ) : (
                <p className="text-muted-foreground">No prep notes on this appointment.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
