"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { UserMinus, Loader2, ArrowRightLeft, Archive, AlertTriangle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { previewAgentDeactivation, deactivateAgent } from "@/app/actions/agent-deactivation"

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
          description: `${r.result.reassignedContacts} contact(s) + ${r.result.reassignedLeads} lead(s) reassigned · ${r.result.archivedContacts} archived${r.result.inFlightForcedReassign > 0 ? ` · ${r.result.inFlightForcedReassign} in-flight deal(s) protected` : ""}.`,
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
