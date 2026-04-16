"use client"

import type React from "react"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MessageSquare, Send, Loader2, User, Clock, CheckCheck, Paperclip, ImageIcon } from "lucide-react"

interface Message {
  id: string
  sender_type: "client" | "agent" | "system"
  sender_name: string
  message_content: string
  message_type: "text" | "document" | "image" | "system"
  created_at: string
  read_at: string | null
  attachment_url?: string
}

interface ClientMessagingWidgetProps {
  contactId: string
  agentName?: string
  compact?: boolean
}

const isValidUUID = (str: string): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

const getDemoMessages = (agentName: string): Message[] => [
  {
    id: "demo-1",
    sender_type: "agent",
    sender_name: agentName,
    message_content:
      "Welcome! I'm excited to help you with your real estate journey. Feel free to reach out anytime with questions.",
    message_type: "text",
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    read_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-2",
    sender_type: "client",
    sender_name: "You",
    message_content: "Thank you! I had a question about the pre-approval process.",
    message_type: "text",
    created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    read_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-3",
    sender_type: "agent",
    sender_name: agentName,
    message_content:
      "Great question! I've connected you with our preferred lender who can walk you through the pre-approval process. They typically respond within 24 hours. In the meantime, you'll want to gather your last 2 pay stubs, W-2s from the past 2 years, and recent bank statements.",
    message_type: "text",
    created_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    read_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "demo-4",
    sender_type: "system",
    sender_name: "System",
    message_content: "New property match found: 123 Oak Street - matches your criteria",
    message_type: "system",
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    read_at: null,
  },
]

export function ClientMessagingWidget({
  contactId,
  agentName = "Your Agent",
  compact = false,
}: ClientMessagingWidgetProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState("")
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [isDemo, setIsDemo] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isValidUUID(contactId)) {
      // Use demo data for non-UUID contactIds
      setIsDemo(true)
      setMessages(getDemoMessages(agentName))
      setLoading(false)
      return
    }

    loadMessages()

    // Set up real-time subscription
    const supabase = createClient()
    const channel = supabase
      .channel(`messages-${contactId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "client_portal_messages",
          filter: `contact_id=eq.${contactId}`,
        },
        (payload: any) => {
          setMessages((prev) => [...prev, payload.new as Message])
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [contactId, agentName])

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  const loadMessages = async () => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("client_portal_messages")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true })

      if (error) throw error
      setMessages(data || [])

      // Mark unread messages as read
      if (data && data.length > 0) {
        const unreadIds = data.filter((m: any) => m.sender_type !== "client" && !m.read_at).map((m: any) => m.id)

        if (unreadIds.length > 0) {
          await supabase
            .from("client_portal_messages")
            .update({ read_at: new Date().toISOString() })
            .in("id", unreadIds)
        }
      }
    } catch (error) {
      console.error("Error loading messages:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleSend = async () => {
    if (!newMessage.trim()) return

    if (isDemo) {
      const demoMessage: Message = {
        id: `demo-${Date.now()}`,
        sender_type: "client",
        sender_name: "You",
        message_content: newMessage.trim(),
        message_type: "text",
        created_at: new Date().toISOString(),
        read_at: null,
      }
      setMessages((prev) => [...prev, demoMessage])
      setNewMessage("")

      // Simulate agent response after 2 seconds
      setTimeout(() => {
        const agentResponse: Message = {
          id: `demo-${Date.now()}-response`,
          sender_type: "agent",
          sender_name: agentName,
          message_content:
            "Thanks for your message! This is a demo - in the real app, your agent would receive this and respond.",
          message_type: "text",
          created_at: new Date().toISOString(),
          read_at: null,
        }
        setMessages((prev) => [...prev, agentResponse])
      }, 2000)
      return
    }

    setSending(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from("client_portal_messages").insert({
        contact_id: contactId,
        sender_type: "client",
        sender_name: "You",
        message_content: newMessage.trim(),
        message_type: "text",
      })

      if (error) throw error
      setNewMessage("")
    } catch (error) {
      console.error("Error sending message:", error)
    } finally {
      setSending(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else if (diffDays === 1) {
      return "Yesterday"
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: "short" })
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" })
  }

  const unreadCount = messages.filter((m) => m.sender_type !== "client" && !m.read_at).length

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">Loading messages...</p>
        </CardContent>
      </Card>
    )
  }

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center justify-between">
            <span className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" /> Messages
            </span>
            {unreadCount > 0 && <Badge className="bg-blue-600">{unreadCount} new</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No messages yet</p>
          ) : (
            <div className="space-y-2">
              {messages.slice(-3).map((msg) => (
                <div
                  key={msg.id}
                  className={`p-2 rounded-lg text-sm ${
                    msg.sender_type === "client" ? "bg-blue-50 ml-4" : "bg-slate-50 mr-4"
                  }`}
                >
                  <p className="font-medium text-xs mb-1">{msg.sender_name}</p>
                  <p className="text-muted-foreground truncate">{msg.message_content}</p>
                </div>
              ))}
            </div>
          )}
          <Button className="w-full mt-3" size="sm">
            <MessageSquare className="w-4 h-4 mr-2" /> Open Chat
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-[500px] flex flex-col">
      <CardHeader className="pb-3 border-b">
        <CardTitle className="text-lg flex items-center justify-between">
          <span className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" /> Chat with {agentName}
          </span>
          {unreadCount > 0 && <Badge className="bg-blue-600">{unreadCount} unread</Badge>}
        </CardTitle>
      </CardHeader>

      <ScrollArea className="flex-1 p-4">
        {messages.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-medium mb-2">Start a conversation</h3>
            <p className="text-sm text-muted-foreground">
              Send a message to your agent. They typically respond within a few hours.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.sender_type === "client" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${
                    msg.sender_type === "client"
                      ? "bg-blue-600 text-white"
                      : msg.sender_type === "system"
                        ? "bg-slate-100 text-slate-600 text-center w-full"
                        : "bg-slate-100"
                  }`}
                >
                  {msg.sender_type !== "client" && msg.sender_type !== "system" && (
                    <div className="flex items-center gap-2 mb-1">
                      <User className="w-3 h-3" />
                      <span className="text-xs font-medium">{msg.sender_name}</span>
                    </div>
                  )}

                  {msg.message_type === "document" && msg.attachment_url && (
                    <div className="flex items-center gap-2 mb-2 p-2 bg-white/10 rounded">
                      <Paperclip className="w-4 h-4" />
                      <span className="text-sm">Attachment</span>
                    </div>
                  )}

                  {msg.message_type === "image" && msg.attachment_url && (
                    <div className="mb-2">
                      <img
                        src={msg.attachment_url || "/placeholder.svg"}
                        alt="Shared image"
                        className="rounded max-w-full"
                      />
                    </div>
                  )}

                  <p className="text-sm whitespace-pre-wrap">{msg.message_content}</p>

                  <div
                    className={`flex items-center justify-end gap-1 mt-1 text-xs ${
                      msg.sender_type === "client" ? "text-blue-200" : "text-muted-foreground"
                    }`}
                  >
                    <Clock className="w-3 h-3" />
                    {formatTime(msg.created_at)}
                    {msg.sender_type === "client" && msg.read_at && <CheckCheck className="w-3 h-3 ml-1" />}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </ScrollArea>

      <div className="p-4 border-t">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="flex-shrink-0">
            <Paperclip className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="flex-shrink-0">
            <ImageIcon className="w-4 h-4" />
          </Button>
          <Input
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Type a message..."
            disabled={sending}
            className="flex-1"
          />
          <Button onClick={handleSend} disabled={!newMessage.trim() || sending} size="icon">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </Card>
  )
}
