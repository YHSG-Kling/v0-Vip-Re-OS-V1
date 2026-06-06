"use client"

import type React from "react"
import { useState, useEffect, useTransition } from "react"
import { MessageCircle, X, Send, MapPin, Loader2 } from "lucide-react"
import { generateChatResponse } from "@/app/actions/ai-generate"

const ChatWidget: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<{ role: "system" | "user" | "agent"; text: string }[]>([])
  const [input, setInput] = useState("")
  const [context, setContext] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Workflow 11 Node 2: Simulate extracting context from URL
  useEffect(() => {
    setTimeout(() => {
      setContext("1234 Skyline Dr, Austin, TX")
      setMessages([
        {
          role: "system",
          text: `Hi! I see you're looking at 1234 Skyline Dr. Would you like to know about the school district or schedule a tour?`,
        },
      ])
    }, 1000)
  }, [])

  const handleSend = async () => {
    if (!input.trim() || !context) return

    const userMsg = input
    setInput("")
    setMessages((prev) => [...prev, { role: "user", text: userMsg }])

    startTransition(async () => {
      try {
        const result = await generateChatResponse(userMsg, context)
        const reply = result.text || "I can help with that! Let me connect you with an agent."
        setMessages((prev) => [...prev, { role: "agent", text: reply }])
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          { role: "agent", text: "I'm having trouble connecting right now. Can I get your email?" },
        ])
      }
    })
  }

  return (
    <>
      {/* Chat Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-4 right-4 z-50 bg-gradient-to-br from-blue-600 to-purple-600 text-white rounded-full p-4 shadow-lg hover:shadow-xl transition-all"
      >
        {isOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-20 right-4 z-50 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-4 flex items-center gap-3">
            <div className="bg-white/20 rounded-full p-2">
              <MapPin className="w-4 h-4" />
            </div>
            <div>
              <div className="font-semibold">Property Assistant</div>
              <div className="text-xs text-white/80">{context || "Loading..."}</div>
            </div>
          </div>

          {/* Messages */}
          <div className="h-64 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-md"
                      : "bg-gray-100 text-gray-800 rounded-bl-md"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isPending && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl px-4 py-2 text-sm rounded-bl-md flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Thinking...
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t p-3 flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Ask about this property..."
              className="flex-1 border rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isPending}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={isPending}
              className="bg-blue-600 text-white rounded-full p-2 hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default ChatWidget
