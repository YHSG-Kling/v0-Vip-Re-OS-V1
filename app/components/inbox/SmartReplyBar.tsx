"use client"

/**
 * SmartReplyBar — three quick-reply chips that the agent can click to drop
 * an AI-suggested reply into the message composer. Designed for any inbox
 * thread (SMS / email / in-app / portal) — the parent owns the composer
 * state and just receives the picked reply.
 */

import { useEffect, useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

type Channel = "sms" | "email" | "in_app" | "portal"

interface SmartReply {
  intent: "affirm" | "clarify" | "soft_hold"
  body: string
}

interface Props {
  inboundBody: string
  channel: Channel
  contactId?: string
  recentThread?: Array<{ direction: "inbound" | "outbound"; body: string }>
  onPick: (text: string) => void
}

const INTENT_LABEL: Record<SmartReply["intent"], string> = {
  affirm: "Affirm",
  clarify: "Clarify",
  soft_hold: "Soft hold",
}

export function SmartReplyBar({ inboundBody, channel, contactId, recentThread, onPick }: Props) {
  const [replies, setReplies] = useState<SmartReply[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!inboundBody) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch("/api/inbox/smart-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inboundBody, channel, contactId, recentThread }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (data?.error) setError(data.error)
        else setReplies(data?.replies ?? [])
      })
      .catch(() => !cancelled && setError("Couldn't generate replies"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [inboundBody, channel, contactId, recentThread])

  if (!inboundBody) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        Smart replies
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {replies && (
        <div className="flex flex-wrap gap-1.5">
          {replies.map((r, i) => (
            <Button
              key={i}
              type="button"
              size="sm"
              variant="outline"
              className="h-auto py-1.5 px-2 text-xs whitespace-normal text-left max-w-full"
              onClick={() => onPick(r.body)}
              title={INTENT_LABEL[r.intent]}
            >
              <span className="inline-block text-[10px] uppercase font-semibold text-muted-foreground mr-1.5 shrink-0">
                {INTENT_LABEL[r.intent]}
              </span>
              <span className="leading-snug">{r.body}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
