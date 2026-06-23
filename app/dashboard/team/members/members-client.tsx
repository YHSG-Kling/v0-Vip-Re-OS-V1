"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Users, UserPlus, Loader2, Trash2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { listTeamMembers, addTeamMember, removeTeamMember, type TeamMemberRow } from "@/app/actions/admin/team-members"
import { TEAM_ROLES, SOURCE_OF_FUNDS } from "@/lib/teams/membership"

type Opt = { id: string; name: string }

export function TeamMembersClient({ teams, agents }: { teams: Opt[]; agents: Opt[] }) {
  const { toast } = useToast()
  const [teamId, setTeamId] = useState<string>(teams[0]?.id ?? "")
  const [members, setMembers] = useState<TeamMemberRow[]>([])
  const [loading, setLoading] = useState(false)
  const [agentId, setAgentId] = useState("")
  const [role, setRole] = useState<string>("buyers_agent")
  const [split, setSplit] = useState("30")
  const [source, setSource] = useState<string>("agent")
  const [pending, startTransition] = useTransition()

  async function refresh(id: string) {
    if (!id) { setMembers([]); return }
    setLoading(true)
    const r = await listTeamMembers(id)
    setLoading(false)
    setMembers(r.ok ? r.rows : [])
  }
  useEffect(() => { refresh(teamId) }, [teamId])

  function add() {
    const splitPercent = Number(split)
    if (!agentId) { toast({ title: "Pick an agent", variant: "destructive" }); return }
    startTransition(async () => {
      const r = await addTeamMember({ teamId, agentId, role, splitPercent, sourceOfFunds: source as "agent" | "brokerage" })
      if (r.ok) { toast({ title: "Member added", description: `${role.replace(/_/g, " ")} · ${splitPercent}% from ${source}` }); setAgentId(""); refresh(teamId) }
      else toast({ title: "Couldn't add member", description: r.error, variant: "destructive" })
    })
  }
  function remove(m: TeamMemberRow) {
    startTransition(async () => {
      const r = await removeTeamMember(m.id)
      if (r.ok) { setMembers((cur) => cur.filter((x) => x.id !== m.id)); toast({ title: "Member removed" }) }
      else toast({ title: "Couldn't remove", description: r.error, variant: "destructive" })
    })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="h-6 w-6 text-primary" />Team Members &amp; Splits</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Assign agents to a team with a commission split. The Finance Manager&apos;s commission waterfall splits
          deals by this roster — agent-funded splits come out of the closing agent&apos;s portion (capped at 100%),
          brokerage-funded are paid separately.
        </p>
      </div>

      {teams.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">No teams yet — create a team first, then assign members here.</CardContent></Card>
      ) : (
        <>
          <div className="max-w-xs space-y-1">
            <Label>Team</Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><UserPlus className="h-4 w-4" />Add a member</CardTitle>
              <CardDescription>Agent-funded splits are validated against the 100% cap before saving.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                <div className="space-y-1 md:col-span-2">
                  <Label>Agent</Label>
                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger><SelectValue placeholder="Select agent…" /></SelectTrigger>
                    <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Role</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{TEAM_ROLES.map((r) => <SelectItem key={r} value={r}>{r.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Split %</Label>
                  <Input type="number" min={1} max={100} value={split} onChange={(e) => setSplit(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>From</Label>
                  <Select value={source} onValueChange={setSource}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{SOURCE_OF_FUNDS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="mt-3">
                <Button onClick={add} disabled={pending}>{pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1" />}Add member</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Roster · {members.length}</CardTitle></CardHeader>
            <CardContent>
              {loading ? (
                <div className="py-6 text-center"><Loader2 className="h-4 w-4 animate-spin inline" /></div>
              ) : members.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No members yet — add one above. Until a team has members, the commission split is a no-op.</p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center justify-between px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{m.agent_name ?? m.agent_id.slice(0, 8)}</span>
                        <Badge variant="outline" className="text-[11px] capitalize">{(m.role ?? "member").replace(/_/g, " ")}</Badge>
                        <Badge className="text-[11px] bg-emerald-100 text-emerald-700 border-emerald-200">{m.split_percent}% · {m.source_of_funds}</Badge>
                      </div>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(m)} disabled={pending}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
