"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { MessageCircle, X, Send, MapPin } from "lucide-react"
import { GoogleGenAI } from "@google/genai"

const ChatWidget: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<{ role: "system" | "user" | "agent"; text: string }[]>([])
  const [input, setInput] = useState("")
  const [context, setContext] = useState<string | null>(null)

  // Workflow 11 Node 2: Simulate extracting context from URL
  // In a real app, this would read window.location.href
  useEffect(() => {
    // Simulate a delay as if reading page DOM
    setTimeout(() => {
      // Mock Context: User is looking at a specific listing
      setContext("1234 Skyline Dr, Austin, TX")
      setMessages([
        {
          role: "system",
          text: `Hi! 👋 I see you're looking at 1234 Skyline Dr. Would you like to know about the school district or schedule a tour?`,
        },
      ])
    }, 1000)
  }, [])

  const handleSend = async () => {
    if (!input.trim() || !process.env.API_KEY) return

    const userMsg = input
    setInput("")
    setMessages((prev) => [...prev, { role: "user", text: userMsg }])

    // Workflow 11 Node 4: Generate Contextual Reply
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY })
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            {
              text: `
                    You are a real estate assistant chat bot following the THEM-FIRST philosophy.
                    
                    CONTEXT:
                    - User is viewing property ${context}
                    - Price: $850,000
                    - Status: Active
                    - User Question: "${userMsg}"
                    
                    THEM-FIRST PHILOSOPHY (CRITICAL):
                    - Focus 80-90% on THEIR needs, not the agent/company
                    - Use "you" and "your" extensively
                    - Ask understanding questions about THEIR situation
                    - Show empathy for THEIR concerns
                    - Minimize "I", "me", "we", "our" language
                    - Lead with what matters to THEM, not what you offer
                    
                    EXAMPLES:
                    BAD: "I can help you with that. We have great financing options."
                    GOOD: "Your financing situation is really important. What matters most to you - monthly payment or overall cost?"
                    
                    Provide a helpful, empathetic response that shows you understand their situation. Keep it under 2 sentences.
                    If they ask a question, answer it from THEIR perspective, focusing on what they gain or how it helps them.
                `,
            },
          ],
        },
      })

      const reply = response.text || "I can help with that! Let me connect you with an agent."
      setMessages((prev) => [...prev, { role: "agent", text: reply }])
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: "I'm having trouble connecting right now. Can I get your email?" },
      ])
    }
  }

  return (
    <div className="fixed bottom-6 left-6 z-50 flex flex-col items-start font-sans">
      {isOpen && (
        <div className="mb-4 w-80 bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-200 animate-slide-in-up">
          {/* Header */}
          <div className="bg-slate-900 p-4 flex justify-between items-center text-white">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center text-xs font-bold">
                  NX
                </div>
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-slate-900"></div>
              </div>
              <div>
                <h4 className="font-bold text-sm">Nexus Assistant</h4>
                {context && (
                  <span className="text-[10px] text-slate-400 flex items-center gap-1">
                    <MapPin size={8} /> {context}
                  </span>
                )}
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white">
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="h-64 overflow-y-auto p-4 bg-slate-50 space-y-3">
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs shadow-sm ${
                    msg.role === "user"
                      ? "bg-indigo-600 text-white rounded-br-none"
                      : "bg-white border border-slate-200 text-slate-700 rounded-bl-none"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="p-3 bg-white border-t border-slate-100 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Ask about this home..."
              className="flex-1 bg-slate-100 rounded-full px-4 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button onClick={handleSend} className="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700">
              <Send size={14} />
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setIsOpen(!isOpen)}
        className="h-14 w-14 bg-indigo-600 rounded-full shadow-lg flex items-center justify-center text-white hover:scale-110 transition-transform relative group"
      >
        {isOpen ? <X size={24} /> : <MessageCircle size={28} />}
        {!isOpen && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-white"></span>
        )}
        <div className="absolute left-full ml-3 bg-slate-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          Chat with us
        </div>
      </button>
    </div>
  )
}

export default ChatWidget
