"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Mic, MicOff, Volume2, Settings, X } from "lucide-react"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { processVoiceCommand, startVoiceSession, endVoiceSession, getVoiceConfig } from "@/app/actions"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function VoiceAssistant() {
  const { user } = useAuth()
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [response, setResponse] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [config, setConfig] = useState<any>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [minimized, setMinimized] = useState(true)
  const [agentId, setAgentId] = useState<string | null>(null)

  const recognitionRef = useRef<any>(null)

  useEffect(() => {
    if (user) {
      loadAgentAndConfig()
    }
  }, [user])

  async function loadAgentAndConfig() {
    if (!user?.id) return
    const supabase = createClient()
    const resolvedAgentId = await resolveAgentId(supabase, user.id)
    setAgentId(resolvedAgentId)
    if (resolvedAgentId) {
      const result = await getVoiceConfig(resolvedAgentId)
      if (result.success) {
        setConfig(result.config)
      }
    }
  }

  async function startListening() {
    if (!agentId) return

    // Start session if not already started
    if (!sessionId) {
      const sessionResult = await startVoiceSession(agentId, {
        location: "mobile",
        timestamp: new Date().toISOString(),
      })
      if (sessionResult.success) {
        setSessionId(sessionResult.sessionId!)
      }
    }

    setListening(true)
    setMinimized(false)

    // Use Web Speech API (free, works in most browsers)
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
      recognitionRef.current = new SpeechRecognition()

      recognitionRef.current.continuous = false
      recognitionRef.current.interimResults = true
      recognitionRef.current.lang = "en-US"

      recognitionRef.current.onresult = (event: any) => {
        const current = event.resultIndex
        const transcriptText = event.results[current][0].transcript
        setTranscript(transcriptText)

        // If final result, process command
        if (event.results[current].isFinal) {
          handleVoiceCommand(transcriptText)
        }
      }

      recognitionRef.current.onerror = (event: any) => {
        console.error("[VoiceAssistant] Speech recognition error:", event.error)
        setListening(false)
      }

      recognitionRef.current.onend = () => {
        setListening(false)
      }

      recognitionRef.current.start()
    } else {
      alert("Voice recognition is not supported in your browser. Please use Chrome or Edge.")
      setListening(false)
    }
  }

  function stopListening() {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
    setListening(false)
  }

  async function handleVoiceCommand(text: string) {
    if (!agentId) return

    setTranscript(text)
    setSpeaking(true)

    // Process command via server action
    const result = await processVoiceCommand({
      agentId,
      commandText: text,
      sessionId: sessionId || undefined,
      context: {
        location: "mobile",
        timestamp: new Date().toISOString(),
      },
    })

    setResponse(result.response || "")

    // Speak response using Web Speech API
    if (result.success && result.response) {
      speakResponse(result.response)
    }

    setSpeaking(false)
  }

  function speakResponse(text: string) {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = config?.voice_speed || 1.0
      utterance.pitch = 1.0
      utterance.voice = window.speechSynthesis.getVoices().find((v) => v.name.includes(config?.voice_type === "male" ? "Male" : "Female")) || null

      window.speechSynthesis.speak(utterance)
    }
  }

  async function handleEndSession() {
    if (sessionId) {
      await endVoiceSession(sessionId)
      setSessionId(null)
    }
    setTranscript("")
    setResponse("")
    setMinimized(true)
  }

  if (!user || !config?.voice_enabled) return null

  return (
    <>
      {/* Floating voice button */}
      <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2">
        {!minimized && (
          <Card className="w-80 shadow-xl">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Voice Assistant</CardTitle>
                <div className="flex gap-1">
                  <Dialog open={showSettings} onOpenChange={setShowSettings}>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6">
                        <Settings className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Voice Assistant Settings</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <Label>Voice Type</Label>
                          <Select defaultValue={config?.voice_type || "female"}>
                            <SelectTrigger className="w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="female">Female</SelectItem>
                              <SelectItem value="male">Male</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between">
                          <Label>Proactive Alerts</Label>
                          <Switch checked={config?.proactive_alerts || false} />
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleEndSession}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {transcript && (
                <div className="text-sm">
                  <Badge variant="outline" className="mb-1">
                    You said:
                  </Badge>
                  <p className="text-muted-foreground">{transcript}</p>
                </div>
              )}
              {response && (
                <div className="text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    {speaking && <Volume2 className="h-4 w-4 animate-pulse text-primary" />}
                    <Badge variant="secondary">Assistant:</Badge>
                  </div>
                  <p className="text-foreground">{response}</p>
                </div>
              )}
              {!transcript && !response && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {listening ? "Listening..." : "Tap the mic to start"}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Button
          size="lg"
          className={`rounded-full h-16 w-16 shadow-lg transition-all ${
            listening ? "animate-pulse bg-red-500 hover:bg-red-600" : "bg-primary hover:bg-primary/90"
          }`}
          onClick={listening ? stopListening : startListening}
        >
          {listening ? <Mic className="h-8 w-8" /> : <MicOff className="h-8 w-8" />}
        </Button>
      </div>
    </>
  )
}
