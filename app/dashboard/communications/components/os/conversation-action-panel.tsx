"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { 
  Send, 
  Mail, 
  MessageSquare, 
  Phone,
  Clock,
  Users,
  Pause,
  Play,
  AlertTriangle,
  Zap,
  FileText
} from "lucide-react"

interface ConversationActionPanelProps {
  contactId: string
  contactName: string
  conversationId?: string
  channel: "email" | "sms" | "in_app"
  templates?: Array<{ id: string; name: string; body: string; channel: string }>
  onSendMessage: (params: {
    channel: "email" | "sms" | "in_app"
    body: string
    subject?: string
  }) => Promise<void>
  onAddToSequence: (sequenceId: string) => Promise<void>
  onPauseSequence?: () => Promise<void>
  onResumeSequence?: () => Promise<void>
  onScheduleFollowUp: (date: Date) => Promise<void>
  onEscalate: () => Promise<void>
  onMarkNeedsAttention: () => Promise<void>
  isInSequence?: boolean
  sequencePaused?: boolean
}

export function ConversationActionPanel({
  contactId,
  contactName,
  conversationId,
  channel,
  templates = [],
  onSendMessage,
  onAddToSequence,
  onPauseSequence,
  onResumeSequence,
  onScheduleFollowUp,
  onEscalate,
  onMarkNeedsAttention,
  isInSequence = false,
  sequencePaused = false,
}: ConversationActionPanelProps) {
  const [message, setMessage] = useState("")
  const [subject, setSubject] = useState("")
  const [selectedChannel, setSelectedChannel] = useState<"email" | "sms" | "in_app">(channel)
  const [selectedTemplate, setSelectedTemplate] = useState<string>("")
  const [isSending, setIsSending] = useState(false)

  const handleSend = async () => {
    if (!message.trim()) return
    setIsSending(true)
    try {
      await onSendMessage({
        channel: selectedChannel,
        body: message,
        subject: selectedChannel === "email" ? subject : undefined,
      })
      setMessage("")
      setSubject("")
    } finally {
      setIsSending(false)
    }
  }

  const handleTemplateSelect = (templateId: string) => {
    const template = templates.find(t => t.id === templateId)
    if (template) {
      setMessage(template.body)
      setSelectedTemplate(templateId)
    }
  }

  const filteredTemplates = templates.filter(
    t => t.channel === selectedChannel || t.channel === "all"
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Quick Actions
            </CardTitle>
            <CardDescription>Take action on {contactName}</CardDescription>
          </div>
          {isInSequence && (
            <Badge variant={sequencePaused ? "secondary" : "default"}>
              {sequencePaused ? "Sequence Paused" : "In Sequence"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Channel Selection */}
        <div className="flex gap-2">
          <Button
            variant={selectedChannel === "email" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedChannel("email")}
            className="flex-1"
          >
            <Mail className="h-4 w-4 mr-1" />
            Email
          </Button>
          <Button
            variant={selectedChannel === "sms" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedChannel("sms")}
            className="flex-1"
          >
            <MessageSquare className="h-4 w-4 mr-1" />
            SMS
          </Button>
          <Button
            variant={selectedChannel === "in_app" ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedChannel("in_app")}
            className="flex-1"
          >
            <Phone className="h-4 w-4 mr-1" />
            In-App
          </Button>
        </div>

        {/* Template Selection */}
        {filteredTemplates.length > 0 && (
          <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
            <SelectTrigger>
              <SelectValue placeholder="Use a template..." />
            </SelectTrigger>
            <SelectContent>
              {filteredTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    {template.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Subject (for email) */}
        {selectedChannel === "email" && (
          <input
            type="text"
            placeholder="Subject..."
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm"
          />
        )}

        {/* Message Input */}
        <Textarea
          placeholder={`Write your ${selectedChannel === "sms" ? "text" : "message"}...`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          className="resize-none"
        />

        {/* Character count for SMS */}
        {selectedChannel === "sms" && (
          <div className={`text-xs text-right ${message.length > 160 ? "text-destructive" : "text-muted-foreground"}`}>
            {message.length}/160 characters
          </div>
        )}

        {/* Send Button */}
        <Button 
          onClick={handleSend} 
          disabled={!message.trim() || isSending}
          className="w-full"
        >
          {isSending ? "Sending..." : "Send Message"}
          <Send className="h-4 w-4 ml-2" />
        </Button>

        {/* Quick Actions Grid */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t">
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => onScheduleFollowUp(new Date(Date.now() + 24 * 60 * 60 * 1000))}
          >
            <Clock className="h-4 w-4 mr-1" />
            Follow-up Tomorrow
          </Button>
          
          {isInSequence ? (
            sequencePaused ? (
              <Button variant="outline" size="sm" onClick={onResumeSequence}>
                <Play className="h-4 w-4 mr-1" />
                Resume Sequence
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onPauseSequence}>
                <Pause className="h-4 w-4 mr-1" />
                Pause Sequence
              </Button>
            )
          ) : (
            <Button variant="outline" size="sm" onClick={() => onAddToSequence("")}>
              <Users className="h-4 w-4 mr-1" />
              Add to Sequence
            </Button>
          )}
          
          <Button variant="outline" size="sm" onClick={onMarkNeedsAttention}>
            <AlertTriangle className="h-4 w-4 mr-1" />
            Needs Attention
          </Button>
          
          <Button variant="outline" size="sm" onClick={onEscalate}>
            <Zap className="h-4 w-4 mr-1" />
            Escalate
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
