"use client"

import type React from "react"
import { useState, useRef } from "react"
import { Mic, Square, Loader2, CheckCircle2, AlertCircle } from "lucide-react"
import { executeWorkflow } from "@/app/actions/workflows"
import { useAuth } from "@/lib/auth/client"
import { toast } from "sonner"

interface VoiceCommandButtonProps {
  onNavigate?: (view: string) => void
}

export const VoiceCommandButton: React.FC<VoiceCommandButtonProps> = ({ onNavigate }) => {
  const { user } = useAuth()
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" })
        const base64Audio = await blobToBase64(audioBlob)
        await processVoiceCommand(base64Audio)
        stream.getTracks().forEach((track) => track.stop())
      }

      recorder.start()
      setMediaRecorder(recorder)
      setIsRecording(true)
      setResult(null)
    } catch (error) {
      toast.error("Microphone access denied or unavailable")
    }
  }

  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop()
      setIsRecording(false)
    }
  }

  const processVoiceCommand = async (audioBase64: string) => {
    setIsProcessing(true)
    try {
      const response = await executeWorkflow("processVoiceCommand", {
        userId: user?.id || "agent_1",
        audioData: audioBase64,
      })
      if (response?.success) {
        setTranscript(response.transcript || "Command received.")
        setResult({ success: true, message: response.actionTaken || "Command executed." })

        // Handle navigation commands
        if (response.navigateTo && onNavigate) {
          onNavigate(response.navigateTo)
        }

        // Clear after delay
        setTimeout(() => {
          setTranscript("")
          setResult(null)
          setIsProcessing(false)
        }, 4000)
      } else {
        setResult({ success: false, message: "Could not resolve command intent." })
        setIsProcessing(false)
      }
    } catch (error) {
      setResult({ success: false, message: "Voice network error." })
      setIsProcessing(false)
    }
  }

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        resolve(result.split(",")[1])
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  return (
    <div className="fixed bottom-6 right-6 z-[300] flex flex-col items-end gap-3 pointer-events-none">
      {/* Visual Feedback Overlays */}
      {(isRecording || isProcessing || result || transcript) && (
        <div className="pointer-events-auto mb-4 w-full max-w-sm flex flex-col gap-2 animate-fade-in-up">
          {isRecording && (
            <div className="bg-red-600 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-pulse border-2 border-red-400">
              <div className="w-2 h-2 rounded-full bg-white animate-ping" />
              <span className="text-[10px] font-black uppercase tracking-widest text-white">
                Listening Hands-Free...
              </span>
            </div>
          )}

          {isProcessing && !result && (
            <div className="bg-slate-900 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border-2 border-slate-700">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-white">
                AI Synthesis Engine Running...
              </span>
            </div>
          )}

          {transcript && (
            <div className="bg-white border border-slate-200 text-slate-800 px-5 py-3 rounded-2xl shadow-xl">
              <p className="text-[9px] font-black text-indigo-500 uppercase tracking-widest mb-1">You Said:</p>
              <p className="text-xs font-bold italic">"{transcript}"</p>
            </div>
          )}

          {result && (
            <div
              className={`px-5 py-3 rounded-2xl shadow-xl flex items-center gap-3 ${result.success ? "bg-emerald-600 text-white border-2 border-emerald-400" : "bg-red-600 text-white border-2 border-red-400"}`}
            >
              {result.success ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              <span className="text-xs font-bold">{result.message}</span>
            </div>
          )}
        </div>
      )}

      {/* Mic Button - position adjusted to not overlap with AI FAB */}
      <button
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing}
        className={`pointer-events-auto w-12 h-12 rounded-2xl shadow-xl flex items-center justify-center transition-all transform hover:scale-105 active:scale-95 mr-20 ${
          isRecording
            ? "bg-red-600 text-white animate-pulse ring-4 ring-red-200"
            : isProcessing
              ? "bg-slate-600 text-slate-300"
              : "bg-white text-slate-700 border border-slate-200 hover:bg-indigo-50 hover:text-indigo-600"
        }`}
      >
        {isProcessing ? (
          <Loader2 size={20} className="animate-spin" />
        ) : isRecording ? (
          <Square size={20} fill="currentColor" />
        ) : (
          <Mic size={20} />
        )}
      </button>
    </div>
  )
}
