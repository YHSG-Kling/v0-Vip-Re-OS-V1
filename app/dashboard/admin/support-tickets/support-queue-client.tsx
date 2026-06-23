"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LifeBuoy, Clock } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { updateTicketStatus } from "@/app/actions/support"
import { TICKET_STATUSES, type SupportTicket, type TicketStatus } from "@/lib/support/ticket-constants"

const STATUS_BADGE: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 border-blue-200",
  in_progress: "bg-amber-100 text-amber-700 border-amber-200",
  resolved: "bg-emerald-100 text-emerald-700 border-emerald-200",
  closed: "bg-gray-100 text-gray-600 border-gray-200",
}
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

export function SupportQueueClient({ initialTickets, loadError }: { initialTickets: SupportTicket[]; loadError: string | null }) {
  const { toast } = useToast()
  const [tickets, setTickets] = useState<SupportTicket[]>(initialTickets)
  const [filter, setFilter] = useState<"all" | TicketStatus>("all")

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tickets.length }
    for (const s of TICKET_STATUSES) c[s] = tickets.filter((t) => t.status === s).length
    return c
  }, [tickets])

  const visible = useMemo(() => {
    const list = filter === "all" ? tickets : tickets.filter((t) => t.status === filter)
    return [...list].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
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
          <h1 className="text-2xl font-bold">Support Tickets</h1>
          <p className="text-sm text-muted-foreground">Triage and resolve tickets raised by your agents.</p>
        </div>
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
                    <div className="min-w-0">
                      {t.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{t.description}</p>}
                      <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                        <Clock className="h-3 w-3" />{new Date(t.createdAt).toLocaleString()}
                      </p>
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
