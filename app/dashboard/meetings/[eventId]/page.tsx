// app/dashboard/meetings/[eventId]/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE MEETING ROOM IN THE OS (round 39, upgraded round 40) — the page a Zoom
// appointment opens in. Shows the meeting context (contact, appointment, prep
// notes) beside the Zoom window.
//
// TWO TIERS, ONE HONEST CHOICE:
//   • FULL IN-PAGE (round 40): Meeting SDK credentials configured
//     (ZOOM_SDK_KEY/ZOOM_SDK_SECRET, or a Zoom General app's client creds) →
//     <MeetingEmbed> mounts the @zoom/meetingsdk/embedded Component-view
//     client right here: signature minted server-side by
//     /api/meetings/sdk-signature (role 1 when the viewer is the event's
//     owning agent), meeting runs natively in this pane.
//   • JOIN-LAUNCH FALLBACK (the round-39 tier, EXTRACTED to
//     <ZoomJoinFallback>, not duplicated): creds missing — or the SDK refuses
//     at join time — → real join URL in an iframe + the launch buttons, with
//     the honest upgrade note.
//
// OPS for the in-page tier: the Zoom app needs the Meeting SDK feature
// enabled and the OS host on its Domain Allow List (see the SDK section in
// lib/connections/zoom.ts).

import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Video, FileText, User } from "lucide-react"
import { currentZoomSdkEnv, resolveZoomSdkCredentials, zoomSdkGap } from "@/lib/connections/zoom"
import { MeetingEmbed } from "./meeting-embed"
import { ZoomJoinFallback } from "./join-fallback"

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

  // Round 40: full in-page embed only when a usable Meeting SDK credential
  // pair exists AND the meeting number is stamped. Otherwise the extracted
  // round-39 tier renders with the honest gap statement.
  const sdkEnv = currentZoomSdkEnv()
  const sdkConfigured = resolveZoomSdkCredentials(sdkEnv) !== null
  const sdkGap = zoomSdkGap(sdkEnv)

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
                {sdkConfigured && zoom.meeting_id ? (
                  // FULL IN-PAGE TIER: the embedded Component-view client.
                  // Degrades to <ZoomJoinFallback> client-side if the
                  // signature route or the SDK refuses at join time.
                  <MeetingEmbed
                    eventId={event.id}
                    joinUrl={zoom.join_url}
                    startUrl={isHost ? zoom.start_url ?? null : null}
                    isHost={isHost}
                    userEmail={user.email ?? null}
                  />
                ) : (
                  // ROUND-39 TIER (extracted): join-launch + iframe, with the
                  // honest reason the native embed is not active.
                  <ZoomJoinFallback
                    joinUrl={zoom.join_url}
                    startUrl={isHost ? zoom.start_url ?? null : null}
                    isHost={isHost}
                    note={
                      sdkGap ??
                      "This meeting was stamped without a Zoom meeting number, so the in-page Meeting SDK embed cannot target it — use the join link."
                    }
                  />
                )}
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
