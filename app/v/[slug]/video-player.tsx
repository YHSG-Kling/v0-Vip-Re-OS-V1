"use client"

import { useRef } from "react"
import { trackVideoView } from "@/app/actions/listing-video"
import { LandingVideo } from "@/app/components/public-site/LandingVideo"

/**
 * The public reel player, with the view counter attached.
 *
 * WHY THIS IS A CLIENT COMPONENT. `ai_video_projects.view_count` had a writer
 * (app/actions/listing-video.ts:trackVideoView) and no caller: nothing anywhere
 * in the tree ever recorded that a prospect watched a published reel, so the
 * column sat at 0 forever and the page could report reach for nobody. The count
 * has to be raised by the person watching, and this page is server-rendered, so
 * the play event needs a client boundary. That is all this file is.
 *
 * ONE VIEW PER MOUNT. `fired` guards the ref so scrubbing, pausing and resuming
 * do not each count as another view — `onPlay` fires on every resume. It is not
 * a dedupe across visitors or reloads; trackVideoView's own header records that
 * gap honestly (there is no viewer-fingerprint ledger yet) and this does not
 * pretend to close it.
 *
 * NO SESSION, DELIBERATELY. The watcher is a prospect with no account — that is
 * the whole point of a public reel. trackVideoView is unauthenticated by design
 * and defends itself: it refuses a non-uuid, refuses a project with no
 * video_url, and answers identically for "absent" and "not rendered" so it
 * cannot be used as an existence oracle.
 *
 * FAILURE IS SILENT FOR THE VIEWER. A counter that could not be raised must
 * never interrupt playback or put an error in front of a prospect; the refusal
 * is logged for us, and the video keeps playing.
 */
export function VideoPlayer({
  src,
  poster,
  projectId,
  title,
  youtubeUrl,
}: {
  src: string
  poster: string | null
  /** null when this page is serving a Remotion composition render, which has no
   *  view counter — no call is made rather than one against the wrong table. */
  projectId: string | null
  /** The reel's title — the slot's accessible name and its still when no poster exists. */
  title: string
  /** The reel's YouTube copy (ai_video_projects.video_metadata.youtube.url) — the slot's WORKING fallback when
   *  the file will not play. Null until published there; the page cannot link to itself. */
  youtubeUrl?: string | null
}) {
  const fired = useRef(false)

  function handlePlay() {
    if (!projectId || fired.current) return
    fired.current = true
    void trackVideoView(projectId).catch(() => {
      /* never surfaced to the viewer */
    })
  }

  // THE ONE SLOT (wave 143, lane 143F; the 142K open item). This page rendered its own bare <video>, so a file that
  // would not play left the browser's grey broken-media box on the very page the landing slot's fallback links to.
  // It now mounts the same LandingVideo every public surface uses: poster, no autoplay, and on a player error the
  // poster + a quiet line + (when the reel is on the channel) a link to its YouTube copy.
  return (
    <LandingVideo
      src={src}
      poster={poster}
      title={title}
      fallbackHref={youtubeUrl ?? null}
      onPlay={handlePlay}
      className="h-full w-full bg-black object-contain"
    />
  )
}
