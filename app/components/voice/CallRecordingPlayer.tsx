"use client"

import { useRef, useState } from "react"

/**
 * THE CALL RECORDING PLAYER.
 *
 * Two things were wrong with the player this replaces, and both were invisible
 * while `voice_calls.recording_url` had no writer:
 *
 *  1. IT COULD NOT RUN. The previous `AudioPlayer` / `AudioSpeedControls` lived
 *     inside app/dashboard/voice/review/[callId]/page.tsx — an async SERVER
 *     component with no "use client" — while attaching an `onClick` handler to
 *     its speed buttons. React cannot serialize an event handler onto a host
 *     element in a server component, so the first render with a non-null
 *     recording_url would have thrown. It never threw only because the column
 *     was always empty. Turning the producer on without this file would have replaced
 *     "no player" with "the review page 500s".
 *
 *  2. IT POINTED AT THE WRONG URL. Twilio serves recording media behind HTTP
 *     Basic auth, so `<audio src={recording_url}>` is a guaranteed 401. The
 *     `src` here is the authenticated same-origin proxy path
 *     (lib/voice/call-recording.ts:recordingPlaybackPath).
 *
 * Playback state is real React state rather than DOM poking, so the active
 * speed survives re-render.
 */

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const

export function CallRecordingPlayer({
  src,
  className,
}: {
  /** Same-origin proxy path — see recordingPlaybackPath. Never a vendor URL. */
  src: string
  className?: string
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [speed, setSpeed] = useState<number>(1)
  const [failed, setFailed] = useState<string | null>(null)

  function applySpeed(next: number) {
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  return (
    <div className={className ?? "space-y-3"}>
      <audio
        ref={audioRef}
        controls
        className="w-full"
        preload="metadata"
        src={src}
        onLoadedMetadata={() => {
          setFailed(null)
          if (audioRef.current) audioRef.current.playbackRate = speed
        }}
        // An unplayable recording says so. The alternative — a silent, dead
        // transport bar — is the failure mode that makes people think the
        // feature works and the call simply had no audio.
        onError={() =>
          setFailed(
            "This recording could not be loaded. It may still be processing at the telephony provider, or the brokerage's phone credentials may have changed.",
          )
        }
      >
        Your browser does not support the audio element.
      </audio>

      {failed ? (
        <p className="text-xs text-destructive">{failed}</p>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Playback speed:</span>
          <div className="flex gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => applySpeed(s)}
                aria-pressed={s === speed}
                className="px-2 py-1 text-xs rounded hover:bg-muted transition-colors data-[active=true]:bg-primary data-[active=true]:text-primary-foreground"
                data-active={s === speed}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default CallRecordingPlayer
