"use client"

/**
 * LiveKitAssistantWidget — Phase A on-the-go AI talking assistant.
 *
 * Connects the user's browser/device to a private LiveKit room. A separate
 * agent worker (see `agent-worker/livekit-agent.ts`) auto-dispatches into the
 * same room and runs the STT → LLM → TTS pipeline using the agent's cloned
 * ElevenLabs voice. The widget itself only renders mic state, transcript,
 * and the agent's voice — there is no video track in Phase A.
 *
 * This widget is ADDITIVE:
 *   - The existing D-ID `AvatarChatWidget` continues to power the talking-
 *     avatar chat experience (face-on-camera).
 *   - The existing VAPI ISA stack continues to handle outbound/inbound
 *     phone calls.
 *   - LiveKit is a third, parallel transport for hands-free voice
 *     interaction with the agent's own AI assistant.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client"

type ConnectionState = "idle" | "connecting" | "connected" | "ending" | "error"

interface LiveKitAssistantWidgetProps {
  /** Optional contact context — surfaced to the agent worker via room metadata. */
  contactId?: string
  /** Optional extra context (current listing, current buyer, etc). */
  context?: Record<string, unknown>
  /** Called when the user explicitly ends the session. */
  onEnd?: () => void
}

interface TranscriptLine {
  role: "user" | "assistant"
  text: string
  ts: number
}

export function LiveKitAssistantWidget({
  contactId,
  context,
  onEnd,
}: LiveKitAssistantWidgetProps) {
  const roomRef = useRef<Room | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)

  const [state, setState] = useState<ConnectionState>("idle")
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      roomRef.current?.disconnect().catch(() => {})
      roomRef.current = null
    }
  }, [])

  const handleDataMessage = useCallback((payload: Uint8Array) => {
    try {
      const text = new TextDecoder().decode(payload)
      const msg = JSON.parse(text) as { type?: string; role?: string; text?: string }
      if (msg.type === "transcript" && (msg.role === "user" || msg.role === "assistant") && msg.text) {
        setTranscript((prev) => [...prev, { role: msg.role as "user" | "assistant", text: msg.text!, ts: Date.now() }])
      }
    } catch {
      // ignore non-JSON data messages
    }
  }, [])

  const connect = useCallback(async () => {
    setState("connecting")
    setTranscript([])

    let tokenRes: Response
    try {
      tokenRes = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "assistant", contactId, context }),
      })
    } catch (err: any) {
      setState("error")
      toast.error("Couldn't reach the assistant")
      return
    }

    if (!tokenRes.ok) {
      setState("error")
      const data = await tokenRes.json().catch(() => ({}))
      toast.error(data?.error ?? "Assistant unavailable")
      return
    }

    const { token, url } = (await tokenRes.json()) as { token: string; url: string }

    const room = new Room({ adaptiveStream: true, dynacast: true })
    roomRef.current = room

    room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      _pub: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach() as HTMLAudioElement
        el.autoplay = true
        el.style.display = "none"
        document.body.appendChild(el)
        audioElRef.current = el
      }
    })

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove())
      if (audioElRef.current && !document.body.contains(audioElRef.current)) {
        audioElRef.current = null
      }
    })

    room.on(RoomEvent.DataReceived, (payload) => handleDataMessage(payload))

    room.on(RoomEvent.Disconnected, () => {
      setState("idle")
    })

    try {
      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMuted(false)
      setState("connected")
    } catch (err: any) {
      console.error("[livekit] connect failed:", err)
      setState("error")
      toast.error("Couldn't join the assistant room")
      roomRef.current = null
    }
  }, [contactId, context, handleDataMessage])

  const disconnect = useCallback(async () => {
    setState("ending")
    try {
      await roomRef.current?.disconnect()
    } catch {
      // best-effort
    }
    roomRef.current = null
    if (audioElRef.current) {
      audioElRef.current.remove()
      audioElRef.current = null
    }
    setState("idle")
    onEnd?.()
  }, [onEnd])

  const toggleMute = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next = !muted
    await room.localParticipant.setMicrophoneEnabled(!next)
    setMuted(next)
  }, [muted])

  const isConnected = state === "connected"
  const isBusy = state === "connecting" || state === "ending"

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-sm">AI Assistant</p>
          <p className="text-xs text-muted-foreground">
            {state === "idle" && "Hands-free, on-the-go."}
            {state === "connecting" && "Connecting…"}
            {state === "connected" && (muted ? "Muted." : "Listening — speak naturally.")}
            {state === "ending" && "Ending session…"}
            {state === "error" && "Connection error."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isConnected ? (
            <Button size="sm" onClick={connect} disabled={isBusy}>
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
              <span className="ml-1.5">Start</span>
            </Button>
          ) : (
            <>
              <Button size="sm" variant={muted ? "destructive" : "outline"} onClick={toggleMute}>
                {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
              <Button size="sm" variant="destructive" onClick={disconnect} disabled={isBusy}>
                <PhoneOff className="h-4 w-4" />
                <span className="ml-1.5">End</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {transcript.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded border bg-muted/40 p-2 space-y-1.5">
          {transcript.map((line, i) => (
            <div key={i} className="text-xs leading-snug">
              <span
                className={
                  line.role === "user" ? "font-medium text-foreground" : "font-medium text-primary"
                }
              >
                {line.role === "user" ? "You" : "Assistant"}:
              </span>{" "}
              <span className="text-foreground/90">{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
