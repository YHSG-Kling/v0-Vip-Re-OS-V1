"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import {
  AlertCircle, Clock, UserPlus, Mail, Phone, X, CheckCircle2, Loader2,
  TimerOff, Sparkles, Play,
} from "lucide-react"
import {
  claimStaleLead, reengageStaleContact, markContactTouched, disableReengagementForContact,
  resumeReengagementForContact,
  type StaleLoad, type StaleLeadRow, type StaleContactRow,
} from "./actions"

interface Props {
  data: StaleLoad
}

export function StaleClient({ data }: Props) {
  const router = useRouter()

  const totalActionable =
    data.myStaleLeads.length + data.unassignedStaleLeads.length + data.myStaleContacts.length

  return (
    <div className="container max-w-5xl mx-auto py-6 px-4">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 mb-1">
          <TimerOff className="h-3 w-3" /> Stale Queue
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Cold leads and dormant contacts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Leads with no touch in 7+ days and past contacts dormant for {data.staleThresholdDays}+ days. Re-engage with one click before they evaporate.
        </p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard icon={UserPlus}  label="Unclaimed leads"  count={data.unassignedStaleLeads.length} tone="amber" />
        <StatCard icon={AlertCircle} label="My stale leads"   count={data.myStaleLeads.length}        tone="red" />
        <StatCard icon={Clock}      label="Dormant contacts" count={data.myStaleContacts.length}     tone="indigo" />
      </div>

      {totalActionable === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center space-y-2">
            <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
            <p className="text-base font-medium">Nothing stale right now.</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              All your assigned leads have had recent activity and your past contacts are within the {data.staleThresholdDays}-day touch window.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Unclaimed (broker-only) */}
      {data.unassignedStaleLeads.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-amber-600" />
            Unclaimed leads ({data.unassignedStaleLeads.length})
            <span className="text-[10px] text-muted-foreground">— no one assigned for 7+ days</span>
          </h2>
          <div className="space-y-2">
            {data.unassignedStaleLeads.map(lead => (
              <UnclaimedLeadRow key={lead.id} lead={lead} onRefresh={() => router.refresh()} />
            ))}
          </div>
        </section>
      )}

      {/* My stale leads */}
      {data.myStaleLeads.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600" />
            My stale leads ({data.myStaleLeads.length})
            <span className="text-[10px] text-muted-foreground">— no activity in 7+ days</span>
          </h2>
          <div className="space-y-2">
            {data.myStaleLeads.map(lead => (
              <MyStaleLeadRow key={lead.id} lead={lead} />
            ))}
          </div>
        </section>
      )}

      {/* Dormant contacts */}
      {data.myStaleContacts.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-indigo-600" />
            Dormant past contacts ({data.myStaleContacts.length})
            <span className="text-[10px] text-muted-foreground">— no touch in {data.staleThresholdDays}+ days</span>
          </h2>
          <div className="space-y-2">
            {data.myStaleContacts.map(c => (
              <DormantContactRow key={c.id} contact={c} onRefresh={() => router.refresh()} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, label, count, tone }: { icon: any; label: string; count: number; tone: string }) {
  const toneClasses: Record<string, string> = {
    amber:  "border-amber-200 bg-amber-50/30",
    red:    "border-red-200 bg-red-50/30",
    indigo: "border-indigo-200 bg-indigo-50/30",
  }
  const iconClasses: Record<string, string> = {
    amber: "text-amber-600", red: "text-red-600", indigo: "text-indigo-600",
  }
  return (
    <Card className={toneClasses[tone]}>
      <CardContent className="py-3 px-3 flex items-center gap-2">
        <Icon className={`h-4 w-4 ${iconClasses[tone]}`} />
        <div>
          <p className="text-xl font-bold leading-none">{count}</p>
          <p className="text-[10px] uppercase text-muted-foreground tracking-wide mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function UnclaimedLeadRow({ lead, onRefresh }: { lead: StaleLeadRow; onRefresh: () => void }) {
  const [pending, startTransition] = useTransition()
  function handleClaim() {
    startTransition(async () => {
      const r = await claimStaleLead(lead.id)
      if (r.success) { toast.success(`Claimed ${formatName(lead)}`); onRefresh() } else toast.error(r.error ?? "Failed")
    })
  }
  return (
    <Card>
      <CardContent className="py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{formatName(lead)}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
            {lead.email && <span className="flex items-center gap-0.5"><Mail className="h-3 w-3" /> {lead.email}</span>}
            {lead.phone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {lead.phone}</span>}
            {lead.source && <Badge variant="outline" className="text-[9px]">{lead.source}</Badge>}
            <span className="text-amber-700 font-medium">{lead.daysStale}d unclaimed</span>
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button asChild size="sm" variant="ghost"><Link href={`/leads/${lead.id}`}>View</Link></Button>
          <Button size="sm" onClick={handleClaim} disabled={pending}>
            {pending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <UserPlus className="h-3 w-3 mr-1" />}
            Assign to me
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MyStaleLeadRow({ lead }: { lead: StaleLeadRow }) {
  return (
    <Card>
      <CardContent className="py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{formatName(lead)}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
            {lead.email && <span className="flex items-center gap-0.5"><Mail className="h-3 w-3" /> {lead.email}</span>}
            {lead.phone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {lead.phone}</span>}
            {lead.leadStage && <Badge variant="outline" className="text-[9px]">{lead.leadStage}</Badge>}
            <span className="text-red-700 font-medium">{lead.daysStale}d cold</span>
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button asChild size="sm" variant="ghost"><Link href={`/leads/${lead.id}`}>Open</Link></Button>
          {lead.phone && (
            <Button asChild size="sm" variant="outline">
              <a href={`tel:${lead.phone}`}><Phone className="h-3 w-3 mr-1" /> Call</a>
            </Button>
          )}
          {lead.email && (
            <Button asChild size="sm" variant="outline">
              <a href={`mailto:${lead.email}`}><Mail className="h-3 w-3 mr-1" /> Email</a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DormantContactRow({ contact, onRefresh }: { contact: StaleContactRow; onRefresh: () => void }) {
  const [pending, startTransition] = useTransition()
  const [action, setAction] = useState<"reengage" | "touched" | "disable" | "resume" | null>(null)

  function run(act: "reengage" | "touched" | "disable" | "resume") {
    setAction(act)
    startTransition(async () => {
      let r: { success: boolean; error?: string }
      if (act === "reengage")      r = await reengageStaleContact(contact.id)
      else if (act === "touched")  r = await markContactTouched(contact.id)
      // The RETURN LEG. "Stop AI" used to be a one-way door: the row rendered an
      // "ISA off" badge and no surface in the app could set the flag back.
      else if (act === "resume")   r = await resumeReengagementForContact(contact.id)
      else                         r = await disableReengagementForContact(contact.id)
      if (r.success) {
        toast.success(
          act === "reengage" ? "AI re-engagement queued"
            : act === "touched" ? "Marked as touched"
            : act === "resume" ? "AI re-engagement resumed"
            : "Re-engagement disabled",
        )
        onRefresh()
      } else toast.error(r.error ?? "Failed")
      setAction(null)
    })
  }

  return (
    <Card>
      <CardContent className="py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{formatName(contact)}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
            {contact.email && <span className="flex items-center gap-0.5"><Mail className="h-3 w-3" /> {contact.email}</span>}
            {contact.phone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3" /> {contact.phone}</span>}
            {contact.contactType && <Badge variant="outline" className="text-[9px]">{contact.contactType}</Badge>}
            <span className="text-indigo-700 font-medium">{contact.daysStale}d dormant</span>
            {!contact.isaReengageAllowed && <Badge variant="outline" className="text-[9px] text-red-700">ISA off</Badge>}
          </p>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          <Button asChild size="sm" variant="ghost"><Link href={`/crm/contacts/${contact.id}`}>Open</Link></Button>
          {contact.isaReengageAllowed && (
            <Button size="sm" onClick={() => run("reengage")} disabled={pending}>
              {pending && action === "reengage" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              AI re-engage
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => run("touched")} disabled={pending}>
            {pending && action === "touched" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
            I just touched
          </Button>
          {contact.isaReengageAllowed ? (
            <Button size="sm" variant="ghost" onClick={() => run("disable")} disabled={pending}>
              {pending && action === "disable" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <X className="h-3 w-3 mr-1" />}
              Stop AI
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => run("resume")} disabled={pending}>
              {pending && action === "resume" ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
              Resume AI
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function formatName(p: { firstName: string | null; lastName: string | null; email?: string | null }) {
  const n = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()
  return n || p.email || "Contact"
}
