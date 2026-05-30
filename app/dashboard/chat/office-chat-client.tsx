"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Send, Copy, ExternalLink, Search, MessageCircle, ArrowRight, Sparkles } from "lucide-react"
import Link from "next/link"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { toast } from "sonner"
import { InlineAiReplyCoach } from "@/app/components/ai-copilot"

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  actionTaken?: string
  complianceStatus?: "pass" | "warning"
}

interface OfficeChatClientProps {
  agentId: string
  brokerageId: string
  userId: string
  userRole: string
}

const OFFICE_PROMPTS = [
  "What should I do next today?",
  "What files are at risk of closing problems?",
  "Summarize my conversion performance this month",
  "Draft a seller update for a listing",
  "What campaigns are underperforming?",
  "What compliance items need review?",
  "Which agents on my team need coaching?",
  "Generate my weekly report summary",
  "What is blocking payouts this month?",
  "Find hidden opportunities in my pipeline",
]

const RELATIONSHIP_PROMPTS = [
  "Draft a check-in message for {name}",
  "What's the best way to follow up with {name}?",
  "Generate a referral ask for {name}",
  "Is {name} showing churn signals?",
  "What's the best next step with {name}?",
]

export function OfficeChatClient({
  agentId,
  brokerageId,
  userId,
  userRole,
}: OfficeChatClientProps) {
  const [mode, setMode] = useState<"office" | "relationship">("office")
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [selectedContactName, setSelectedContactName] = useState<string>("")
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const loadBrandVoice = async () => {
      try {
        const profile = await getBrandVoiceProfile(agentId)
        setBrandVoice(profile)
      } catch (error) {
        console.error("Error loading brand voice:", error)
      }
    }
    loadBrandVoice()
  }, [agentId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSendMessage = async () => {
    if (!input.trim()) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput("")
    setLoading(true)

    try {
      const systemPrompt =
        mode === "office"
          ? "You are the AI business assistant for this real estate OS. You have context about: leads, contacts, transactions, campaigns, financials, communications, compliance, and team performance. Answer specifically. Always suggest the next action. Refer to real OS surfaces by name."
          : `You are speaking with ${selectedContactName}. Context: This is a relationship-focused conversation. Provide personalized, authentic responses.`

      const response = await generateSmartResponse({
        incomingMessage: input,
        contactId: selectedContactId ?? userId,
        agentId,
        brokerageId,
        channel: "chat",
      })

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response.success ? response.draft ?? "" : (response as any).error ?? "Unable to generate response",
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch (error) {
      console.error("Error generating response:", error)
      toast.error("Failed to generate response")
    } finally {
      setLoading(false)
    }
  }

  const handleCopyMessage = (content: string) => {
    navigator.clipboard.writeText(content)
    toast.success("Copied to clipboard")
  }

  const handlePromptClick = (prompt: string) => {
    const finalPrompt =
      mode === "relationship"
        ? prompt.replace("{name}", selectedContactName || "them")
        : prompt
    setInput(finalPrompt)
  }

  const currentPrompts =
    mode === "office" ? OFFICE_PROMPTS : RELATIONSHIP_PROMPTS

  return (
    <div className="container mx-auto p-6 h-screen flex flex-col">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold">AI Chat</h1>
        <p className="text-muted-foreground">
          {mode === "office"
            ? "Business-wide insights and assistance"
            : "Relationship-focused conversation"}
        </p>
      </div>

      {/* Mode Tabs */}
      <Tabs value={mode} onValueChange={(v: any) => setMode(v)} className="mb-6">
        <TabsList>
          <TabsTrigger value="office">Office AI Chat</TabsTrigger>
          <TabsTrigger value="relationship">Relationship AI Chat</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4 overflow-y-auto">
          {mode === "relationship" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Select Contact</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search contacts..."
                    className="pl-8"
                    onChange={(e) => {
                      if (e.target.value) {
                        setSelectedContactName(e.target.value)
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Suggested Prompts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Suggested Prompts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {currentPrompts.slice(0, 5).map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handlePromptClick(prompt)}
                  className="w-full text-left text-xs p-2 rounded hover:bg-accent transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Reply Coach — visible in relationship mode when a contact is selected */}
          {mode === "relationship" && selectedContactName && (
            <InlineAiReplyCoach
              conversationId={`office-chat-${selectedContactName.toLowerCase().replace(/\s+/g, "-")}`}
              agentId={agentId}
              contactName={selectedContactName}
              onAcceptDraft={(draft) => setInput(draft)}
            />
          )}

          {/* Quick Navigation */}
          {mode === "office" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <Link href="/dashboard/diagnosis" className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors text-xs">
                  <span>Open Diagnosis</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </Link>
                <Link href="/dashboard/reports" className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors text-xs">
                  <span>Open Reports</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </Link>
                <Link href="/dashboard/ai-tools" className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors text-xs">
                  <span>Open AI Tools</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </Link>
                <Link href="/crm" className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors text-xs">
                  <span>Open CRM</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Main Chat Area */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          {/* Messages */}
          <ScrollArea className="flex-1 rounded-lg border p-4" ref={scrollRef}>
            <div className="space-y-4">
              {messages.length === 0 ? (
                <div className="text-center py-12">
                  <MessageCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <h3 className="text-lg font-semibold mb-2">
                    {mode === "office" ? "Your Business AI is Ready" : "Relationship Assistant"}
                  </h3>
                  <p className="text-muted-foreground text-sm mb-4 max-w-sm mx-auto">
                    {mode === "office"
                      ? "Ask about your pipeline, leads, reports, or any business question. The AI sees your entire OS."
                      : "Select a contact and ask about their journey, draft messages, or get follow-up suggestions."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePromptClick(currentPrompts[0])}
                  >
                    Try: {currentPrompts[0]}
                  </Button>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-xs lg:max-w-md rounded-lg p-3 ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <p className="text-sm">{msg.content}</p>
                      {msg.role === "assistant" && (
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => handleCopyMessage(msg.content)}
                            className="text-xs hover:opacity-75"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          {msg.actionTaken && (
                            <Badge variant="secondary" className="text-xs">
                              {msg.actionTaken}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-lg p-3">
                    <p className="text-sm">Thinking...</p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input */}
          <div className="flex gap-2">
            <Input
              placeholder="Type your message..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  handleSendMessage()
                }
              }}
              disabled={loading}
            />
            <Button
              onClick={handleSendMessage}
              disabled={loading || !input.trim()}
              size="sm"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
