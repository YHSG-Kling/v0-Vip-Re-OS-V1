"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Mic, MicOff, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

interface VoiceSessionButtonProps {
  agentId: string
  hasActiveSession: boolean
  isConfigured: boolean
}

export function VoiceSessionButton({
  agentId,
  hasActiveSession,
  isConfigured,
}: VoiceSessionButtonProps) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [result, setResult] = useState("")
  const [error, setError] = useState("")

  const handleStartVoice = async () => {
    if (!isConfigured) {
      setError("Voice assistant is not configured. Please set up in settings.")
      return
    }

    // Check for browser speech recognition support
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition

    if (!SpeechRecognition) {
      setError("Speech recognition is not supported in this browser.")
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = "en-US"

    recognition.onstart = () => {
      setIsListening(true)
      setTranscript("")
      setResult("")
      setError("")
    }

    recognition.onresult = (event: any) => {
      const current = event.resultIndex
      const transcriptResult = event.results[current][0].transcript
      setTranscript(transcriptResult)

      if (event.results[current].isFinal) {
        // Here you would typically send the command to your backend
        // For now, we'll just show the recognized text
        setResult(`Recognized: "${transcriptResult}"`)
      }
    }

    recognition.onerror = (event: any) => {
      setError(`Error: ${event.error}`)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognition.start()
  }

  const handleStopVoice = () => {
    setIsListening(false)
    // In a real implementation, you would stop the recognition here
  }

  return (
    <div className="space-y-3">
      <Button
        onClick={isListening ? handleStopVoice : handleStartVoice}
        disabled={!isConfigured}
        className={`w-full min-h-[64px] text-lg font-medium ${
          isListening
            ? "bg-red-500 hover:bg-red-600"
            : "bg-primary hover:bg-primary/90"
        }`}
      >
        {isListening ? (
          <>
            <Loader2 className="h-6 w-6 mr-2 animate-spin" />
            Listening...
          </>
        ) : (
          <>
            <Mic className="h-6 w-6 mr-2" />
            Start Voice Assistant
          </>
        )}
      </Button>

      {/* Transcript display */}
      {(transcript || result || error) && (
        <Card>
          <CardContent className="pt-4">
            {transcript && !result && (
              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-1">Hearing:</p>
                <p className="text-lg font-medium">&quot;{transcript}&quot;</p>
              </div>
            )}
            {result && (
              <div className="text-center">
                <p className="text-sm text-emerald-600 font-medium">{result}</p>
              </div>
            )}
            {error && (
              <div className="text-center">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!isConfigured && (
        <p className="text-xs text-center text-muted-foreground">
          Configure your voice assistant in settings to use this feature.
        </p>
      )}
    </div>
  )
}
