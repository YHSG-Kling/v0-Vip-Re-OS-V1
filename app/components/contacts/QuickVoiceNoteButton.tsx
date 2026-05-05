"use client"

/**
 * QuickVoiceNoteButton — single mic button that captures a dictation,
 * sends it to /api/contacts/{id}/voice-note, and toasts back what was
 * extracted (note + tasks). Designed to drop into a contact card or detail
 * header without re-rendering anything around it.
 *
 * Uses the browser's SpeechRecognition API (same approach as the existing
 * AvatarChatWidget) so it works on iOS Safari, Chrome desktop, and Edge.
 * Falls back to a textarea prompt when the API is missing.
 */

import { useCallback, useRef, useState } from "react"
import { Mic, MicOff, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

interface Props {
  contactId: string
  contactLabel?: string
  size?: "sm" | "md"
  onSaved?: () => void
}

export function QuickVoiceNoteButton({ contactId, contactLabel, size = "sm", onSaved }: Props) {
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const recRef = useRef<any>(null)

  const submit = useCallback(
    async (transcript: string) => {
      const trimmed = transcript.trim()
      if (!trimmed) return
      setBusy(true)
      try {
        const res = await fetch(`/api/contacts/${contactId}/voice-note`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: trimmed }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data?.error ?? "Couldn't save note")
          return
        }
        const taskCount = data?.tasks?.length ?? 0
        toast.success(
          taskCount > 0
            ? `Note saved + ${taskCount} task${taskCount === 1 ? "" : "s"} created.`
            : "Note saved.",
          { description: contactLabel },
        )
        onSaved?.()
      } catch {
        toast.error("Network error — note not saved")
      } finally {
        setBusy(false)
      }
    },
    [contactId, contactLabel, onSaved],
  )

  const start = useCallback(() => {
    if (busy || listening) return
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      const text = window.prompt(`Dictate a note${contactLabel ? ` for ${contactLabel}` : ""}:`)
      if (text) submit(text)
      return
    }
    const rec = new SpeechRecognition()
    rec.lang = "en-US"
    rec.interimResults = false
    rec.continuous = true
    let buffer = ""
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) buffer += e.results[i][0].transcript + " "
      }
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => {
      setListening(false)
      if (buffer.trim()) submit(buffer.trim())
    }
    rec.start()
    recRef.current = rec
    setListening(true)
  }, [busy, listening, submit, contactLabel])

  const stop = useCallback(() => {
    recRef.current?.stop?.()
    setListening(false)
  }, [])

  return (
    <Button
      type="button"
      size={size === "sm" ? "sm" : "default"}
      variant={listening ? "destructive" : "outline"}
      onClick={listening ? stop : start}
      disabled={busy}
      className="gap-1.5"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : listening ? (
        <MicOff className="h-3.5 w-3.5" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
      {listening ? "Stop" : "Voice note"}
    </Button>
  )
}
