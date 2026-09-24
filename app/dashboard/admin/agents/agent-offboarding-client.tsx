"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { UserMinus, Loader2, ArrowRightLeft, Archive, AlertTriangle, CalendarClock } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  previewAgentDeactivation, deactivateAgent,
  reassignAgentBooksAction, listBookTransfersAction, revertBookTransferAction,
} from "@/app/actions/agent-deactivation"
import type { BookTransferRow, BookTransferScope } from "@/lib/agents/agent-books"

type Agent = { id: string; name: string; isActive: boolean }
type Plan = {
  counts: { systemAcquired: number; agentBook: number; leads: number; activeDeals: number }
}
type Disposition = "reassign" | "archive"

export function AgentOffboardingClient({ roster }: { roster: Agent[] }) {
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>(roster)
  const [target, setTarget] = useState<Agent | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [successor, setSuccessor] = useState<string>("")
  const [disposition, setDisposition] = useState<Disposition>("reassign")
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [pending, startTransition] = useTransition()

  // ── Books reassignment (wave 81A): temporary (auto-reverts) or permanent ──
  const [booksFrom, setBooksFrom] = useState<string>("")
  const [booksTo, setBooksTo] = useState<string>("")
  const [booksScope, setBooksScope] = useState<BookTransferScope>("temporary")
  const [booksUntil, setBooksUntil] = useState<string>("")
  const [booksReason, setBooksReason] = useState<string>("")
  const [transfers, setTransfers] = useState<BookTransferRow[] | null>(null)
  const [transfersError, setTransfersError] = useState<string | null>(null)

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8)
  const loadTransfers = async () => {
    const r = await listBookTransfersAction()
    if (r.ok) { setTransfers(r.transfers); setTransfersError(null) }
    else { setTransfers([]); setTransfersError(r.reason) }
  }
  useEffect(() => { void loadTransfers() }, [])

  function reassignBooks() {
    if (!booksFrom || !booksTo) { toast({ title: "Pick both agents", variant: "destructive" }); return }
    if (booksScope === "temporary" && !booksUntil) { toast({ title: "Pick an end date", description: "A temporary transfer reverts automatically when it passes.", variant: "destructive" }); return }
    startTransition(async () => {
      const r = await reassignAgentBooksAction({
        fromAgentId: booksFrom, toAgentId: booksTo, scope: booksScope,
        until: booksScope === "temporary" ? new Date(`${booksUntil}T23:59:59`).toISOString() : null,
        reason: booksReason || null,
      })
      if (r.ok) {
        const x = r.result
        toast({
          title: booksScope === "temporary" ? `${nameOf(booksFrom)}'s book is covered by ${nameOf(booksTo)}` : `${nameOf(booksFrom)}'s book moved to ${nameOf(booksTo)}`,
          description: `${x.contacts} contact(s) · ${x.leads} lead(s) · ${x.dealRoles} deal role(s) · ${x.tasks} task(s) · ${x.listings} listing(s) · ${x.calendarEvents} event(s) · ${x.propertyAlerts} alert(s)${x.coverageSet ? " · new leads redirect while away" : ""}${x.agentDeactivated ? " · agent deactivated" : ""}${x.refused.length ? ` · ${x.refused.length} refusal(s): ${x.refused.join("; ")}` : ""}.`,
        })
        if (x.agentDeactivated) setAgents((cur) => cur.map((a) => (a.id === booksFrom ? { ...a, isActive: false } : a)))
        setBooksFrom(""); setBooksTo(""); setBooksUntil(""); setBooksReason("")
        await loadTransfers()
      } else {
        toast({ title: "Books not reassigned", description: r.reason, variant: "destructive" })
      }
    })
  }

  function revertTransfer(id: string) {
    startTransition(async () => {
      const r = await revertBookTransferAction(id)
      if (r.ok) {
        const restored = Object.values(r.result.restored).reduce((a, b) => a + b, 0)
        const skipped = Object.values(r.result.skipped).reduce((a, b) => a + b, 0)
        toast({ title: "Books reverted", description: `${restored} row(s) moved back${skipped ? ` · ${skipped} left where they were re-pointed during the window` : ""}${r.result.coverageCleared ? " · coverage cleared" : ""}.` })
        await loadTransfers()
      } else {
        toast({ title: "Not reverted", description: r.reason, variant: "destructive" })
      }
    })
  }

  const activeOthers = (id: string) => agents.filter((a) => a.isActive && a.id !== id)

  async function openFor(agent: Agent) {
    setTarget(agent); setPlan(null); setSuccessor(""); setDisposition("reassign"); setLoadingPlan(true)
    const r = await previewAgentDeactivation(agent.id)
    setLoadingPlan(false)
    if (r.ok) setPlan(r.plan as Plan)
    else { toast({ title: "Couldn't load the agent's book", description: r.reason, variant: "destructive" }); setTarget(null) }
  }

  function confirm() {
    if (!target) return
    const needsSuccessor =
      !!plan && (plan.counts.systemAcquired > 0 || plan.counts.leads > 0 || plan.counts.activeDeals > 0 ||
        (disposition === "reassign" && plan.counts.agentBook > 0))
    if (needsSuccessor && !successor) {
      toast({ title: "Pick a successor agent", description: "The brokerage's system leads and in-flight deals must go to someone.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const r = await deactivateAgent({ agentId: target.id, successorAgentId: successor || null, agentBookDisposition: disposition })
      if (r.ok) {
        toast({
          title: `${target.name} deactivated`,
          description: `${r.result.reassignedContacts} contact(s) + ${r.result.reassignedLeads} lead(s) reassigned · ${r.result.archivedContacts} archived${r.result.inFlightForcedReassign > 0 ? ` · ${r.result.inFlightForcedReassign} in-flight deal(s) protected` : ""}${r.result.reassignedDealRoles > 0 ? ` · ${r.result.reassignedDealRoles} deal role(s) moved` : ""}${r.result.reassignedOpenTasks > 0 ? ` · ${r.result.reassignedOpenTasks} open task(s) moved` : ""}${r.result.reintroductionsProposed > 0 ? ` · ${r.result.reintroductionsProposed} client re-intro(s) queued for approval` : ""}.`,
        })
        setAgents((cur) => cur.map((a) => (a.id === target.id ? { ...a, isActive: false } : a)))
        setTarget(null); setPlan(null)
      } else {
        toast({ title: "Couldn't deactivate", description: r.reason, variant: "destructive" })
      }
    })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><UserMinus className="h-6 w-6" /> Agent off-boarding</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Deactivate an agent without orphaning their book. System-acquired leads always move to a successor; the
          agent&apos;s own sphere/referral book can be reassigned or archived per their contract. In-flight deals are
          always protected — never archived mid-transaction.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Roster</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {agents.length === 0 && <p className="text-sm text-muted-foreground">No agents found.</p>}
          {agents.map((a) => (
            <div key={a.id} className="flex items-center justify-between border rounded-md px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <Badge variant={a.isActive ? "default" : "secondary"}>{a.isActive ? "Active" : "Deactivated"}</Badge>
              </div>
              {a.isActive && (
                <Button size="sm" variant="outline" onClick={() => openFor(a)} disabled={loadingPlan || pending}>
                  Deactivate
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="h-5 w-5" /> Reassign an agent&apos;s books</CardTitle>
          <CardDescription>
            Temporarily (leave, illness — the book comes back automatically on the end date and new leads redirect meanwhile)
            or permanently (the agent leaves — their whole book moves and the agent is deactivated).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Whose books</Label>
              <Select value={booksFrom} onValueChange={(v) => { setBooksFrom(v); if (v === booksTo) setBooksTo("") }}>
                <SelectTrigger><SelectValue placeholder="Choose an active agent…" /></SelectTrigger>
                <SelectContent>
                  {agents.filter((a) => a.isActive).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Select value={booksTo} onValueChange={setBooksTo}>
                <SelectTrigger><SelectValue placeholder="Choose the receiving agent…" /></SelectTrigger>
                <SelectContent>
                  {activeOthers(booksFrom).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={booksScope === "temporary" ? "default" : "outline"} onClick={() => setBooksScope("temporary")}>Temporary</Button>
              <Button type="button" size="sm" variant={booksScope === "permanent" ? "default" : "outline"} onClick={() => setBooksScope("permanent")}>Permanent</Button>
            </div>
            {booksScope === "temporary" && (
              <div className="space-y-1">
                <Label htmlFor="books-until">Until</Label>
                <input id="books-until" type="date" className="block h-9 rounded-md border bg-background px-2 text-sm" value={booksUntil} onChange={(e) => setBooksUntil(e.target.value)} />
              </div>
            )}
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label htmlFor="books-reason">Reason (optional)</Label>
              <input id="books-reason" className="block h-9 w-full rounded-md border bg-background px-2 text-sm" placeholder="Parental leave, resignation…" value={booksReason} onChange={(e) => setBooksReason(e.target.value)} maxLength={500} />
            </div>
            <Button onClick={reassignBooks} disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowRightLeft className="h-4 w-4 mr-1" />}
              {booksScope === "temporary" ? "Cover the book" : "Move the book"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {booksScope === "temporary"
              ? "Contacts, leads, in-flight deal roles, open tasks, active listings, upcoming events and alerts move to the covering agent and are recorded so they come back on the end date. Anything you re-point during the window stays where you put it."
              : "Runs the off-boarding flow with the agent's own book reassigned (not archived): the successor inherits everything, a warm re-introduction is queued for approval, and the agent is deactivated."}
          </p>
          {transfersError && <p className="text-xs text-destructive">{transfersError}</p>}
          {transfers && transfers.length > 0 && (
            <div className="space-y-1">
              <Label>Transfers</Label>
              <ul className="space-y-1">
                {transfers.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                    <span>
                      {nameOf(t.fromAgentId)} → {nameOf(t.toAgentId)} · {t.scope}
                      {t.untilAt ? ` until ${t.untilAt.slice(0, 10)}` : ""} · <Badge variant={t.status === "active" ? "default" : "secondary"}>{t.status}</Badge>
                      {t.reason ? <span className="text-muted-foreground"> — {t.reason}</span> : null}
                    </span>
                    {t.status === "active" && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => revertTransfer(t.id)}>Revert now</Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {target && (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" /> Deactivate {target.name}</CardTitle>
            <CardDescription>Review the book and choose how to hand it off. This cannot be undone automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingPlan && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the agent&apos;s book…</div>}
            {plan && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                  <Stat label="System leads" value={plan.counts.systemAcquired} hint="→ successor" />
                  <Stat label="Agent book" value={plan.counts.agentBook} hint="reassign / archive" />
                  <Stat label="Leads" value={plan.counts.leads} hint="→ successor" />
                  <Stat label="In-flight deals" value={plan.counts.activeDeals} hint="always protected" />
                </div>

                <div className="space-y-2">
                  <Label>Successor agent (inherits system leads, in-flight deals{disposition === "reassign" ? " & the agent's book" : ""})</Label>
                  <Select value={successor} onValueChange={setSuccessor}>
                    <SelectTrigger><SelectValue placeholder="Choose an active agent…" /></SelectTrigger>
                    <SelectContent>
                      {activeOthers(target.id).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>The agent&apos;s own book ({plan.counts.agentBook} contact{plan.counts.agentBook === 1 ? "" : "s"} they personally sourced)</Label>
                  <div className="flex gap-2">
                    <Button type="button" variant={disposition === "reassign" ? "default" : "outline"} size="sm" onClick={() => setDisposition("reassign")}>
                      <ArrowRightLeft className="h-4 w-4 mr-1" /> Reassign to successor
                    </Button>
                    <Button type="button" variant={disposition === "archive" ? "default" : "outline"} size="sm" onClick={() => setDisposition("archive")}>
                      <Archive className="h-4 w-4 mr-1" /> Archive (per contract)
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {disposition === "archive"
                      ? "Archived contacts stop all automation and are preserved as history — the agent's book leaves with them. Any with a live deal are still moved to the successor."
                      : "The agent's own book is reassigned to the successor along with the brokerage's system leads."}
                  </p>
                </div>

                <div className="flex gap-2 pt-2">
                  <Button onClick={confirm} disabled={pending}>
                    {pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <UserMinus className="h-4 w-4 mr-1" />}
                    Confirm deactivation
                  </Button>
                  <Button variant="ghost" onClick={() => { setTarget(null); setPlan(null) }} disabled={pending}>Cancel</Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="border rounded-md py-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs font-medium">{label}</div>
      <div className="text-[10px] text-muted-foreground">{hint}</div>
    </div>
  )
}
