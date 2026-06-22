"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MessageSquare, Send, Loader2 } from "lucide-react"
import {
  getVendorThread,
  sendVendorMessage,
  markVendorMessagesRead,
  type VendorMessageRow,
} from "@/app/actions/vendor-messages"

interface ContactMessagePanelProps {
  vendorId: string
  contactId: string
  contactName: string
}

export function ContactMessagePanel({ vendorId, contactId, contactName }: ContactMessagePanelProps) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<VendorMessageRow[]>([])
  const [body, setBody] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const loadThread = () => {
    startTransition(async () => {
      setError(null)
      const r = await getVendorThread({ vendorId, contactId })
      if (!r.success) {
        setError(r.error ?? "Failed to load thread")
        return
      }
      setMessages(r.messages ?? [])
      setLoaded(true)
      void markVendorMessagesRead({ vendorId, contactId })
    })
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !loaded) loadThread()
  }

  const handleSend = () => {
    const text = body.trim()
    if (!text) return
    startTransition(async () => {
      setError(null)
      const r = await sendVendorMessage({ vendorId, contactId, body: text })
      if (!r.success) {
        setError(r.error ?? "Failed to send")
        return
      }
      setBody("")
      const refreshed = await getVendorThread({ vendorId, contactId })
      if (refreshed.success) setMessages(refreshed.messages ?? [])
    })
  }

  return (
    <div className="pt-2 border-t">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start px-0 text-xs"
        onClick={toggle}
      >
        <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
        {open ? "Hide messages" : "Message"}
      </Button>

      {open && (
        <div className="mt-2 space-y-2">
          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-md bg-muted/40 p-2">
            {isPending && !loaded ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </p>
            ) : messages.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No messages yet with {contactName}.
              </p>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    m.sender_type === "vendor"
                      ? "text-xs text-right"
                      : "text-xs text-left"
                  }
                >
                  <span
                    className={
                      m.sender_type === "vendor"
                        ? "inline-block rounded-lg bg-primary text-primary-foreground px-2 py-1"
                        : "inline-block rounded-lg bg-background border px-2 py-1"
                    }
                  >
                    {m.body}
                  </span>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-end gap-1.5">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Message ${contactName}…`}
              rows={2}
              className="text-xs resize-none"
            />
            <Button
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={handleSend}
              disabled={isPending || !body.trim()}
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
