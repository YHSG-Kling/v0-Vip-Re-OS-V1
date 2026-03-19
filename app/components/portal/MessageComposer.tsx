"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Send, Loader2, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"

const MAX_CHARS = 2000

interface MessageComposerProps {
  onSend: (message: string, channel: string) => Promise<void>
  placeholder?: string
  disabled?: boolean
  showChannelSelector?: boolean
  initialValue?: string
}

/**
 * MessageComposer - Sticky bottom message input.
 * - Textarea with 4-line max height before scroll
 * - Send button disabled when empty
 * - Character count (max 2000)
 * - Optional channel selector (portal/sms/email)
 * - Optimistic send with "Sending..." state
 * - Error state with retry option
 */
export function MessageComposer({
  onSend,
  placeholder = "Type a message...",
  disabled = false,
  showChannelSelector = false,
  initialValue = "",
}: MessageComposerProps) {
  const [message, setMessage] = useState(initialValue)
  const [channel, setChannel] = useState<string>("portal")
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = "auto"
      const scrollHeight = Math.min(textarea.scrollHeight, 96) // 4 lines max (~96px)
      textarea.style.height = `${scrollHeight}px`
    }
  }, [message])

  // Set initial value when prop changes
  useEffect(() => {
    if (initialValue && initialValue !== message) {
      setMessage(initialValue)
    }
  }, [initialValue])

  const handleSend = useCallback(async () => {
    if (!message.trim() || status === "sending") return

    setStatus("sending")
    try {
      await onSend(message.trim(), channel)
      setMessage("")
      setStatus("idle")
    } catch {
      setStatus("error")
    }
  }, [message, channel, onSend, status])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleRetry = () => {
    setStatus("idle")
    handleSend()
  }

  const charCount = message.length
  const isOverLimit = charCount > MAX_CHARS
  const isEmpty = !message.trim()

  return (
    <div className="sticky bottom-0 bg-background border-t p-4">
      {/* Error state */}
      {status === "error" && (
        <div className="flex items-center justify-between bg-destructive/10 text-destructive rounded-lg px-3 py-2 mb-2 text-sm">
          <span>Message failed to send</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRetry}
            className="h-8 text-destructive hover:text-destructive"
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Retry
          </Button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Channel selector */}
        {showChannelSelector && (
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="w-24 h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="portal">Portal</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
              <SelectItem value="email">Email</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Textarea */}
        <div className="flex-1 relative">
          <Textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled || status === "sending"}
            className={cn(
              "min-h-[44px] max-h-24 resize-none pr-12",
              isOverLimit && "border-destructive focus-visible:ring-destructive"
            )}
            rows={1}
          />
          {/* Character count */}
          <span
            className={cn(
              "absolute right-3 bottom-2 text-xs",
              isOverLimit ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {charCount}/{MAX_CHARS}
          </span>
        </div>

        {/* Send button - minimum 44px tap target */}
        <Button
          onClick={handleSend}
          disabled={disabled || isEmpty || isOverLimit || status === "sending"}
          size="icon"
          className="h-11 w-11 shrink-0"
        >
          {status === "sending" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Send className="h-5 w-5" />
          )}
          <span className="sr-only">Send message</span>
        </Button>
      </div>
    </div>
  )
}
