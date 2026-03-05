"use client"

import { useState, useTransition } from "react"
import { Send, Loader2, Sparkles, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface ComposeBarProps {
  conversationId: string
  senderId: string
  channel: string
  lifecycleState?: string
  onSend: (content: string) => Promise<{ success: boolean; error?: string }>
  onDraft?: (content: string) => Promise<string>
  disabled?: boolean
}

const BLOCKED_STATES = ["representation", "active_transaction", "under_contract"]
const WARNING_STATES = ["representation", "active_transaction", "under_contract"]

export default function ComposeBar({
  conversationId,
  senderId,
  channel,
  lifecycleState,
  onSend,
  onDraft,
  disabled,
}: ComposeBarProps) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isDrafting, setIsDrafting] = useState(false)

  const isBlocked = BLOCKED_STATES.includes(lifecycleState ?? "")
  const isWarning = WARNING_STATES.includes(lifecycleState ?? "") && !isBlocked

  const handleSend = () => {
    if (!text.trim() || isPending || isBlocked) return
    setError(null)
    startTransition(async () => {
      const result = await onSend(text.trim())
      if (result.success) {
        setText("")
      } else {
        setError(result.error ?? "Failed to send")
      }
    })
  }

  const handleDraft = async () => {
    if (!onDraft || isDrafting) return
    setIsDrafting(true)
    try {
      const draft = await onDraft(text)
      setText(draft)
    } finally {
      setIsDrafting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3 space-y-2 shrink-0">
      {/* Warning banner */}
      {isWarning && (
        <div className="flex items-center gap-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-md px-3 py-2">
          <AlertTriangle size={13} className="shrink-0" />
          <span>This contact is in <strong>{lifecycleState?.replace(/_/g, " ")}</strong> — AI ISA outreach is blocked. Manual messages only.</span>
        </div>
      )}

      {isBlocked ? (
        <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
          <AlertTriangle size={13} className="shrink-0" />
          <span>Sending is blocked for contacts in <strong>{lifecycleState?.replace(/_/g, " ")}</strong>.</span>
        </div>
      ) : (
        <>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Reply via ${channel}… (⌘+Enter to send)`}
            className="min-h-[72px] max-h-[180px] resize-none text-sm"
            disabled={isPending || disabled}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {onDraft && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDraft}
                  disabled={isDrafting || isPending}
                  className="text-xs h-7 gap-1"
                >
                  {isDrafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  AI Draft
                </Button>
              )}
              <span className={cn("text-[10px] text-muted-foreground", text.length > 1500 && "text-destructive")}>
                {text.length} chars
              </span>
            </div>

            <Button
              size="sm"
              onClick={handleSend}
              disabled={!text.trim() || isPending || isBlocked}
              className="h-7 gap-1 text-xs"
            >
              {isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Send
            </Button>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </>
      )}
    </div>
  )
}
