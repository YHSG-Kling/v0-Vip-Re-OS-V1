"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import { GoogleGenAI, type LiveServerMessage, Modality, type Blob } from "@google/genai"
import {
  Mic,
  Map,
  Globe,
  X,
  Send,
  Bot,
  Loader2,
  Sparkles,
  Zap,
  DollarSign,
  ArrowRight,
  Calendar,
  Copy,
} from "lucide-react"
import { n8nService } from "../../services/n8n"
import { useAuth } from "../../contexts/AuthContext"
import { UserRole } from "../../types"

interface Message {
  role: "user" | "model"
  text: string
  sources?: { title: string; uri: string }[]
  isThinking?: boolean
  // Workflow 7: Action Chip
  action?: {
    type: "lender_referral" | "schedule_slot"
    label: string
    data: any
  }
}

// Simple Audio Processing Helper
function createBlob(data: Float32Array): Blob {
  const l = data.length
  const int16 = new Int16Array(l)
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768
  }
  const uint8 = new Uint8Array(int16.buffer)

  // Custom simple base64 encoding to avoid external lib dependency issues in this environment
  let binary = ""
  const len = uint8.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  const base64Data = btoa(binary)

  return {
    data: base64Data,
    mimeType: "audio/pcm;rate=16000",
  }
}

function decode(base64: string) {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

const NexusAssistant: React.FC = () => {
  const { role } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [mode, setMode] = useState<"chat" | "live">("chat")
  const [chatModel, setChatModel] = useState<"expert" | "fast" | "web" | "maps">("expert")
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "model",
      text: "Hello! I am Smart Engine AI. I can help with market research, property queries, or general tasks.",
    },
  ])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isLiveConnected, setIsLiveConnected] = useState(false)

  // Copilot State (Workflow 8)
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ strategy: string; script: string } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Live API Refs
  const audioContextRef = useRef<AudioContext | null>(null)
  const inputContextRef = useRef<AudioContext | null>(null)
  const nextStartTimeRef = useRef<number>(0)
  const sessionPromiseRef = useRef<Promise<any> | null>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Workflow 7: Trigger the N8N Workflow from the UI Action
  const handleLenderReferral = async (actionData: any) => {
    setMessages((prev) => [...prev, { role: "model", text: "Initiating 3-way intro with the best lender match..." }])

    await n8nService.triggerLenderReferral(
      "current-lead-id", // In real app, get from context
      "Current User",
      "user@example.com",
      actionData.budget || 500000,
      actionData.context,
    )

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "model",
          text: `✅ Done! I've sent a warm intro email connecting you with ${actionData.budget > 1000000 ? "Luxury Lending Co" : "Standard Mortgage LLC"}. Check your sent items.`,
        },
      ])
    }, 1500)
  }

  // Workflow 9: Book the slot
  const handleBookSlot = async (slot: string) => {
    setMessages((prev) => [...prev, { role: "user", text: `Let's do ${slot}` }])
    setIsLoading(true)

    // Simulate booking
    const result = await n8nService.bookSlot(slot, "Current User")

    setTimeout(() => {
      setIsLoading(false)
      setMessages((prev) => [
        ...prev,
        {
          role: "model",
          text: `Confirmed! I've sent a calendar invite for ${slot}.`,
          action: { type: "schedule_slot", label: "View Calendar", data: { link: result.link } }, // Reuse for view
        },
      ])
    }, 1000)
  }

  const handleSend = async () => {
    if (!input.trim() || !process.env.API_KEY) return

    const userMsg = input
    setInput("")
    setCopilotSuggestion(null) // Clear previous suggestions
    setMessages((prev) => [...prev, { role: "user", text: userMsg }])
    setIsLoading(true)

    // Workflow 8: Objection Detection (RAG Simulation)
    // Run in parallel with AI generation for speed
    if (role === UserRole.AGENT) {
      n8nService.handleObjection(userMsg).then((suggestion) => {
        if (suggestion) {
          setCopilotSuggestion(suggestion)
        }
      })
    }

    // Workflow 7 Node 1: Intent Detection (Client-side simulation or via LLM tool)
    const financingKeywords = ["mortgage", "rate", "loan", "lender", "finance", "pre-approval", "payment"]
    const isFinancingIntent = financingKeywords.some((kw) => userMsg.toLowerCase().includes(kw))

    // Workflow 9: Scheduling Intent
    const scheduleKeywords = ["meet", "schedule", "book", "time", "call", "appointment"]
    const isScheduleIntent = scheduleKeywords.some((kw) => userMsg.toLowerCase().includes(kw))

    try {
      // Create a new GoogleGenAI instance right before making an API call to ensure it always uses the most up-to-date API key.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY })
      let modelName = ""
      let tools: any[] = []
      let thinkingConfig: any = undefined

      // Select Model & Config based on "Sub-mode"
      // Guidelines: gemini pro: 'gemini-3-pro-preview', basic tasks: 'gemini-3-flash-preview', lite: 'gemini-flash-lite-latest'.
      if (chatModel === "expert") {
        modelName = "gemini-3-pro-preview"
        thinkingConfig = { thinkingBudget: 1024 } // Enable thinking for complex tasks
      } else if (chatModel === "fast") {
        modelName = "gemini-flash-lite-latest"
      } else if (chatModel === "web") {
        modelName = "gemini-3-flash-preview"
        tools = [{ googleSearch: {} }]
      } else if (chatModel === "maps") {
        // Maps grounding is only supported in Gemini 2.5 series models.
        modelName = "gemini-2.5-flash"
        tools = [{ googleMaps: {} }]
      }

      const systemInstruction =
        role !== UserRole.AGENT
          ? `You are a real estate AI assistant following the THEM-FIRST philosophy.

CRITICAL RULES FOR ALL RESPONSES:
- Focus 80-90% on the USER and their needs, NOT the agent/company
- Use "you" and "your" extensively (aim for 15%+ of words)
- Minimize "I", "me", "we", "our" to under 10%
- Start with THEIR situation or question, not credentials
- Ask understanding questions about THEIR needs
- Show empathy for THEIR concerns and emotions
- Lead with what matters to THEM, not what you offer
- Make them feel UNDERSTOOD first, then offer help

BAD: "I can help you with that. We have great services."
GOOD: "Your situation sounds important. What matters most to you - timeline or price?"

Answer their questions while keeping the focus on their needs and perspective.`
          : undefined

      const requestConfig: any = {
        model: modelName,
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
      }

      if (systemInstruction) {
        requestConfig.systemInstruction = systemInstruction
      }

      if (tools.length > 0) {
        requestConfig.config = { tools }
      }
      if (thinkingConfig) {
        requestConfig.config = { ...requestConfig.config, thinkingConfig }
      }

      // If using Maps, add location context if available
      if (chatModel === "maps" && navigator.geolocation) {
        try {
          const position = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject)
          })
          requestConfig.config.toolConfig = {
            retrievalConfig: {
              latLng: {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
              },
            },
          }
        } catch (e) {
          console.warn("Geolocation not available", e)
        }
      }

      const result = await ai.models.generateContent(requestConfig)

      // Generating text output is accessed via the .text property
      const text = result.text || "I couldn't generate a response."

      // Workflow 10: Confidence Check & Handoff
      // Simulating confidence score since standard API doesn't always return it explicitly in this wrapper
      const simulatedConfidence = Math.random()

      if (simulatedConfidence < 0.3) {
        // Low confidence threshold
        await n8nService.escalateLowConfidence("Current User", userMsg, text, simulatedConfidence)
        setMessages((prev) => [
          ...prev,
          {
            role: "model",
            text: "That's a great specific question. I want to make sure I give you the 100% correct answer, so I've flagged this for your Senior Agent. They will reach out shortly!",
          },
        ])
        return // Stop normal flow
      }

      // Extract Grounding Metadata
      const sources: { title: string; uri: string }[] = []
      const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks
      if (chunks) {
        chunks.forEach((chunk: any) => {
          if (chunk.web) sources.push({ title: chunk.web.title, uri: chunk.web.uri })
          if (chunk.maps) sources.push({ title: chunk.maps.title, uri: chunk.maps.uri })
        })
      }

      // Workflow 7: Inject Smart Action if intent matches
      let action = undefined
      if (isFinancingIntent) {
        action = {
          type: "lender_referral",
          label: "Connect with Preferred Lender",
          data: { context: userMsg, budget: 850000 }, // budget mocked or extracted
        }
      }

      // Workflow 9: Inject Calendar Slots
      if (isScheduleIntent) {
        const slots = await n8nService.checkAvailability()
        // We can append this to the message or use the action chip
        action = {
          type: "schedule_slot",
          label: "Book a Time",
          data: { slots },
        }
      }

      setMessages((prev) => [...prev, { role: "model", text, sources, action: action as any }])
    } catch (error) {
      console.error(error)
      setMessages((prev) => [
        ...prev,
        { role: "model", text: "Sorry, I encountered an error. Please check your API key." },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  const startLiveSession = async () => {
    if (!process.env.API_KEY) {
      alert("API Key missing")
      return
    }

    setIsLiveConnected(true)
    // Create a new GoogleGenAI instance right before making an API call to ensure it always uses the most up-to-date API key.
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY })

    inputContextRef.current = new ((window.AudioContext as any) || (window as any).webkitAudioContext)({
      sampleRate: 16000,
    })
    audioContextRef.current = new ((window.AudioContext as any) || (window as any).webkitAudioContext)({
      sampleRate: 24000,
    })
    nextStartTimeRef.current = audioContextRef.current.currentTime

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    const systemInstruction =
      role !== UserRole.AGENT
        ? `You are a helpful real estate voice assistant. Follow the THEM-FIRST philosophy:
- Focus on THEIR needs and situation (80-90% of conversation)
- Use "you" and "your" frequently
- Minimize "I", "me", "we" language
- Ask understanding questions
- Show empathy for their concerns
- Keep responses conversational and prospect-focused`
        : undefined

    const sessionPromise = ai.live.connect({
      model: "gemini-2.5-flash-native-audio-preview-09-2025",
      systemInstruction,
      callbacks: {
        onopen: () => {
          console.log("Live Session Opened")
          // Setup Audio Stream
          if (!inputContextRef.current) return
          const source = inputContextRef.current.createMediaStreamSource(stream)
          const processor = inputContextRef.current.createScriptProcessor(4096, 1, 1)

          processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0)
            const blob = createBlob(inputData)
            sessionPromiseRef.current?.then((session) => {
              session.sendRealtimeInput({ media: blob })
            })
          }

          source.connect(processor)
          processor.connect(inputContextRef.current.destination)
        },
        onmessage: async (msg: LiveServerMessage) => {
          // Playback audio - decoding raw PCM bytes from modelTurn parts
          const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data
          if (audioData && audioContextRef.current) {
            const binary = decode(audioData)

            // Decode raw PCM
            const float32 = new Float32Array(binary.length / 2)
            const dataView = new DataView(binary.buffer)
            for (let i = 0; i < binary.length / 2; i++) {
              float32[i] = dataView.getInt16(i * 2, true) / 32768
            }

            const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000)
            buffer.getChannelData(0).set(float32)

            const source = audioContextRef.current.createBufferSource()
            source.buffer = buffer
            source.connect(audioContextRef.current.destination)

            // Gapless scheduling using nextStartTimeRef running timestamp
            const now = audioContextRef.current.currentTime
            const start = Math.max(now, nextStartTimeRef.current)
            source.start(start)
            nextStartTimeRef.current = start + buffer.duration
          }
        },
        onclose: () => {
          console.log("Live Session Closed")
          setIsLiveConnected(false)
        },
        onerror: (err) => {
          console.error("Live Error", err)
          setIsLiveConnected(false)
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
        },
      },
    })
    sessionPromiseRef.current = sessionPromise
  }

  const stopLiveSession = () => {
    inputContextRef.current?.close()
    audioContextRef.current?.close()
    setIsLiveConnected(false)
    sessionPromiseRef.current = null
  }

  return (
    <>
      {/* Floating Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 h-14 w-14 bg-indigo-600 rounded-full shadow-xl flex items-center justify-center text-white hover:bg-indigo-700 hover:scale-105 transition-all z-50"
      >
        {isOpen ? <X size={24} /> : <Sparkles size={24} />}
      </button>

      {/* Main Panel */}
      {isOpen && (
        <div className="fixed bottom-24 right-6 w-96 h-[600px] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col z-50 overflow-hidden animate-fade-in-up">
          {/* Header */}
          <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <Bot size={20} className="text-indigo-400" />
              <h3 className="font-bold">Smart Engine AI</h3>
            </div>
            <div className="flex bg-slate-800 rounded-lg p-1">
              <button
                onClick={() => setMode("chat")}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${mode === "chat" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"}`}
              >
                Chat
              </button>
              <button
                onClick={() => setMode("live")}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${mode === "live" ? "bg-red-500 text-white" : "text-slate-400 hover:text-white"}`}
              >
                Live Voice
              </button>
            </div>
          </div>

          {/* Workflow 8: Copilot Sidebar (Slide-down) */}
          {copilotSuggestion && role === UserRole.AGENT && (
            <div className="bg-amber-50 border-b border-amber-200 p-3 animate-slide-in-top">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles size={14} className="text-amber-600" />
                <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">
                  Copilot Suggestion: {copilotSuggestion.strategy}
                </span>
              </div>
              <p className="text-xs text-amber-900 mb-2 italic">"{copilotSuggestion.script}"</p>
              <button
                onClick={() => {
                  setInput(copilotSuggestion.script)
                  setCopilotSuggestion(null)
                }}
                className="w-full bg-white border border-amber-300 text-amber-700 py-1.5 rounded text-xs font-bold hover:bg-amber-100 flex items-center justify-center gap-1"
              >
                <Copy size={12} /> Use this Script
              </button>
            </div>
          )}

          {/* Chat Mode */}
          {mode === "chat" && (
            <div className="flex-1 flex flex-col">
              {/* Model Selector */}
              <div className="flex gap-2 p-2 border-b border-slate-100 bg-slate-50 overflow-x-auto">
                <button
                  onClick={() => setChatModel("expert")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${chatModel === "expert" ? "bg-indigo-100 border-indigo-200 text-indigo-700" : "bg-white border-slate-200 text-slate-600"}`}
                >
                  <Sparkles size={12} /> Expert (Pro 3)
                </button>
                <button
                  onClick={() => setChatModel("fast")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${chatModel === "fast" ? "bg-orange-100 border-orange-200 text-orange-700" : "bg-white border-slate-200 text-slate-600"}`}
                >
                  <Zap size={12} /> Fast (Lite)
                </button>
                <button
                  onClick={() => setChatModel("web")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${chatModel === "web" ? "bg-blue-100 border-blue-200 text-blue-700" : "bg-white border-slate-200 text-slate-600"}`}
                >
                  <Globe size={12} /> Web Search
                </button>
                <button
                  onClick={() => setChatModel("maps")}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border ${chatModel === "maps" ? "bg-emerald-100 border-emerald-200 text-emerald-700" : "bg-white border-slate-200 text-slate-600"}`}
                >
                  <Map size={12} /> Maps
                </button>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl p-3 text-sm ${msg.role === "user" ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-700 shadow-sm"}`}
                    >
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-slate-100">
                          <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Sources</p>
                          <div className="flex flex-wrap gap-1">
                            {msg.sources.map((s, idx) => (
                              <a
                                key={idx}
                                href={s.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] bg-slate-100 text-indigo-600 px-2 py-1 rounded hover:underline truncate max-w-full block"
                              >
                                {s.title || s.uri}
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Workflow 7 Action Chip */}
                    {msg.action && msg.action.type === "lender_referral" && (
                      <button
                        onClick={() => handleLenderReferral(msg.action?.data)}
                        className="mt-2 ml-1 bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-emerald-100 transition-colors flex items-center gap-2 shadow-sm"
                      >
                        <DollarSign size={14} /> {msg.action.label} <ArrowRight size={12} />
                      </button>
                    )}
                    {/* Workflow 9 Calendar Chip */}
                    {msg.action && msg.action.type === "schedule_slot" && msg.action.data.slots && (
                      <div className="mt-2 ml-1 bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs space-y-2 shadow-sm">
                        <p className="font-bold text-blue-900 uppercase tracking-wide flex items-center gap-2">
                          <Calendar size={14} /> Available Times
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {msg.action.data.slots.map((slot: string, idx: number) => (
                            <button
                              key={idx}
                              onClick={() => handleBookSlot(slot)}
                              className="bg-white border border-blue-200 text-blue-700 px-3 py-2 rounded-lg font-semibold hover:bg-blue-100 transition-colors"
                            >
                              {slot}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="flex items-start">
                    <div className="bg-white border border-slate-200 rounded-2xl p-3 text-sm shadow-sm">
                      <Loader2 size={16} className="animate-spin text-indigo-600" />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="p-3 bg-white border-t border-slate-200 flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="Ask anything..."
                  className="flex-1 bg-slate-100 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleSend}
                  disabled={isLoading || !input.trim()}
                  className="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          )}

          {/* Live Voice Mode */}
          {mode === "live" && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gradient-to-br from-indigo-50 to-slate-50">
              <div className="text-center space-y-8">
                <div
                  className={`w-32 h-32 rounded-full flex items-center justify-center mx-auto transition-all duration-300 ${
                    isLiveConnected ? "bg-red-500 shadow-2xl shadow-red-500/50 animate-pulse" : "bg-slate-200 shadow-xl"
                  }`}
                >
                  <Mic size={48} className={isLiveConnected ? "text-white" : "text-slate-400"} />
                </div>
                <div>
                  <h3 className="text-2xl font-black uppercase italic tracking-tight text-slate-900 mb-2">
                    {isLiveConnected ? "Live Voice Active" : "Voice Mode"}
                  </h3>
                  <p className="text-sm text-slate-500 font-medium">
                    {isLiveConnected ? "Speak naturally, I'm listening..." : "Real-time voice conversation with AI"}
                  </p>
                </div>
                <button
                  onClick={isLiveConnected ? stopLiveSession : startLiveSession}
                  className={`px-8 py-4 rounded-2xl font-black uppercase text-sm tracking-widest shadow-2xl transition-all active:scale-95 ${
                    isLiveConnected
                      ? "bg-red-500 text-white hover:bg-red-600"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                  }`}
                >
                  {isLiveConnected ? "End Session" : "Start Voice Chat"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default NexusAssistant
