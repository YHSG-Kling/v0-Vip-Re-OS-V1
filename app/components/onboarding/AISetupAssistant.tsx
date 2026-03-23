'use client'

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { ChevronUp, Send, AlertCircle } from 'lucide-react'
import { saveAssistantChat, escapeAssistant } from '@/app/actions/onboarding/assistant'
import { toast } from 'sonner'

interface AISetupAssistantProps {
  agentOnboardingId: string
  currentStep: string
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function AISetupAssistant({
  agentOnboardingId,
  currentStep,
  isOpen = true,
  onOpenChange,
}: AISetupAssistantProps) {
  const [open, setOpen] = useState(isOpen)
  const [escalating, setEscalating] = useState(false)
  const [escalateReason, setEscalateReason] = useState('')

  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/onboarding/assistant',
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          currentStep,
          agentOnboardingId,
        },
      }),
    }),
  })

  // Save chat history on changes
  useEffect(() => {
    if (messages.length > 0) {
      saveAssistantChat(agentOnboardingId, messages, currentStep, false).catch(
        (error) => console.error('[v0] Error saving chat:', error)
      )
    }
  }, [messages, agentOnboardingId, currentStep])

  const handleEscalate = async () => {
    if (!escalateReason.trim()) return

    setEscalating(true)
    try {
      await escapeAssistant(agentOnboardingId, escalateReason, currentStep)
      setEscalating(false)
      setEscalateReason('')
      setOpen(false)
      // Trigger refresh of support tickets or show confirmation
      toast.success('Support request submitted — admin will respond within 24 hours')
    } catch (error) {
      console.error('[v0] Escalation failed:', error)
      toast.error('Escalation failed — try again')
      setEscalating(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true)
          onOpenChange?.(true)
        }}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-3 shadow-lg hover:shadow-xl transition-shadow"
      >
        <span className="text-sm font-medium">Setup Assistant</span>
        <ChevronUp className="w-4 h-4" />
      </button>
    )
  }

  return (
    <div className="fixed bottom-0 right-0 w-full sm:w-96 h-96 flex flex-col bg-background border-l border-t border-border rounded-t-lg shadow-lg z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
        <div>
          <h3 className="font-semibold text-sm">Setup Assistant</h3>
          <p className="text-xs text-muted-foreground">Step: {currentStep}</p>
        </div>
        <button
          onClick={() => {
            setOpen(false)
            onOpenChange?.(false)
          }}
          className="p-1 hover:bg-muted rounded"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-3">
                Hi! I'm here to help you with setup. What questions do you have?
              </p>
              <Badge variant="outline" className="text-xs">
                {currentStep}
              </Badge>
            </div>
          )}

          {messages.map((message, i) => (
            <div
              key={i}
              className={`flex ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-xs px-3 py-2 rounded-lg text-sm ${
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground'
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-muted px-3 py-2 rounded-lg">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" />
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse delay-100" />
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-pulse delay-200" />
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Escalation Panel */}
      {escalating && (
        <div className="px-4 py-3 border-t border-border bg-destructive/10 space-y-2">
          <div className="flex gap-2 text-sm">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-destructive-foreground text-xs">
              Let us know what you need help with
            </p>
          </div>
          <Input
            placeholder="Describe the issue..."
            value={escalateReason}
            onChange={(e) => setEscalateReason(e.target.value)}
            className="text-sm h-8"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEscalating(false)
                setEscalateReason('')
              }}
              className="text-xs h-7"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleEscalate}
              disabled={!escalateReason.trim()}
              className="text-xs h-7"
            >
              Submit
            </Button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="p-4 border-t border-border space-y-2">
        {!escalating ? (
          <>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <Input
                value={input}
                onChange={handleInputChange}
                placeholder="Ask me anything..."
                className="text-sm h-9"
                disabled={isLoading}
              />
              <Button
                type="submit"
                size="sm"
                disabled={isLoading || !input.trim()}
                className="h-9 px-3"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEscalating(true)}
              className="w-full text-xs h-8"
            >
              Escalate to Support
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
