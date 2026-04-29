"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Loader2, Mic, MicOff, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

interface AvatarChatWidgetProps {
  contactId: string
  agentName: string
  agentFirstName: string
  didPhotoUrl: string | null
  didVideoUrl: string | null
  onFallbackToText: () => void
}

export function AvatarChatWidget({
  contactId,
  agentName,
  agentFirstName,
  didPhotoUrl,
  didVideoUrl,
  onFallbackToText,
}: AvatarChatWidgetProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const [status, setStatus] = useState<"connecting" | "ready" | "speaking" | "error">("connecting")
  const [inputText, setInputText] = useState("")
  const [listening, setListening] = useState(false)
  const [messages, setMessages] = useState<{ role: "user" | "agent"; text: string }[]>([])

  // Determine source type: video clip > photo
  const sourceType: "photo" | "video" = didVideoUrl ? "video" : "photo"
  const sourceUrl = didVideoUrl ?? didPhotoUrl

  const initSession = useCallback(async () => {
    if (!sourceUrl) {
      fallback("No avatar configured for this agent.")
      return
    }
    try {
      const res = await fetch("/api/did/streams/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_type: sourceType, source_url: sourceUrl }),
      })
      if (!res.ok) {
        fallback("Live Agent video unavailable — switching to chat")
        return
      }
      const { sessionId, sdpOffer, iceServers } = await res.json()
      sessionIdRef.current = sessionId

      const pc = new RTCPeerConnection({ iceServers })
      pcRef.current = pc

      pc.ontrack = (e) => {
        if (videoRef.current && e.streams[0]) {
          videoRef.current.srcObject = e.streams[0]
        }
      }

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
          fallback("Connection lost — switching to chat")
        }
      }

      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: sdpOffer }))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      // Send SDP answer back
      await fetch("/api/did/streams/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, sdpAnswer: answer.sdp }),
      })

      setStatus("ready")
    } catch {
      fallback("Live Agent video unavailable — switching to chat")
    }
  }, [sourceUrl, sourceType])

  useEffect(() => {
    initSession()
    return () => {
      // Cleanup WebRTC session on unmount
      if (sessionIdRef.current) {
        fetch(`/api/did/streams/session?sessionId=${sessionIdRef.current}`, { method: "DELETE" }).catch(() => {})
      }
      pcRef.current?.close()
    }
  }, [initSession])

  function fallback(msg: string) {
    setStatus("error")
    toast.error(msg)
    setTimeout(onFallbackToText, 1200)
  }

  async function sendMessage(text: string) {
    if (!text.trim() || !sessionIdRef.current) return
    setMessages(prev => [...prev, { role: "user", text }])
    setInputText("")
    setStatus("speaking")

    try {
      // Get AI response
      const aiRes = await fetch("/api/portal/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, message: text }),
      })
      const aiData = aiRes.ok ? await aiRes.json() : null
      const agentReply = aiData?.reply ?? "Let me get back to you on that."
      setMessages(prev => [...prev, { role: "agent", text: agentReply }])

      // Send to D-ID avatar
      await fetch("/api/did/streams/talk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionIdRef.current, text: agentReply }),
      })
    } catch {
      toast.error("Couldn't reach the agent avatar")
    } finally {
      setStatus("ready")
    }
  }

  function toggleListening() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) { toast.error("Speech recognition not supported in this browser"); return }

    if (listening) {
      setListening(false)
      return
    }
    const rec = new SpeechRecognition()
    rec.lang = "en-US"
    rec.interimResults = false
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript
      sendMessage(transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    rec.start()
    setListening(true)
  }

  return (
    <div className="flex flex-col" style={{ height: 420 }}>
      {/* Video area — one-way, no camera */}
      <div className="relative bg-black flex items-center justify-center" style={{ height: 220 }}>
        {status === "connecting" && (
          <div className="flex flex-col items-center gap-2 text-white">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="text-xs">Connecting to {agentFirstName}…</span>
          </div>
        )}
        {status === "error" && (
          <p className="text-white text-xs">Redirecting to chat…</p>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`absolute inset-0 w-full h-full object-cover ${status === "connecting" ? "opacity-0" : "opacity-100"}`}
        />
        {status === "speaking" && (
          <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs rounded px-2 py-1">
            {agentFirstName} is responding…
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {messages.length === 0 && status === "ready" && (
          <p className="text-xs text-muted-foreground text-center py-2">
            Type or speak to talk with {agentFirstName}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p className={`text-xs rounded-lg px-3 py-1.5 max-w-[80%] ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {m.text}
            </p>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t px-3 py-2 flex gap-2">
        <Input
          className="h-8 text-sm"
          placeholder="Type a message…"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage(inputText)}
          disabled={status !== "ready"}
        />
        <Button size="sm" variant="ghost" onClick={toggleListening} disabled={status !== "ready"}>
          {listening ? <MicOff className="h-4 w-4 text-red-500" /> : <Mic className="h-4 w-4" />}
        </Button>
        <Button size="sm" onClick={() => sendMessage(inputText)} disabled={status !== "ready" || !inputText.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
