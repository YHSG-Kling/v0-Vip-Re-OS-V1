"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, Volume2, Loader2, AlertCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

type VoiceState = "IDLE" | "LISTENING" | "PROCESSING" | "RESPONDING"

interface WakeWordCardProps {
  wakeName: string
  /** Called with recognized transcript when a command is fully spoken */
  onCommand: (transcript: string) => Promise<{ success: boolean; spoken_response?: string; text_response?: string }>
}

export function WakeWordCard({ wakeName, onCommand }: WakeWordCardProps) {
  const [state, setState] = useState<VoiceState>("IDLE")
  const [transcript, setTranscript] = useState("")
  const [response, setResponse] = useState("")
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [hasSpeechAPI, setHasSpeechAPI] = useState(true)
  const recognitionRef = useRef<any>(null)
  const wakeRecognitionRef = useRef<any>(null)

  // Check for browser support
  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)
    setHasSpeechAPI(supported)
  }, [])

  function getSpeechRecognition(): any | null {
    if (typeof window === "undefined") return null
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    return SR ? new SR() : null
  }

  // ── Wake-word continuous recognition ────────────────────────────────────
  useEffect(() => {
    if (!wakeEnabled || !hasSpeechAPI) {
      wakeRecognitionRef.current?.stop()
      wakeRecognitionRef.current = null
      return
    }

    function startWakeListen() {
      const rec = getSpeechRecognition()
      if (!rec) return
      rec.continuous = true
      rec.interimResults = true
      rec.lang = "en-US"

      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const text: string = e.results[i][0].transcript.toLowerCase().trim()
          const wakePhrase = `hey ${wakeName.toLowerCase()}`
          if (text.startsWith(wakePhrase) && state === "IDLE") {
            // Strip wake phrase and pass remaining text as command
            const commandText = text.replace(wakePhrase, "").trim()
            if (commandText) {
              activateWithText(commandText)
            } else {
              activateMic()
            }
          }
        }
      }

      rec.onend = () => {
        // Restart if still enabled and not actively listening
        if (wakeEnabled && state === "IDLE") {
          setTimeout(() => startWakeListen(), 300)
        }
      }

      rec.onerror = () => {
        setTimeout(() => startWakeListen(), 1000)
      }

      rec.start()
      wakeRecognitionRef.current = rec
    }

    startWakeListen()

    return () => {
      wakeRecognitionRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeEnabled, hasSpeechAPI, wakeName])

  function activateMic() {
    if (state !== "IDLE") return
    setState("LISTENING")
    setTranscript("")
    setResponse("")

    const rec = getSpeechRecognition()
    if (!rec) return
    rec.continuous = false
    rec.interimResults = true
    rec.lang = "en-US"

    rec.onresult = (e: any) => {
      const current = e.resultIndex
      const text: string = e.results[current][0].transcript
      setTranscript(text)
      if (e.results[current].isFinal) {
        processCommand(text)
      }
    }

    rec.onerror = () => setState("IDLE")
    rec.onend = () => {
      if ((state as string) === "LISTENING") setState("IDLE")
    }

    rec.start()
    recognitionRef.current = rec
  }

  function activateWithText(text: string) {
    setTranscript(text)
    processCommand(text)
  }

  function stopListening() {
    recognitionRef.current?.stop()
    setState("IDLE")
  }

  async function processCommand(text: string) {
    setState("PROCESSING")
    const result = await onCommand(text)
    if (result.spoken_response) {
      setState("RESPONDING")
      setResponse(result.text_response ?? result.spoken_response)
      speakText(result.spoken_response)
    } else {
      setState("IDLE")
      setResponse(result.text_response ?? "")
    }
  }

  function speakText(text: string) {
    if (!("speechSynthesis" in window)) {
      setState("IDLE")
      return
    }
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(text)
    utt.onend = () => setState("IDLE")
    utt.onerror = () => setState("IDLE")
    window.speechSynthesis.speak(utt)
  }

  function handleMicClick() {
    if (state === "IDLE") activateMic()
    else if (state === "LISTENING") stopListening()
  }

  // State display config
  const stateConfig = {
    IDLE: {
      micColor: "text-muted-foreground",
      borderColor: "border-border",
      pulse: false,
      label: `Say "Hey ${wakeName}" or tap the mic`,
    },
    LISTENING: {
      micColor: "text-blue-500",
      borderColor: "border-blue-500",
      pulse: true,
      label: "Listening...",
    },
    PROCESSING: {
      micColor: "text-amber-500",
      borderColor: "border-amber-400",
      pulse: false,
      label: "Processing...",
    },
    RESPONDING: {
      micColor: "text-green-500",
      borderColor: "border-green-500",
      pulse: true,
      label: "Responding...",
    },
  }

  const cfg = stateConfig[state]

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Wake-Word Activation</CardTitle>
          {wakeEnabled && (
            <Badge className="bg-blue-500/10 text-blue-600 border-blue-200 animate-pulse text-xs">
              Listening for "Hey {wakeName}"
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasSpeechAPI && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Voice recognition requires Chrome or Edge browser. VAPI calls work in all browsers.
            </span>
          </div>
        )}

        {/* State display */}
        <div className="flex flex-col items-center gap-4 py-2">
          <p className="text-xs text-muted-foreground text-center">{cfg.label}</p>

          {/* Big mic button */}
          <button
            onClick={handleMicClick}
            disabled={state === "PROCESSING" || !hasSpeechAPI}
            aria-label={state === "LISTENING" ? "Stop listening" : "Start listening"}
            className={cn(
              "relative h-20 w-20 rounded-full border-4 flex items-center justify-center transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              cfg.borderColor,
              "bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed",
              cfg.pulse && "animate-pulse"
            )}
          >
            {state === "PROCESSING" ? (
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            ) : state === "RESPONDING" ? (
              <Volume2 className={cn("h-8 w-8", cfg.micColor)} />
            ) : (
              <Mic className={cn("h-8 w-8", cfg.micColor)} />
            )}
          </button>

          {/* Transcript */}
          {transcript && (
            <div className="w-full rounded-md bg-muted p-3 text-sm">
              <p className="text-xs text-muted-foreground mb-1 font-medium">You said:</p>
              <p className="text-foreground italic">&ldquo;{transcript}&rdquo;</p>
            </div>
          )}

          {/* AI response */}
          {response && (
            <div className="w-full rounded-md bg-muted/50 border border-border p-3 text-sm">
              <p className="text-xs text-muted-foreground mb-1 font-medium">Assistant response:</p>
              <p className="text-foreground">{response}</p>
            </div>
          )}
        </div>

        {/* Wake-word toggle */}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <Label htmlFor="wake-toggle" className="text-xs text-muted-foreground cursor-pointer">
            Listen for &ldquo;Hey {wakeName}&rdquo;
          </Label>
          <Switch
            id="wake-toggle"
            checked={wakeEnabled}
            onCheckedChange={setWakeEnabled}
            disabled={!hasSpeechAPI}
          />
        </div>
      </CardContent>
    </Card>
  )
}
