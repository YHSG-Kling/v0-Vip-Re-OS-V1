"use client"

/**
 * LandingVideo — THE ONE VIDEO SLOT every public landing page renders (wave 142, lane 142F).
 *
 * OWNER (2026-10-18): "a landing page should include some type of video" — with a
 * functional fallback (poster / still / text), NEVER a broken player.
 *
 * Before this component each public page wrote its own bare `<video src>`: the lead-magnet
 * page (app/lm/[slug]) with no poster and no error handling, the listing page
 * (app/listings/[listingId]) with a poster and no error handling, the listing hero's
 * dialog with neither, and the storefront (app/site/[slug]) with no slot at all. A source
 * that 404s (a re-hosted file deleted, a bucket reclassified, a provider URL expired) left
 * the browser's grey broken-media box on a page a prospect is reading.
 *
 * ONE RULE, here: a `<video>` is rendered only with a real `src`; on `onError` the player
 * is replaced by the poster image when one exists, else a quiet still with a line of text
 * and, when the caller has one, a link to the video's own page (/v/<slug>) — so the
 * visitor always has somewhere to go. A missing `src` renders the fallback directly.
 * No autoplay by default (a landing page should not start sound on load); the listing
 * hero's dialog opts in because the visitor pressed Play.
 *
 * Client component because `onError` needs a boundary; the pages stay server-rendered.
 */
import { useState } from "react"

interface LandingVideoProps {
  src: string | null | undefined
  poster?: string | null
  title: string
  /** Where the visitor can still watch when the inline player cannot play (e.g. /v/<slug>). */
  fallbackHref?: string | null
  className?: string
  autoPlay?: boolean
}

export function LandingVideo({ src, poster, title, fallbackHref, className, autoPlay }: LandingVideoProps) {
  const [failed, setFailed] = useState(false)
  const playable = typeof src === "string" && src.trim().length > 0 && !failed

  if (!playable) {
    return (
      <div
        role="img"
        aria-label={`${title} (video unavailable)`}
        className={`relative overflow-hidden rounded-xl border bg-muted ${className ?? ""}`}
        data-landing-video-fallback="true"
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt={title} className="w-full h-full object-cover" />
        ) : (
          <div className="aspect-video w-full flex items-center justify-center">
            <span className="text-sm text-muted-foreground px-4 text-center">{title}</span>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-xs text-white flex items-center justify-between gap-3">
          <span>This video is not available to play right now.</span>
          {fallbackHref && (
            <a href={fallbackHref} className="underline underline-offset-2 whitespace-nowrap">Watch it here</a>
          )}
        </div>
      </div>
    )
  }

  return (
    <video
      controls
      playsInline
      preload="metadata"
      autoPlay={autoPlay ?? false}
      poster={poster ?? undefined}
      src={src as string}
      aria-label={title}
      onError={() => setFailed(true)}
      className={className}
      data-landing-video="true"
    />
  )
}
