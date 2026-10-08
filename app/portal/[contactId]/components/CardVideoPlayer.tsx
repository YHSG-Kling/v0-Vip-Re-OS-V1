"use client"

/**
 * CardVideoPlayer — the portal feed's clip player, and THE PRODUCER for
 * /api/video/engagement (lane W8, 2026-09-01).
 *
 * That route's adjudication (its own header, lane G1 2026-08-28) recorded the
 * missing half precisely: nothing anywhere emitted view / complete / pause /
 * cta_click, so every completion rate on /dashboard/videos/analytics could only
 * read zero — and this surface, the client watching their agent's clip, is "the
 * exact event this ledger was built for". The card metadata now carries the
 * video PROJECT id (welcome_video_project_id is stamped by
 * lib/kernel/client-welcome.ts:writePortalWelcomeCard;
 * anniversary_video_project_id by the intro-video-email-backfill cron's
 * anniversary sweep), so the events finally have something to attribute to.
 *
 * NOT the app/v/[slug] lane: that player is unauthenticated and already served
 * by trackVideoView. This one rides the CONTACT SESSION the portal's other
 * fetches use — /api/video/engagement admits it through the same
 * requireContactAccess gate as /api/portal/client-action, and the event carries
 * this card's contactId so app/actions/contact-details.ts can read it back per
 * contact.
 *
 * HONEST DEGRADATION:
 *   · no videoProjectId on the card (older cards predate the stamps) → the clip
 *     plays with NO tracking at all — nothing is invented to attribute to;
 *   · a failed POST is console-logged and NEVER blocks or interrupts playback;
 *   · `view` fires once per mount on first play (a resume after pause is not a
 *     second view), `pause` skips the browser's automatic pause-at-end (that
 *     moment is `complete`), `complete` fires on ended, `cta_click` on the
 *     fallback watch link.
 */

import { useRef } from "react"
import { Video } from "lucide-react"

interface Props {
  contactId: string
  /** ai_video_projects.id from the card metadata — null on cards that predate
   *  the id stamps; playback then proceeds untracked. */
  videoProjectId: string | null
  url: string
  poster?: string
  caption: string
}

export function CardVideoPlayer({ contactId, videoProjectId, url, poster, caption }: Props) {
  const viewSent = useRef(false)

  const sendEvent = (eventType: "view" | "pause" | "complete" | "cta_click", watchSeconds: number) => {
    if (!videoProjectId) return // nothing to attribute to — never fabricate an id
    try {
      void fetch("/api/video/engagement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // keepalive so a `complete` fired as the page unloads still lands.
        keepalive: true,
        body: JSON.stringify({
          videoProjectId,
          contactId,
          eventType,
          watchDurationSeconds: Math.max(0, Math.round(watchSeconds)),
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => null)
            console.error("[portal video] engagement event refused:", res.status, body?.error ?? "")
          }
        })
        .catch((err) => console.error("[portal video] engagement event failed:", err))
    } catch (err) {
      // Tracking must never break the player.
      console.error("[portal video] engagement event failed:", err)
    }
  }

  return (
    <div className="pt-2">
      <video
        controls
        poster={poster}
        className="w-full max-w-md rounded-lg border"
        onPlay={(e) => {
          if (viewSent.current) return
          viewSent.current = true
          sendEvent("view", e.currentTarget.currentTime)
        }}
        onPause={(e) => {
          const v = e.currentTarget
          // The browser fires `pause` at the natural end too — that moment is
          // `complete` (onEnded), not an agent-facing "they paused" signal.
          if (v.ended) return
          sendEvent("pause", v.currentTime)
        }}
        onEnded={(e) => sendEvent("complete", e.currentTarget.duration || e.currentTarget.currentTime)}
      >
        <source src={url} type="video/mp4" />
        <a
          href={url}
          className="text-blue-700 hover:underline"
          onClick={() => sendEvent("cta_click", 0)}
        >
          Watch the video from your agent
        </a>
      </video>
      <p className="text-[11px] text-muted-foreground pt-1 flex items-center gap-1">
        <Video className="h-3 w-3" />
        {caption}
      </p>
    </div>
  )
}
