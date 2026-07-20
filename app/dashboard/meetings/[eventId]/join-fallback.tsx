// app/dashboard/meetings/[eventId]/join-fallback.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE round-39 join tier, EXTRACTED (round 40) — not duplicated. This is the
// honest iframe + join-launch markup the meeting room shipped with in round
// 39. It now renders in exactly two places, both through THIS component:
//   • server-side, when the Meeting SDK credentials are not configured at all;
//   • client-side, when the signature route refuses (428) at join time.
// The `note` prop carries the honest statement of WHY the full in-page embed
// is not active (the SDK credential gap), defaulting to the round-39 wording.

import { Button } from "@/components/ui/button"
import { ExternalLink } from "lucide-react"

export const FALLBACK_DEFAULT_NOTE =
  "If the embedded window stays blank, Zoom is refusing to render inside the OS — " +
  "use “Join Zoom meeting” above. A fully in-page meeting requires the Zoom Meeting " +
  "SDK credentials (ZOOM_SDK_KEY/ZOOM_SDK_SECRET, or a Zoom General app's client " +
  "credentials) — set them to upgrade this pane to the native embed."

export function ZoomJoinFallback({
  joinUrl,
  startUrl,
  isHost,
  note,
}: {
  joinUrl: string
  startUrl?: string | null
  isHost: boolean
  note?: string | null
}) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <a href={joinUrl} target="_blank" rel="noopener noreferrer">
          <Button>
            <ExternalLink className="h-4 w-4 mr-2" />
            Join Zoom meeting
          </Button>
        </a>
        {isHost && startUrl && (
          <a href={startUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline">Start as host</Button>
          </a>
        )}
      </div>
      {/* Honest embed tier: the real join URL in an iframe. Zoom may refuse
          framing — the launch buttons above always work. */}
      <div className="aspect-video w-full rounded-lg border bg-muted/30 overflow-hidden">
        <iframe
          src={joinUrl}
          className="h-full w-full"
          allow="camera; microphone; fullscreen; display-capture; autoplay"
          title="Zoom meeting"
        />
      </div>
      <p className="text-xs text-muted-foreground">{note ?? FALLBACK_DEFAULT_NOTE}</p>
    </>
  )
}
