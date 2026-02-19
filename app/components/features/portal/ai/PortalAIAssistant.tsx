"use client"

import type React from "react"
import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Bot, X, Send, Sparkles, ChevronRight, Loader2, Mic, MicOff } from "lucide-react"
import { cn } from "@/lib/utils"

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  suggestions?: string[]
  actions?: { label: string; action: string; icon?: React.ReactNode }[]
}

interface PortalAIAssistantProps {
  contact: any
  contactId: string
  isBuyer: boolean
  isSeller: boolean
  persona: string
}

// Generate unique message IDs
let messageCounter = 0
const generateMessageId = () => `msg-${Date.now()}-${messageCounter++}`

export default function PortalAIAssistant({ contact, contactId, isBuyer, isSeller, persona }: PortalAIAssistantProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Initialize with persona-specific welcome message
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const welcomeMessage = getWelcomeMessage(persona, contact.first_name || contact.name, isBuyer, isSeller)
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content: welcomeMessage.content,
          timestamp: new Date(),
          suggestions: welcomeMessage.suggestions,
        },
      ])
    }
  }, [isOpen, persona, contact, isBuyer, isSeller])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  const getWelcomeMessage = (persona: string, name: string, isBuyer: boolean, isSeller: boolean) => {
    const personaMessages: Record<string, { content: string; suggestions: string[] }> = {
      first_time_buyer: {
        content: `Hi ${name}! I'm your personal home buying assistant. As a first-time buyer, you probably have lots of questions - and that's totally normal! I'm here 24/7 to help you understand the process, explain terms, and guide you through each step. What would you like to know?`,
        suggestions: [
          "What's the home buying process?",
          "How much can I afford?",
          "What's earnest money?",
          "Explain pre-approval",
        ],
      },
      military_buyer: {
        content: `Welcome ${name}! Thank you for your service. I'm here to help you navigate your VA loan benefits and find your perfect home. I understand military moves and can help with BAH calculations, VA loan requirements, and timing your purchase with your orders. How can I assist you today?`,
        suggestions: [
          "VA loan requirements",
          "BAH vs mortgage payment",
          "PCS timeline planning",
          "VA funding fee explained",
        ],
      },
      luxury_buyer: {
        content: `Good day ${name}. I'm your dedicated concierge assistant for your luxury property search. I can provide insights on exclusive listings, market analysis for premium properties, and coordinate with our white-glove services. How may I assist you?`,
        suggestions: [
          "Market trends for luxury homes",
          "Privacy and security features",
          "Investment potential analysis",
          "Concierge services available",
        ],
      },
      investor: {
        content: `Hello ${name}! I'm your investment property assistant. I can help you analyze deals, calculate cap rates, project cash flow, and identify market opportunities. What investment questions can I help with today?`,
        suggestions: [
          "Calculate cap rate",
          "Cash flow projection",
          "Market opportunity analysis",
          "1031 exchange timing",
        ],
      },
      first_time_seller: {
        content: `Hi ${name}! Selling your home for the first time can feel overwhelming, but I'm here to make it simple. I can walk you through each step, explain what to expect, and help you prepare for showings and offers. What questions do you have?`,
        suggestions: [
          "How do I prepare to sell?",
          "What's my home worth?",
          "Timeline for selling",
          "What are closing costs?",
        ],
      },
      motivated_seller: {
        content: `Hi ${name}! I understand you need to sell quickly, and I'm here to help expedite every step. I can provide real-time updates on showings, offers, and market conditions. What would you like to know about your listing?`,
        suggestions: [
          "Latest showing feedback",
          "Current offer status",
          "Price adjustment analysis",
          "Quick sale strategies",
        ],
      },
      divorce: {
        content: `Hello ${name}. I understand this is a difficult time, and I'm here to provide neutral, confidential assistance with your real estate needs. I can help coordinate the sale process and answer questions privately. How can I help today?`,
        suggestions: [
          "Timeline for the sale",
          "How are proceeds divided?",
          "Showing coordination",
          "Keep me updated privately",
        ],
      },
      probate: {
        content: `Hello ${name}. I'm here to help you navigate the estate property process with care and sensitivity. I can assist with understanding probate requirements, estate sale coordination, and timeline planning. What questions do you have?`,
        suggestions: [
          "Probate sale requirements",
          "Property preparation help",
          "Timeline expectations",
          "Estate sale coordination",
        ],
      },
      senior: {
        content: `Hello ${name}! I'm here to help make your transition as smooth as possible. I can answer questions in plain language, help coordinate with senior move services, and ensure you feel supported every step of the way. What would you like to know?`,
        suggestions: ["What are my options?", "Moving assistance available", "Timeline for selling", "Downsizing help"],
      },
      relocating: {
        content: `Hi ${name}! I know relocating involves a lot of moving pieces. I can help coordinate your home search in your new area while managing the sale of your current home. What's most pressing for you right now?`,
        suggestions: [
          "Coordinate buy and sell",
          "New area information",
          "Moving timeline help",
          "Remote buying process",
        ],
      },
      default: {
        content: `Hi ${name}! I'm your personal real estate assistant, available 24/7 to answer questions and help guide you through your ${isBuyer ? "home buying" : isSeller ? "home selling" : "real estate"} journey. What can I help you with?`,
        suggestions: isBuyer
          ? ["Search for homes", "View my saved properties", "Schedule a showing", "Check my offer status"]
          : ["View my listing stats", "Recent showing feedback", "Current offers", "Market update"],
      },
    }

    return personaMessages[persona] || personaMessages.default
  }

  const handleSend = async () => {
    if (!input.trim() || isLoading) return

    const userMessage: Message = {
      id: generateMessageId(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput("")
    setIsLoading(true)

    try {
      // Call AI endpoint
      const response = await fetch("/api/portal/ai-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          message: userMessage.content,
          persona,
          isBuyer,
          isSeller,
          conversationHistory: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        }),
      })

      if (!response.ok) throw new Error("Failed to get response")

      const data = await response.json()

      const assistantMessage: Message = {
        id: generateMessageId(),
        role: "assistant",
        content: data.response,
        timestamp: new Date(),
        suggestions: data.suggestions,
        actions: data.actions,
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch (error) {
      // Fallback response if API fails
      const fallbackMessage: Message = {
        id: generateMessageId(),
        role: "assistant",
        content:
          "I apologize, but I'm having trouble connecting right now. Your agent has been notified and will follow up with you shortly. In the meantime, you can browse your dashboard or documents.",
        timestamp: new Date(),
        suggestions: ["View my dashboard", "Check documents", "Contact my agent"],
      }
      setMessages((prev) => [...prev, fallbackMessage])
    }

    setIsLoading(false)
  }

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion)
    setTimeout(() => handleSend(), 100)
  }

  const handleActionClick = (action: string) => {
    // Navigate or perform action
    switch (action) {
      case "dashboard":
        window.location.href = `/portal/${contactId}`
        break
      case "documents":
        window.location.href = `/portal/${contactId}/documents`
        break
      case "properties":
        window.location.href = `/portal/${contactId}/properties`
        break
      case "showings":
        window.location.href = `/portal/${contactId}/showings`
        break
      case "offers":
        window.location.href = `/portal/${contactId}/offers`
        break
      case "listing":
        window.location.href = `/portal/${contactId}/listing`
        break
      case "journey":
        window.location.href = `/portal/${contactId}/journey`
        break
      default:
        break
    }
  }

  const toggleVoice = () => {
    setIsListening(!isListening)
    // Voice recognition would be implemented here
  }

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg bg-primary hover:bg-primary/90 z-50"
        size="icon"
      >
        <div className="relative">
          <Bot className="h-6 w-6" />
          <span className="absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full border-2 border-primary animate-pulse" />
        </div>
      </Button>
    )
  }

  return (
    <Card
      className={cn(
        "fixed bottom-6 right-6 w-96 shadow-2xl z-50 transition-all duration-300",
        isMinimized ? "h-14" : "h-[600px]",
      )}
    >
      {/* Header */}
      <CardHeader className="p-4 border-b bg-primary text-primary-foreground rounded-t-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="h-10 w-10 rounded-full bg-primary-foreground/20 flex items-center justify-center">
                <Bot className="h-5 w-5" />
              </div>
              <span className="absolute bottom-0 right-0 h-3 w-3 bg-green-500 rounded-full border-2 border-primary" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">AI Assistant</CardTitle>
              <p className="text-xs text-primary-foreground/70">Always here to help</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/20"
              onClick={() => setIsMinimized(!isMinimized)}
            >
              {isMinimized ? (
                <ChevronRight className="h-4 w-4 rotate-90" />
              ) : (
                <ChevronRight className="h-4 w-4 -rotate-90" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-primary-foreground hover:bg-primary-foreground/20"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      {!isMinimized && (
        <>
          {/* Messages */}
          <CardContent className="p-0 flex-1 h-[440px]">
            <ScrollArea className="h-full p-4">
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-4 py-3",
                        message.role === "user"
                          ? "bg-primary text-primary-foreground rounded-br-md"
                          : "bg-muted rounded-bl-md",
                      )}
                    >
                      <p className="text-sm whitespace-pre-wrap">{message.content}</p>

                      {/* Suggestions */}
                      {message.suggestions && message.suggestions.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {message.suggestions.map((suggestion, idx) => (
                            <Button
                              key={idx}
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs bg-background hover:bg-accent"
                              onClick={() => handleSuggestionClick(suggestion)}
                            >
                              {suggestion}
                            </Button>
                          ))}
                        </div>
                      )}

                      {/* Actions */}
                      {message.actions && message.actions.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {message.actions.map((action, idx) => (
                            <Button
                              key={idx}
                              variant="secondary"
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => handleActionClick(action.action)}
                            >
                              {action.icon}
                              <span className="ml-2">{action.label}</span>
                              <ChevronRight className="h-4 w-4 ml-auto" />
                            </Button>
                          ))}
                        </div>
                      )}

                      <p className="text-[10px] mt-2 opacity-50">
                        {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-sm text-muted-foreground">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={scrollRef} />
              </div>
            </ScrollArea>
          </CardContent>

          {/* Input */}
          <div className="p-4 border-t">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                className={cn("shrink-0", isListening && "bg-red-100 text-red-600 border-red-300")}
                onClick={toggleVoice}
              >
                {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Ask me anything..."
                className="flex-1"
                disabled={isLoading}
              />
              <Button onClick={handleSend} disabled={!input.trim() || isLoading} size="icon" className="shrink-0">
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[10px] text-center text-muted-foreground mt-2">
              <Sparkles className="h-3 w-3 inline mr-1" />
              Powered by AI - Available 24/7
            </p>
          </div>
        </>
      )}
    </Card>
  )
}
