"use client"

/**
 * ClientActionCard — the door onto /api/portal/client-action, the CLIENT-AS-ACTOR
 * lane named a differentiator at lib/kernel/manager-registry.ts:778. The route
 * (requireContactAccess-gated) and its dispatcher
 * (lib/portal/client-action-dispatch.ts) were complete — showing requests through
 * the BBA-gated requestShowing, seller asks proposed into the agent's approval
 * queue, search left open — and NOTHING in the portal called them. Built per
 * CLAUDE.md §1.2: the missing half is the tile.
 *
 * WIRED THROUGH THE ROUTE, deliberately: the portal's one existing in-tree API
 * call already fetches a portal route the same way (messages-client.tsx:114 →
 * /api/portal/messages/send), and /api/portal/client-action is the auth-gated
 * surface — requireContactAccess admits the contact themselves or same-brokerage
 * staff and fails closed. Adding a parallel server action would be a second door
 * onto dispatchClientAction with its own gate to keep in sync; the portal's
 * pattern is fetch-the-gated-route, so that is what this does.
 *
 * The quick actions mirror the vocabulary the dispatcher actually accepts
 * (client-action-router.ts): a showing request (showing verb + address →
 * create_showing), a search refine (open_search), and — for sellers — a
 * price/listing ask (seller_action → proposed to the agent, never executed).
 * A failed call renders as a failure, never as a silent success.
 */

import { useState } from "react"
import Link from "next/link"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { CalendarPlus, Loader2, MessageCircleQuestion, Send, Sparkles } from "lucide-react"

type Mode = "showing" | "seller_ask" | "free"

interface ClientActionCardProps {
  contactId: string
  /** Which quick actions to offer — buyers get the showing/search lane, sellers
   *  the price-review lane. The dispatcher re-derives the real contact_type
   *  server-side; this only shapes the UI. */
  audience: "buyer" | "seller"
}

interface ActionOutcome {
  ok: boolean
  outcome?: string
  spoken?: string
  error?: string
}

export function ClientActionCard({ contactId, audience }: ClientActionCardProps) {
  const [mode, setMode] = useState<Mode>(audience === "seller" ? "seller_ask" : "showing")
  const [message, setMessage] = useState("")
  const [address, setAddress] = useState("")
  const [preferredDate, setPreferredDate] = useState("")
  const [preferredTime, setPreferredTime] = useState("")
  const [newPrice, setNewPrice] = useState("")
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ActionOutcome | null>(null)

  const canSend =
    mode === "showing" ? address.trim().length > 0 : message.trim().length > 0

  async function send() {
    if (!canSend || sending) return
    setSending(true)
    setResult(null)
    try {
      const body: Record<string, unknown> = { contactId }
      if (mode === "showing") {
        // The router needs a showing verb + the address to classify this as a
        // showing_request; the structured propertyAddress is what requestShowing
        // actually schedules against.
        body.message = message.trim()
          ? `I'd like to tour ${address.trim()} — ${message.trim()}`
          : `I'd like to tour ${address.trim()}`
        body.propertyAddress = address.trim()
        if (preferredDate) {
          body.preferredDates = [{ date: preferredDate, time: preferredTime || "any" }]
        }
      } else {
        body.message = message.trim()
        const price = Number(newPrice.replace(/[^0-9.]/g, ""))
        if (mode === "seller_ask" && Number.isFinite(price) && price > 0) {
          body.newPrice = price
        }
      }

      const res = await fetch("/api/portal/client-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => null)) as ActionOutcome | null
      if (!res.ok || !json) {
        setResult({
          ok: false,
          error: json?.error ?? "Your request didn't go through — please try again or message your agent.",
        })
        return
      }
      setResult(json)
      if (json.ok) {
        setMessage("")
        setAddress("")
        setPreferredDate("")
        setPreferredTime("")
        setNewPrice("")
      }
    } catch {
      setResult({
        ok: false,
        error: "Your request didn't go through — please try again or message your agent.",
      })
    } finally {
      setSending(false)
    }
  }

  const modes: Array<{ key: Mode; label: string }> =
    audience === "seller"
      ? [
          { key: "seller_ask", label: "Ask for a price review" },
          { key: "free", label: "Something else" },
        ]
      : [
          { key: "showing", label: "Request a showing" },
          { key: "free", label: "Something else" },
        ]

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-primary shrink-0" />
        <h2 className="font-semibold text-base text-foreground">Make a Request</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-3 leading-relaxed">
        {audience === "seller"
          ? "Ask for a price review or any change on your listing — your agent reviews and confirms every request."
          : "Ask to tour a home or send any request — it goes straight onto your agent's desk."}
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => { setMode(m.key); setResult(null) }}
            className={
              "rounded-full border px-3 py-1 text-sm " +
              (mode === m.key ? "bg-foreground text-background" : "text-muted-foreground")
            }
          >
            {m.key === "showing" && <CalendarPlus className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
            {m.key === "free" && <MessageCircleQuestion className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
            {m.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {mode === "showing" && (
          <>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Property address (e.g. 123 Oak Street)"
            />
            <div className="flex gap-2">
              <Input
                type="date"
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
                className="flex-1"
                aria-label="Preferred date"
              />
              <Input
                type="time"
                value={preferredTime}
                onChange={(e) => setPreferredTime(e.target.value)}
                className="flex-1"
                aria-label="Preferred time"
              />
            </div>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Anything else? (optional)"
            />
          </>
        )}

        {mode === "seller_ask" && (
          <>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder='e.g. "Can we lower the price? Showings have slowed down."'
            />
            <Input
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              inputMode="numeric"
              placeholder="Suggested new price (optional)"
            />
          </>
        )}

        {mode === "free" && (
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder={
              audience === "seller"
                ? 'e.g. "Can we schedule another open house?"'
                : 'e.g. "Find me more homes near the park" or "Can I see 44 Birch Lane?"'
            }
          />
        )}

        <Button size="sm" onClick={send} disabled={!canSend || sending}>
          {sending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          Send request
        </Button>
      </div>

      {result && (
        <div
          className={
            "mt-3 rounded-lg border p-3 text-sm " +
            (result.ok && result.error === undefined
              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200"
              : "border-red-200 bg-red-50 text-red-800 dark:bg-red-950/20 dark:text-red-300")
          }
        >
          {result.error ? (
            result.error
          ) : result.spoken ? (
            result.spoken
          ) : result.outcome === "advisory" ? (
            <span>
              That reads like a question — your{" "}
              <Link href={`/portal/${contactId}/assistant`} className="underline font-medium">
                assistant
              </Link>{" "}
              or{" "}
              <Link href={`/portal/${contactId}/messages`} className="underline font-medium">
                agent
              </Link>{" "}
              can answer it directly.
            </span>
          ) : result.outcome === "search" ? (
            <span>
              On it —{" "}
              <Link href={`/portal/${contactId}/search`} className="underline font-medium">
                open your search
              </Link>{" "}
              to see matching homes.
            </span>
          ) : (
            "Request sent — your agent will follow up."
          )}
          {result.ok && result.outcome && result.outcome !== "advisory" && result.outcome !== "search" && (
            <Badge variant="outline" className="ml-2 text-[10px] align-middle">
              {result.outcome.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}
