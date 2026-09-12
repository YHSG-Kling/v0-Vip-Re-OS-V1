"use client"

// The door onto `app/actions/communications.ts:getRecentCommunications`, which had
// no caller. The CRM Communications tab showed conversation THREADS and the activity
// feed, but never the actual message history — the SMS/email bodies exchanged with
// the contact — even though the gated, tenant-scoped reader for it already existed.
//
// This deliberately renders through the server action rather than querying `messages`
// from the browser: the action carries the session gate, the brokerage predicate and
// the limit clamp. Message bodies are the most sensitive read in that file.

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MessageSquare, RefreshCw } from "lucide-react"
import { getRecentCommunications } from "@/app/actions/communications"

interface MessageRow {
  id: string
  type: string | null
  direction: string | null
  subject: string | null
  body: string | null
  status: string | null
  created_at: string | null
}

export function RecentMessagesCard({ contactId }: { contactId: string | null }) {
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!contactId) return
    setLoading(true)
    setError(null)
    try {
      const res = await getRecentCommunications(contactId, 20)
      if (!res.success) {
        // A refused read must read as a refusal. Rendering it as "no messages" would
        // tell an agent nobody had ever been contacted.
        setError(res.error || "Message history could not be loaded")
        setMessages([])
        return
      }
      setMessages((res.communications ?? []) as MessageRow[])
    } catch (err: any) {
      setError(err?.message || "Message history could not be loaded")
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  if (!contactId) return null

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-gray-500" />
          Message history
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label="Reload message history">
          <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : loading && messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No SMS or email on file for this contact yet.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="rounded-lg border p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {m.type || "message"}
                  </Badge>
                  <Badge
                    variant={m.direction === "inbound" ? "secondary" : "default"}
                    className="text-[10px] capitalize"
                  >
                    {m.direction || "—"}
                  </Badge>
                  {m.status && (
                    <span className="text-[10px] text-muted-foreground capitalize">{m.status}</span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {m.created_at ? new Date(m.created_at).toLocaleString() : ""}
                </span>
              </div>
              {m.subject && <p className="text-xs font-medium">{m.subject}</p>}
              {m.body && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{m.body}</p>}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
