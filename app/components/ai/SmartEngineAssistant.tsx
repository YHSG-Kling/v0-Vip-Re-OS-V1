"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import { Mic, Map, Globe, X, Send, Bot, Loader2, Sparkles, Zap, ArrowRight, Copy } from "lucide-react"
import { generateAIText } from "@/lib/ai"
import { executeWorkflow } from "@/app/actions/workflows"
import { useAuth } from "@/lib/auth/client"
import { UserRole } from "@/types"

interface Message {
  role: "user" | "model"
  text: string
  sources?: { title: string; uri: string }[]
  isThinking?: boolean
  action?: {
    type: "lender_referral" | "schedule_slot"
    label: string
    data: any
  }
}

// ... existing code for createBlob and decode functions ...

function createBlob(data: Float32Array): Blob {
  const l = data.length
  const int16 = new Int16Array(l)
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768
  }
  const uint8 = new Uint8Array(int16.buffer)
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

const SmartEngineAssistant: React.FC = () => {
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
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ strategy: string; script: string } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
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

  const handleLenderReferral = async (actionData: any) => {
    setMessages((prev) => [...prev, { role: "model", text: "Initiating 3-way intro with the best lender match..." }])

    await executeWorkflow("lender-referral", {
      leadId: "current-lead-id",
      userName: "Current User",
      userEmail: "user@example.com",
      budget: actionData.budget || 500000,
      context: actionData.context,
    })

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "model",
          text: `Done! I've sent a warm intro email connecting you with ${actionData.budget > 1000000 ? "Luxury Lending Co" : "Standard Mortgage LLC"}. Check your sent items.`,
        },
      ])
    }, 1500)
  }

  const handleBookSlot = async (slot: string) => {
    setMessages((prev) => [...prev, { role: "user", text: `Let's do ${slot}` }])
    setIsLoading(true)

    const result = await executeWorkflow("book-slot", { slot, userName: "Current User" })

    setTimeout(() => {
      setIsLoading(false)
      setMessages((prev) => [
        ...prev,
        {
          role: "model",
          text: `Confirmed! I've sent a calendar invite for ${slot}.`,
          action: { type: "schedule_slot", label: "View Calendar", data: { link: result?.link || "#" } },
        },
      ])
    }, 1000)
  }

  const handleSend = async () => {
    if (!input.trim() || !process.env.API_KEY) return

    const userMsg = input
    setInput("")
    setCopilotSuggestion(null)
    setMessages((prev) => [...prev, { role: "user", text: userMsg }])
    setIsLoading(true)

    if (role === UserRole.AGENT) {
      executeWorkflow("handle-objection", { message: userMsg }).then((suggestion: any) => {
        if (suggestion) {
          setCopilotSuggestion(suggestion)
        }
      })
    }

    const financingKeywords = ["mortgage", "rate", "loan", "lender", "finance", "pre-approval", "payment"]
    const isFinancingIntent = financingKeywords.some((kw) => userMsg.toLowerCase().includes(kw))

    const scheduleKeywords = ["meet", "schedule", "book", "time", "call", "appointment"]
    const isScheduleIntent = scheduleKeywords.some((kw) => userMsg.toLowerCase().includes(kw))

    try {
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
          : "You are a real estate AI assistant. Be helpful and professional."

      const prompt = `${systemInstruction}\n\nUser: ${userMsg}`
      const result = await generateAIText(prompt)
      const text = result.text || "I couldn't generate a response."

      // Real confidence: fetch from predictive_lead_scores if a leadId context exists.
      // Falls back to null (no escalation) so we never simulate a random number.
      let realConfidence: number | null = null
      if (role === UserRole.AGENT) {
        // We use "Analyzing..." state — no leadId available in this context so we skip escalation
        // rather than fabricating a confidence score.
        realConfidence = null
      }

      if (realConfidence !== null && realConfidence < 0.3) {
        await executeWorkflow("escalate-low-confidence", {
          userName: "Current User",
          userMessage: userMsg,
          aiResponse: text,
          confidence: realConfidence,
        })
        setMessages((prev) => [
          ...prev,
          {
            role: "model",
            text: "That's a great specific question. I want to make sure I give you the 100% correct answer, so I've flagged this for your Senior Agent. They will reach out shortly!",
          },
        ])
        return
      }

      const sources: { title: string; uri: string }[] = []
      const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks
      if (chunks) {
        chunks.forEach((chunk: any) => {
          if (chunk.web) sources.push({ title: chunk.web.title, uri: chunk.web.uri })
          if (chunk.maps) sources.push({ title: chunk.maps.title, uri: chunk.maps.uri })
        })
      }

      let action = undefined
      if (isFinancingIntent) {
        action = {
          type: "lender_referral",
          label: "Connect with Preferred Lender",
          data: { context: userMsg, budget: 850000 },
        }
      }

      if (isScheduleIntent) {
        const availabilityResult = await executeWorkflow("check-availability", {})
        action = {
          type: "schedule_slot",
          label: "Book a Time",
          data: { slots: availabilityResult?.slots || [] },
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

  // ... existing code for startLiveSession, stopLiveSession, and render ...

  const startLiveSession = async () => {
    // Live audio sessions are not currently supported via Vercel AI Gateway
    // This feature requires direct SDK access to Google's live audio API
    setMessages((prev) => [...prev, { 
      role: "model", 
      text: "Voice mode is currently unavailable. Please use text chat instead." 
    }])
  }

  const stopLiveSession = () => {
    inputContextRef.current?.close()
    audioContextRef.current?.close()
    setIsLiveConnected(false)
    sessionPromiseRef.current = null
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 h-14 w-14 bg-indigo-600 rounded-full shadow-xl flex items-center justify-center text-white hover:bg-indigo-700 hover:scale-105 transition-all z-50"
      >
        {isOpen ? <X size={24} /> : <Sparkles size={24} />}
      </button>

      {isOpen && (
        <div className="fixed bottom-24 right-6 w-96 h-[600px] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col z-50 overflow-hidden animate-fade-in-up">
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

          {mode === "chat" && (
            <div className="flex-1 flex flex-col">
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

              <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl p-3 text-sm ${msg.role === "user" ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-700 shadow-sm"}`}
                    >
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-slate-100">
                          <p className="text-xs text-slate-400 mb-1">Sources:</p>
                          {msg.sources.map((s, idx) => (
                            <a
                              key={idx}
                              href={s.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-indigo-500 hover:underline block truncate"
                            >
                              {s.title}
                            </a>
                          ))}
                        </div>
                      )}
                      {msg.action && (
                        <button
                          onClick={() => {
                            if (msg.action?.type === "lender_referral") {
                              handleLenderReferral(msg.action.data)
                            } else if (msg.action?.type === "schedule_slot") {
                              handleBookSlot(msg.action.data.slots?.[0] || "Tomorrow 2pm")
                            }
                          }}
                          className="mt-2 w-full bg-indigo-500 text-white py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-2"
                        >
                          {msg.action.label} <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex items-start">
                    <div className="bg-white border border-slate-200 rounded-2xl p-3 shadow-sm">
                      <Loader2 className="animate-spin text-indigo-500" size={20} />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-white border-t border-slate-100">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSend()}
                    placeholder="Ask me anything..."
                    className="flex-1 px-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <button
                    onClick={handleSend}
                    disabled={isLoading}
                    className="bg-indigo-600 text-white p-2 rounded-xl hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <Send size={20} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {mode === "live" && (
            <div className="flex-1 flex flex-col items-center justify-center bg-slate-900 text-white p-8">
              <div
                className={`w-32 h-32 rounded-full flex items-center justify-center mb-6 transition-all ${isLiveConnected ? "bg-red-500 animate-pulse" : "bg-slate-700"}`}
              >
                <Mic size={48} />
              </div>
              <p className="text-lg font-semibold mb-2">{isLiveConnected ? "Listening..." : "Voice Mode"}</p>
              <p className="text-slate-400 text-sm text-center mb-6">
                Have a natural conversation with the AI assistant
              </p>
              <button
                onClick={isLiveConnected ? stopLiveSession : startLiveSession}
                className={`px-6 py-3 rounded-xl font-semibold ${isLiveConnected ? "bg-red-600 hover:bg-red-700" : "bg-indigo-600 hover:bg-indigo-700"}`}
              >
                {isLiveConnected ? "Stop Session" : "Start Voice"}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default SmartEngineAssistant
