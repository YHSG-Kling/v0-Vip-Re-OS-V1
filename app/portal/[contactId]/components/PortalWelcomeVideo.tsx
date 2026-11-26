/**
 * PortalWelcomeVideo — the contact's personal welcome video from their agent, IN THEIR PORTAL (contract C3, wave 146).
 *
 * OWNER RULING 6: "put the welcome personal video in-app contact portal so the contact sees it right away" — "automatically
 * sent in the portal regardless of the contact's preferences." The welcome email went at conversion; this is where the video
 * lives. It is a standard part of the portal journey (an in-app experience, not a marketing message), so channel preferences
 * do not hide it; the person's STATED accessibility preferences shape the playback (the transcript opens first; nothing ever
 * autoplays — CardVideoPlayer, THE one portal player, carries no autoPlay).
 *
 * GATE FIRST, THEN THE SERVICE READ (CLAUDE.md §4): the tenant and the right to see this contact come from the SESSION
 * (requireContactAccess — the contact themselves, or same-brokerage contact-scope staff); the reader is pinned to that
 * brokerage AND this contact (lib/portal/welcome-video.ts portalWelcomeVideoFor). A refused gate renders nothing.
 *
 * NEVER A FALSE STATE: the contact sees the video only when the reader says it is validated (`ready`); while it renders, or if
 * it failed, the CONTACT sees nothing — never a "coming soon" promise of a recording that may not arrive. Staff previewing the
 * portal (the agent / the tenant) see the honest state and its reason instead, so a failure is visible to the people who fix it.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Video } from "lucide-react"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { createServiceClient } from "@/lib/supabase/service"
import { portalWelcomeVideoFor, recordPortalWelcomeVideoServed } from "@/lib/portal/welcome-video"
import { CardVideoPlayer } from "./CardVideoPlayer"

const STAFF_STATE_LABEL: Record<string, string> = {
  preparing: "Welcome video rendering",
  failed: "Welcome video not available",
  none: "No welcome video",
  unavailable: "Welcome video status unreadable",
}

/** `className` wraps the card only when something renders — an empty state leaves no stray spacing in the layout. */
export async function PortalWelcomeVideo({ contactId, className }: { contactId: string; className?: string }) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const svc = createServiceClient()
  const video = await portalWelcomeVideoFor(svc, access.brokerageId, contactId)

  if (video.state !== "ready") {
    // The CONTACT never sees a promise or a failure here. Staff previewing this portal see the honest state.
    if (access.isContactSelf) return null
    return (
      <div className={className}>
      <Card className="border-dashed" aria-live="polite">
        <CardContent className="p-4 text-sm">
          <p className="font-medium text-foreground flex items-center gap-2">
            <Video className="h-4 w-4" aria-hidden="true" />
            {STAFF_STATE_LABEL[video.state] ?? "Welcome video"}
            <span className="text-xs font-normal text-muted-foreground">(only staff see this — the client sees nothing until it is ready)</span>
          </p>
          <p className="text-muted-foreground pt-1">{video.reason}</p>
        </CardContent>
      </Card>
      </div>
    )
  }

  // The contact's own view is recorded once per render (the readback from their side). Never blocks the page.
  if (access.isContactSelf) {
    await recordPortalWelcomeVideoServed(svc, {
      brokerageId: access.brokerageId, contactId, videoProjectId: video.videoProjectId, scope: video.scope, viewerUserId: access.userId,
    }).catch(() => undefined)
  }

  return (
    <div className={className}>
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2" id="portal-welcome-video-title">
          <Video className="h-4 w-4 text-blue-700" aria-hidden="true" />
          A personal welcome from your agent
        </CardTitle>
      </CardHeader>
      <CardContent>
        <section aria-labelledby="portal-welcome-video-title">
          <CardVideoPlayer
            contactId={contactId}
            videoProjectId={video.videoProjectId}
            url={video.videoUrl}
            poster={video.posterUrl ?? undefined}
            caption={video.scope === "contact_personal" ? "Your personal welcome from your agent" : "A personal hello from your agent"}
            label="Personal welcome video from your agent"
            transcript={video.transcript}
            transcriptOpen={video.playback.transcriptOpen}
          />
        </section>
      </CardContent>
    </Card>
    </div>
  )
}
