"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Send,
  Sparkles,
  AlertTriangle,
  CheckCircle,
  User,
  Bot,
  TrendingUp,
  Lightbulb,
  Copy,
  ThumbsUp,
  MessageSquare,
} from "lucide-react"
import { sendChatMessage, getAiSuggestions, acceptAiSuggestion, getChatSession } from "@/app/actions/ai-chat"
import { useToast } from "@/hooks/use-toast"
import ThemFirstCoach from "./ThemFirstCoach"
import TemplateSelector from "./TemplateSelector"
import LeadInsightsPanel from "./LeadInsightsPanel"

export default function ChatInterface({ sessionId, agentId }: { sessionId?: string; agentId: string }) {
  const [session, setSession] = useState<any>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [inputMessage, setInputMessage] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [themFirstScore, setThemFirstScore] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (sessionId) {
      loadSession()
    }
  }, [sessionId])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const loadSession = async () => {
    try {
      const data = await getChatSession(sessionId!)
      setSession(data)
      setMessages(data.chat_messages || [])
      setThemFirstScore(data.them_first_score || 0)

      const sugs = await getAiSuggestions(sessionId!)
      setSuggestions(sugs)
    } catch (error) {
      toast({ title: "Error loading session", variant: "destructive" })
    }
  }

  const scrollToBottom = () => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !sessionId) return

    setIsLoading(true)
    try {
      await sendChatMessage({
        sessionId,
        senderId: agentId,
        messageContent: inputMessage,
        requestAiResponse: true,
      })

      setInputMessage("")
      await loadSession()
    } catch (error) {
      toast({ title: "Error sending message", variant: "destructive" })
    }
    setIsLoading(false)
  }

  const handleUseSuggestion = async (suggestionId: string, content: any) => {
    await acceptAiSuggestion(suggestionId)
    setInputMessage(content.template || JSON.stringify(content))
    setSuggestions(suggestions.filter((s) => s.id !== suggestionId))
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: "Copied to clipboard" })
  }

  if (!sessionId) {
    return (
      <Card className="h-[700px] flex items-center justify-center bg-background">
        <div className="text-center text-muted-foreground">
          <MessageSquare className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-semibold mb-2">No Session Selected</h3>
          <p>Select a session from the sidebar or start a new conversation</p>
        </div>
      </Card>
    )
  }

  const leadTemperature = session?.contacts?.lead_temperature

  return (
    <div className="space-y-4">
      {/* Header with Lead Info */}
      {session?.contacts && (
        <Card className="bg-background border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg text-foreground">
                  {session.contacts.first_name} {session.contacts.last_name}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {session.contacts.email} • {session.contacts.phone}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    leadTemperature === "hot" ? "destructive" : leadTemperature === "warm" ? "default" : "secondary"
                  }
                >
                  {leadTemperature}
                </Badge>
                <Badge variant="outline">
                  <TrendingUp className="w-3 h-3 mr-1" />
                  Them-First Score: {themFirstScore}
                </Badge>
              </div>
            </div>
          </CardHeader>
        </Card>
      )}

      {/* Cold Lead Warning */}
      {leadTemperature === "cold" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Cold Lead Alert:</strong> This lead can ONLY be contacted via email or print mail. SMS, phone calls,
            and social media are not permitted per compliance regulations.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main Chat Area */}
        <div className="lg:col-span-2 space-y-4">
          {/* Messages */}
          <Card className="h-[500px] flex flex-col bg-background border">
            <CardContent className="flex-1 p-4 overflow-hidden">
              <ScrollArea className="h-full pr-4">
                <div className="space-y-4">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex gap-3 ${message.sender_type === "agent" ? "flex-row-reverse" : ""}`}
                    >
                      {/* Avatar */}
                      <div
                        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                          message.sender_type === "agent"
                            ? "bg-blue-100"
                            : message.sender_type === "ai_assistant"
                              ? "bg-purple-100"
                              : "bg-gray-100"
                        }`}
                      >
                        {message.sender_type === "agent" ? (
                          <User className="w-4 h-4 text-blue-600" />
                        ) : message.sender_type === "ai_assistant" ? (
                          <Bot className="w-4 h-4 text-purple-600" />
                        ) : (
                          <Sparkles className="w-4 h-4 text-gray-600" />
                        )}
                      </div>

                      {/* Message Content */}
                      <div className={`flex-1 ${message.sender_type === "agent" ? "text-right" : ""}`}>
                        <div
                          className={`inline-block max-w-[80%] rounded-lg p-3 ${
                            message.sender_type === "agent"
                              ? "bg-blue-600 text-white"
                              : message.sender_type === "ai_assistant"
                                ? "bg-purple-50 border border-purple-200 text-foreground"
                                : "bg-muted text-foreground"
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap">{message.message_content}</p>

                          {/* Compliance Warning */}
                          {message.compliance_flagged && message.compliance_issues?.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-red-300">
                              <div className="flex items-start gap-2">
                                <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                                <div className="text-xs text-red-600">
                                  {message.compliance_issues.map((issue: any, idx: number) => (
                                    <div key={idx}>
                                      <strong>{issue.type}:</strong> {issue.phrase}
                                      {issue.alternative && <div className="mt-1">Try: "{issue.alternative}"</div>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Them-First Analysis */}
                          {message.them_first_analysis && message.sender_type === "agent" && (
                            <div className="mt-2 pt-2 border-t border-blue-400">
                              <div className="flex items-center justify-between text-xs">
                                <span>Them-First Score: {message.them_first_analysis.score}</span>
                                {message.them_first_analysis.score > 70 ? (
                                  <CheckCircle className="w-4 h-4 text-green-300" />
                                ) : (
                                  <AlertTriangle className="w-4 h-4 text-yellow-300" />
                                )}
                              </div>
                              <p className="text-xs mt-1 opacity-90">{message.them_first_analysis.feedback}</p>
                            </div>
                          )}
                        </div>

                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(message.created_at).toLocaleTimeString()}
                        </div>
                      </div>

                      {/* Copy Button */}
                      {message.sender_type === "ai_assistant" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(message.message_content)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <div ref={scrollRef} />
                </div>
              </ScrollArea>
            </CardContent>

            {/* Input Area */}
            <div className="border-t p-4 bg-background">
              <div className="flex gap-2">
                <Textarea
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      handleSendMessage()
                    }
                  }}
                  placeholder="Type your message... (Shift+Enter for new line)"
                  rows={3}
                  className="resize-none bg-background text-foreground"
                />
                <div className="flex flex-col gap-2">
                  <Button onClick={handleSendMessage} disabled={isLoading || !inputMessage.trim()} size="sm">
                    {isLoading ? <Sparkles className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                  <TemplateSelector
                    leadType={leadTemperature}
                    sessionId={sessionId}
                    onSelectTemplate={(template) => setInputMessage(template)}
                  />
                </div>
              </div>
            </div>
          </Card>

          {/* Them-First Coach */}
          <ThemFirstCoach score={themFirstScore} message={inputMessage} />
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4">
          {/* AI Suggestions */}
          <Card className="bg-background border">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2 text-foreground">
                <Lightbulb className="w-4 h-4 text-yellow-600" />
                AI Suggestions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {suggestions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No suggestions yet. Start chatting to get AI-powered recommendations.
                </p>
              ) : (
                suggestions.map((suggestion) => (
                  <Card key={suggestion.id} className="p-3 hover:shadow-md transition-shadow bg-background border">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-xs">
                          {suggestion.suggestion_type.replace("_", " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {Math.round(suggestion.confidence_score * 100)}% confidence
                        </span>
                      </div>
                      <p className="text-sm text-foreground">
                        {suggestion.suggestion_content.template ||
                          suggestion.suggestion_content.message ||
                          JSON.stringify(suggestion.suggestion_content)}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleUseSuggestion(suggestion.id, suggestion.suggestion_content)}
                        className="w-full"
                      >
                        <ThumbsUp className="w-3 h-3 mr-2" />
                        Use This
                      </Button>
                    </div>
                  </Card>
                ))
              )}
            </CardContent>
          </Card>

          {/* Lead Insights */}
          {session?.contacts && <LeadInsightsPanel lead={session.contacts} />}
        </div>
      </div>
    </div>
  )
}
