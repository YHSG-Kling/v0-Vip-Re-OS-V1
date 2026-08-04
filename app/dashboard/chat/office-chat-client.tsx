"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Send, Copy, MessageCircle, ArrowRight, Plus, Loader2, Check } from "lucide-react"
import Link from "next/link"
import {
  createChatSession,
  sendChatMessage,
  getAgentChatSessions,
  getChatSession,
  endChatSession,
  grantMessageAccess,
  revokeMessageAccess,
  getMessageAccessList,
} from "@/app/actions/ai-chat"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { toast } from "sonner"
import { InlineAiReplyCoach } from "@/app/components/ai-copilot"

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  actionTaken?: string
}

interface ChatContact {
  id: string
  name: string
}

interface Teammate {
  id: string
  name: string
  userType: string
}

interface AccessRow {
  user_id: string
  user_type: string | null
  can_read: boolean
  can_write: boolean
  users?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null
}

interface SessionRow {
  id: string
  type?: string | null
  session_type?: string | null
  contact_id?: string | null
  last_message_at?: string | null
  last_activity_at?: string | null
  created_at?: string | null
  contacts?: { first_name?: string | null; last_name?: string | null } | null
}

interface OfficeChatClientProps {
  agentId: string
  brokerageId: string
  userId: string
  userRole: string
  contacts: ChatContact[]
  teammates: Teammate[]
}

/**
 * conversations.type — the four values createChatSession accepts. The chat used
 * to persist nothing at all, so the session type had nowhere to land; now it is
 * a stored property of the conversation and the agent picks it.
 */
const SESSION_TYPES = [
  { value: "market_insights", label: "Market insights" },
  { value: "lead_qualification", label: "Lead qualification" },
  { value: "client_support", label: "Client support" },
  { value: "transaction_help", label: "Transaction help" },
] as const

type SessionType = (typeof SESSION_TYPES)[number]["value"]

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

/** messages rows → the shape this transcript renders. */
function toMessage(row: any): Message {
  return {
    id: String(row.id),
    role: row.sender_type === "agent" ? "user" : "assistant",
    content: String(row.body ?? row.message_content ?? ""),
    timestamp: new Date(row.created_at ?? Date.now()),
    actionTaken: row.type && row.type !== "system" ? String(row.type) : undefined,
  }
}

export function OfficeChatClient({
  agentId,
  brokerageId,
  userId,
  userRole,
  contacts,
  teammates,
}: OfficeChatClientProps) {
  const [mode, setMode] = useState<"office" | "relationship">("office")
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [sessionType, setSessionType] = useState<SessionType>("market_insights")

  // THE CONVERSATION IS NOW A ROW, NOT REACT STATE.
  // Everything typed here used to live in `messages` and die with the tab:
  // conversations + messages + ai_suggestions, the whole session model in
  // app/actions/ai-chat.ts, had no caller anywhere in the app.
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [switchingSession, setSwitchingSession] = useState(false)
  const [endingSession, setEndingSession] = useState(false)

  // SHARING. message_access_control, and the grant/list/revoke trio built for
  // it, had no surface at all — a broker could not be let into an agent's AI
  // conversation and an agent had no way to see who already was.
  const [accessList, setAccessList] = useState<AccessRow[]>([])
  const [accessLoading, setAccessLoading] = useState(false)
  const [shareUserId, setShareUserId] = useState<string>("")
  const [shareCanWrite, setShareCanWrite] = useState(false)
  const [sharing, setSharing] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)

  const selectedContactName =
    contacts.find((c) => c.id === selectedContactId)?.name ?? ""

  const refreshSessions = useCallback(async () => {
    if (!agentId) return
    setSessionsLoading(true)
    try {
      const rows = await getAgentChatSessions(agentId)
      setSessions((rows ?? []) as SessionRow[])
    } catch (error) {
      console.error("Error loading chat sessions:", error)
    } finally {
      setSessionsLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    const loadBrandVoice = async () => {
      try {
        const profile = await getBrandVoiceProfile(agentId)
        setBrandVoice(profile)
      } catch (error) {
        console.error("Error loading brand voice:", error)
      }
    }
    if (agentId) loadBrandVoice()
  }, [agentId])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    setSessionType(mode === "relationship" ? "client_support" : "market_insights")
  }, [mode])

  const refreshAccessList = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setAccessList([])
      return
    }
    setAccessLoading(true)
    try {
      const rows = await getMessageAccessList(sessionId)
      setAccessList((rows ?? []) as AccessRow[])
    } catch (error) {
      console.error("Error loading conversation access list:", error)
      setAccessList([])
    } finally {
      setAccessLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshAccessList(activeSessionId)
  }, [activeSessionId, refreshAccessList])

  const handleShare = async () => {
    if (!activeSessionId || !shareUserId) return
    const teammate = teammates.find((t) => t.id === shareUserId)
    if (!teammate) return
    setSharing(true)
    try {
      await grantMessageAccess({
        conversationId: activeSessionId,
        userId: teammate.id,
        // message_access_control.user_type describes the GRANTEE, so it comes
        // from their own users row rather than being assumed to be "agent".
        userType: (["agent", "client", "admin", "broker"].includes(teammate.userType)
          ? teammate.userType
          : "agent") as "agent" | "client" | "admin" | "broker",
        canRead: true,
        canWrite: shareCanWrite,
      })
      toast.success(`Shared with ${teammate.name}`)
      setShareUserId("")
      setShareCanWrite(false)
      await refreshAccessList(activeSessionId)
    } catch (error: any) {
      toast.error(error?.message ?? "Could not share this conversation")
    } finally {
      setSharing(false)
    }
  }

  const handleRevoke = async (granteeUserId: string) => {
    if (!activeSessionId) return
    try {
      await revokeMessageAccess(activeSessionId, granteeUserId)
      toast.success("Access revoked")
      await refreshAccessList(activeSessionId)
    } catch (error: any) {
      toast.error(error?.message ?? "Could not revoke access")
    }
  }

  /** Open an existing conversation and replay its stored transcript. */
  const handleOpenSession = async (sessionId: string) => {
    setSwitchingSession(true)
    try {
      const session: any = await getChatSession(sessionId)
      if (!session) {
        toast.error("That conversation is no longer available")
        return
      }
      const rows = Array.isArray(session.messages) ? [...session.messages] : []
      rows.sort(
        (a: any, b: any) =>
          new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
      )
      setMessages(rows.map(toMessage))
      setActiveSessionId(session.id)
      setSelectedContactId(session.contact_id ?? null)
      if (session.contact_id) setMode("relationship")
    } catch (error: any) {
      console.error("Error opening chat session:", error)
      toast.error(error?.message ?? "Could not open that conversation")
    } finally {
      setSwitchingSession(false)
    }
  }

  const handleNewSession = () => {
    setActiveSessionId(null)
    setMessages([])
    setInput("")
  }

  const handleEndSession = async () => {
    if (!activeSessionId) return
    setEndingSession(true)
    try {
      await endChatSession(activeSessionId)
      toast.success("Conversation closed")
      setActiveSessionId(null)
      setMessages([])
      await refreshSessions()
    } catch (error: any) {
      toast.error(error?.message ?? "Could not close this conversation")
    } finally {
      setEndingSession(false)
    }
  }

  const handleSendMessage = async () => {
    const text = input.trim()
    if (!text) return

    if (!agentId) {
      toast.error("No agent profile is linked to this account yet — finish account setup to use AI chat.")
      return
    }

    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, optimistic])
    setInput("")
    setLoading(true)

    try {
      // One conversation per thread. Opened lazily so an agent who never types
      // does not leave an empty row behind.
      let sessionId = activeSessionId
      if (!sessionId) {
        const created: any = await createChatSession({
          agentId,
          leadId: mode === "relationship" && selectedContactId ? selectedContactId : undefined,
          sessionType,
        })
        sessionId = created?.id as string
        setActiveSessionId(sessionId)
      }

      // senderType is STATED. The action used to infer it from the sender id
      // and got it wrong for every uuid, filing the agent's own words as the
      // client's and scoring the lead's temperature from them.
      const result: any = await sendChatMessage({
        sessionId: sessionId!,
        senderType: "agent",
        messageContent: text,
        requestAiResponse: true,
      })

      setMessages((prev) => {
        const withoutPending = prev.filter((m) => m.id !== optimistic.id)
        const next = [...withoutPending]
        if (result?.message) next.push(toMessage(result.message))
        if (result?.assistantMessage) next.push(toMessage(result.assistantMessage))
        return next
      })

      await refreshSessions()
    } catch (error: any) {
      console.error("Error generating response:", error)
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setInput(text)
      toast.error(error?.message ?? "Failed to generate response")
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

  const currentPrompts = mode === "office" ? OFFICE_PROMPTS : RELATIONSHIP_PROMPTS

  const sessionLabel = (s: SessionRow) => {
    const contactName = s.contacts
      ? `${s.contacts.first_name ?? ""} ${s.contacts.last_name ?? ""}`.trim()
      : ""
    const kind =
      SESSION_TYPES.find((t) => t.value === (s.session_type ?? s.type))?.label ??
      (s.session_type ?? s.type ?? "Conversation")
    return contactName ? `${contactName} · ${kind}` : kind
  }

  return (
    <div className="container mx-auto p-6 h-screen flex flex-col">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">AI Chat</h1>
          <p className="text-muted-foreground">
            {mode === "office"
              ? "Business-wide insights, grounded in your brokerage's knowledge base"
              : "Relationship-focused conversation"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleNewSession}>
            <Plus className="h-4 w-4 mr-1" />
            New chat
          </Button>
          {activeSessionId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleEndSession}
              disabled={endingSession}
            >
              {endingSession ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              End chat
            </Button>
          )}
        </div>
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
                <CardTitle className="text-sm">Contact</CardTitle>
              </CardHeader>
              <CardContent>
                {contacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No contacts are assigned to you yet.
                  </p>
                ) : (
                  <Select
                    value={selectedContactId ?? ""}
                    onValueChange={(v) => setSelectedContactId(v || null)}
                    disabled={Boolean(activeSessionId)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a contact" />
                    </SelectTrigger>
                    <SelectContent>
                      {contacts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {activeSessionId && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    A conversation is bound to its contact when it opens. Start a
                    new chat to talk about someone else.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Session type — stored on the conversation row */}
          {!activeSessionId && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Conversation type</CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={sessionType} onValueChange={(v) => setSessionType(v as SessionType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SESSION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          )}

          {/* Saved conversations */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Your conversations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {sessionsLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing saved yet — your next message starts one.
                </p>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => handleOpenSession(s.id)}
                    disabled={switchingSession}
                    className={`w-full text-left text-xs p-2 rounded transition-colors hover:bg-accent ${
                      activeSessionId === s.id ? "bg-accent font-medium" : ""
                    }`}
                  >
                    <span className="block truncate">{sessionLabel(s)}</span>
                    {(s.last_activity_at ?? s.last_message_at ?? s.created_at) && (
                      <span className="block text-[10px] text-muted-foreground">
                        {new Date(
                          (s.last_activity_at ?? s.last_message_at ?? s.created_at) as string,
                        ).toLocaleString()}
                      </span>
                    )}
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          {/* Shared with — grant / list / revoke */}
          {activeSessionId && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Shared with</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {accessLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : accessList.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Only you.</p>
                ) : (
                  accessList.map((row) => {
                    const name =
                      `${row.users?.first_name ?? ""} ${row.users?.last_name ?? ""}`.trim() ||
                      row.users?.email ||
                      row.user_id
                    return (
                      <div key={row.user_id} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs truncate">{name}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {row.can_write ? "Can reply" : "Read only"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRevoke(row.user_id)}
                          className="text-[10px] text-destructive underline underline-offset-2 hover:no-underline shrink-0"
                        >
                          Revoke
                        </button>
                      </div>
                    )
                  })
                )}

                {teammates.length > 0 && (
                  <div className="space-y-2 border-t pt-2">
                    <Select value={shareUserId} onValueChange={setShareUserId}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Share with a teammate" />
                      </SelectTrigger>
                      <SelectContent>
                        {teammates.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={shareCanWrite}
                        onChange={(e) => setShareCanWrite(e.target.checked)}
                      />
                      Allow them to reply
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={handleShare}
                      disabled={sharing || !shareUserId}
                    >
                      {sharing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                      Share
                    </Button>
                  </div>
                )}
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

          {/* Reply Coach — needs a REAL conversations.id. It used to be handed a
              fabricated slug built from the typed name, so its drafts were
              filed against a conversation that does not exist. */}
          {mode === "relationship" && activeSessionId && (
            <InlineAiReplyCoach
              conversationId={activeSessionId}
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
                <Link href="/dashboard/settings/knowledge-base" className="flex items-center justify-between p-2 rounded hover:bg-accent transition-colors text-xs">
                  <span>Manage Knowledge Base</span>
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
                      ? "Ask about your pipeline, leads, reports, or any business question. Answers pull from your brokerage's own knowledge base first."
                      : "Pick a contact and ask about their journey, draft messages, or get follow-up suggestions."}
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
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
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
              disabled={loading || switchingSession}
            />
            <Button
              onClick={handleSendMessage}
              disabled={loading || switchingSession || !input.trim()}
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
