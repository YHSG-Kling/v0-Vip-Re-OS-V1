"use client"

import { useMemo, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LifeBuoy, Clock } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { updateTicketStatus, getBrokerageTicketThread, replyToBrokerageTicket } from "@/app/actions/support"
import { TICKET_STATUSES, type SupportTicket, type TicketStatus } from "@/lib/support/ticket-constants"
import type { TicketThread as Thread } from "@/lib/support/support-thread"
import { byPriorityDesc } from "@/lib/kernel/priority-rank"

const STATUS_BADGE: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 border-blue-200",
  in_progress: "bg-amber-100 text-amber-700 border-amber-200",
  resolved: "bg-emerald-100 text-emerald-700 border-emerald-200",
  closed: "bg-gray-100 text-gray-600 border-gray-200",
}
// TOMBSTONE (§1.1, 2026-09-03): the local `PRIORITY_RANK {urgent:0 … low:3}`
// that stood here was one of five hand copies of the same map. Survivor:
// lib/kernel/priority-rank.ts:45 (PRIORITY_RANK, `urgent` aliased to
// `critical`) and its comparator `byPriorityDesc`, imported above. An unknown
// priority still sorts LAST (it ranked 9 here; it ranks 0 there — same end).

/** Inline thread for a ticket — view the conversation + reply on the tenant side.
 *  Mirrors the agent-facing thread in dashboard/help/ticket-thread.tsx, on the
 *  brokerage-scoped admin actions. */
function AdminTicketThread({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false)
  const [thread, setThread] = useState<Thread | null>(null)
  const [body, setBody] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !thread) getBrokerageTicketThread(ticketId).then(setThread)
  }
  function reply() {
    if (!body.trim()) return
    setErr(null)
    start(async () => {
      const r = await replyToBrokerageTicket({ ticketId, body })
      if (!r.ok) { setErr(r.error ?? "Failed"); return }
      setBody("")
      const t = await getBrokerageTicketThread(ticketId)
      setThread(t)
    })
  }

  return (
    <div className="mt-2">
      <button onClick={toggle} className="text-xs font-medium text-indigo-600 hover:underline">
        {open ? "Hide conversation" : "View conversation & reply"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {thread === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              {thread.requesterName && (
                <p className="text-xs text-muted-foreground">Raised by {thread.requesterName}</p>
              )}
              {thread.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground">No replies yet.</p>
              ) : thread.messages.map((m) => (
                <div key={m.id} className={"rounded border p-2 text-sm " + (m.authorKind === "staff" ? "bg-indigo-50/60 border-indigo-200" : "bg-white")}>
                  <p className="text-[11px] font-medium text-muted-foreground mb-0.5">
                    {m.authorKind === "staff" ? "Platform Support" : "Brokerage"} · {new Date(m.createdAt).toLocaleString()}
                  </p>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </>
          )}
          <div className="flex items-start gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder="Reply on this ticket…"
              className="flex-1 rounded-md border p-2 text-sm"
            />
            <button
              onClick={reply}
              disabled={pending || !body.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}
    </div>
  )
}

/** The two queues, and who answers each. The copy is lane-specific because the
 *  audiences are: one is answered in this office, the other by the platform. */
const LANE_COPY: Record<string, { title: string; blurb: string }> = {
  user_to_brokerage: {
    title: "Office Support Queue",
    blurb: "Tickets your agents and vendors raised with this office. Your staff answer these.",
  },
  tenant_to_platform: {
    title: "Our Tickets with the Platform",
    blurb: "Tickets this brokerage raised with the platform. Platform support answer these — you are the requester here.",
  },
}

export function SupportQueueClient({
  lane,
  initialTickets,
  loadError,
}: {
  lane: string
  initialTickets: SupportTicket[]
  loadError: string | null
}) {
  const { toast } = useToast()
  const [tickets, setTickets] = useState<SupportTicket[]>(initialTickets)
  const [filter, setFilter] = useState<"all" | TicketStatus>("all")
  const copy = LANE_COPY[lane] ?? LANE_COPY.user_to_brokerage

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tickets.length }
    for (const s of TICKET_STATUSES) c[s] = tickets.filter((t) => t.status === s).length
    return c
  }, [tickets])

  const visible = useMemo(() => {
    const list = filter === "all" ? tickets : tickets.filter((t) => t.status === filter)
    return [...list].sort(byPriorityDesc)
  }, [tickets, filter])

  async function setStatus(id: string, status: TicketStatus) {
    const prev = tickets
    setTickets((cur) => cur.map((t) => (t.id === id ? { ...t, status } : t)))
    const r = await updateTicketStatus(id, status)
    if (!r.ok) {
      setTickets(prev)
      toast({ title: "Update failed", description: r.error, variant: "destructive" })
    } else {
      toast({ title: `Ticket marked ${status.replace("_", " ")}` })
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.blurb}</p>
        </div>
      </div>

      {/* The lane switch. Two queues, never merged into one list — a ticket you
          RAISED with the platform is not a ticket waiting on your desk. */}
      <div className="flex gap-2">
        <a
          href="/dashboard/admin/support-tickets?lane=user_to_brokerage"
          className={"rounded-md border px-3 py-1.5 text-sm font-medium " + (lane === "user_to_brokerage" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        >
          From my agents &amp; vendors
        </a>
        <a
          href="/dashboard/admin/support-tickets?lane=tenant_to_platform"
          className={"rounded-md border px-3 py-1.5 text-sm font-medium " + (lane === "tenant_to_platform" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        >
          Raised with the platform
        </a>
      </div>

      {loadError ? (
        <Card><CardContent className="py-10 text-center text-red-600">Failed to load tickets: {loadError}</CardContent></Card>
      ) : (
        <>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | TicketStatus)}>
            <TabsList>
              <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
              {TICKET_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s} className="capitalize">{s.replace("_", " ")} ({counts[s] ?? 0})</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {visible.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-muted-foreground">No tickets in this view.</CardContent></Card>
          ) : (
            <div className="space-y-2">
              {visible.map((t) => (
                <Card key={t.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-4">
                      <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                        {t.subject}
                        {t.category && <Badge variant="secondary" className="text-xs">{t.category}</Badge>}
                        <Badge variant="outline" className="text-xs capitalize">{t.priority}</Badge>
                      </CardTitle>
                      <Badge className={STATUS_BADGE[t.status] ?? STATUS_BADGE.open + " capitalize"}>{t.status.replace("_", " ")}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex items-end justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      {t.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{t.description}</p>}
                      <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                        <Clock className="h-3 w-3" />{new Date(t.createdAt).toLocaleString()}
                      </p>
                      <AdminTicketThread ticketId={t.id} />
                    </div>
                    <Select value={t.status} onValueChange={(v) => setStatus(t.id, v as TicketStatus)}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TICKET_STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
