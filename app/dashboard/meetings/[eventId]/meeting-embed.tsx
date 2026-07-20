"use client"

// app/dashboard/meetings/[eventId]/meeting-embed.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE FULL IN-PAGE ZOOM EXPERIENCE (round 40) — the Meeting SDK Component
// (embedded) view mounted inside the meeting room pane, beside the context
// panel. Flow:
//   1. POST /api/meetings/sdk-signature { eventId } — the server mints the SDK
//      JWT (role 1 when the viewer is the event's owning agent, else 0) after
//      the SAME RLS access check the page itself uses.
//   2. Dynamic-import "@zoom/meetingsdk/embedded" — ONLY the framework-
//      agnostic Component-view client. NEVER the package root or the React
//      wrappers: their react peer is pinned to 18 and this repo runs React 19
//      (the package was installed with --legacy-peer-deps for exactly this
//      entry). The dynamic import also keeps the SDK out of SSR.
//   3. createClient() → init({ zoomAppRoot }) → join({ signature, ... }).
//   4. Unmount cleanup: leaveMeeting() then destroyClient().
//
// GRACEFUL DEGRADATION (keep-one): the signature route refusing (428 — SDK
// creds missing) or any join failure renders the EXTRACTED round-39 tier
// (ZoomJoinFallback) with the honest reason — the same component the server
// page renders when creds are known-missing. The join-launch button is also
// kept above the live embed, so an in-browser SDK failure never strands the
// user.
//
// OPS (see also lib/connections/zoom.ts SDK section): the Zoom app needs the
// Meeting SDK feature enabled, and its Domain Allow List must include the OS
// host — otherwise the SDK refuses to join in-browser and this component
// falls back honestly.

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ExternalLink, Loader2 } from "lucide-react"
import { ZoomJoinFallback } from "./join-fallback"

type Phase =
  | { kind: "connecting" }
  | { kind: "in-meeting" }
  | { kind: "fallback"; note: string }

export function MeetingEmbed({
  eventId,
  joinUrl,
  startUrl,
  isHost,
  userEmail,
}: {
  eventId: string
  joinUrl: string
  startUrl?: string | null
  isHost: boolean
  userEmail?: string | null
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" })

  useEffect(() => {
    let cancelled = false
    // Held for unmount cleanup: the embedded client + its module namespace.
    let cleanup: (() => void) | null = null

    async function mount() {
      // 1. Server-minted SDK JWT (auth + RLS + role resolution live there).
      let payload: {
        signature: string
        sdkKey: string
        meetingNumber: string
        password?: string
        userName: string
      }
      try {
        const res = await fetch("/api/meetings/sdk-signature", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId }),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          if (!cancelled) {
            setPhase({
              kind: "fallback",
              note:
                (body?.error as string | undefined) ??
                `Signature service refused (${res.status}) — using the join-launch tier.`,
            })
          }
          return
        }
        payload = body
      } catch {
        if (!cancelled) {
          setPhase({ kind: "fallback", note: "Could not reach the signature service — using the join-launch tier." })
        }
        return
      }
      const rootEl = rootRef.current
      if (cancelled || !rootEl) return

      // 2–3. The embedded Component-view client ONLY (never the package root).
      try {
        const mod = await import("@zoom/meetingsdk/embedded")
        const ZoomMtgEmbedded = mod.default
        const client = ZoomMtgEmbedded.createClient()
        cleanup = () => {
          try { void client.leaveMeeting() } catch { /* already left */ }
          try { ZoomMtgEmbedded.destroyClient() } catch { /* already destroyed */ }
        }
        await client.init({
          zoomAppRoot: rootEl,
          language: "en-US",
          patchJsMedia: true,
        })
        if (cancelled) return
        const joined = await client.join({
          signature: payload.signature,
          meetingNumber: payload.meetingNumber,
          userName: payload.userName,
          ...(payload.password ? { password: payload.password } : {}),
          ...(userEmail ? { userEmail } : {}),
        })
        // The SDK's ExecutedResult may RESOLVE with an ExecutedFailure instead
        // of rejecting — treat that as a failure too.
        if (joined && typeof joined === "object" && "reason" in joined) throw joined
        if (!cancelled) setPhase({ kind: "in-meeting" })
      } catch (e: any) {
        if (!cancelled) {
          const detail = e?.reason ?? e?.message ?? "the Zoom SDK refused to join in-browser"
          setPhase({
            kind: "fallback",
            note: `In-page Zoom could not start (${String(detail)}). Check that the Zoom app has the Meeting SDK feature enabled and this host on its domain allow list — using the join-launch tier meanwhile.`,
          })
        }
      }
    }

    void mount()
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [eventId, userEmail])

  if (phase.kind === "fallback") {
    return <ZoomJoinFallback joinUrl={joinUrl} startUrl={startUrl} isHost={isHost} note={phase.note} />
  }

  return (
    <>
      {/* The escape hatch stays even while embedded — Zoom in a browser tab
          always works, and hosts may prefer the native client. */}
      <div className="flex flex-wrap gap-2">
        <a href={joinUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm">
            <ExternalLink className="h-4 w-4 mr-2" />
            Open in Zoom instead
          </Button>
        </a>
        {isHost && startUrl && (
          <a href={startUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">Start as host (native)</Button>
          </a>
        )}
      </div>
      <div className="relative w-full rounded-lg border bg-muted/30 overflow-hidden" style={{ minHeight: 480 }}>
        {phase.kind === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting to Zoom…
          </div>
        )}
        {/* zoomAppRoot: the Meeting SDK renders the entire meeting UI here. */}
        <div ref={rootRef} className="relative z-10" />
      </div>
      <p className="text-xs text-muted-foreground">
        {isHost
          ? "You joined as the host (role 1) — this meeting runs fully inside the OS."
          : "You joined as an attendee — this meeting runs fully inside the OS."}
      </p>
    </>
  )
}
