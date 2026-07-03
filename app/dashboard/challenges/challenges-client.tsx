"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Trophy, Plus, Users, Award, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import { Badge } from "@/app/components/ui/badge"
import { createChallenge, enrollInChallenge, type ChallengeView } from "@/app/actions/challenges"

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "most_points", label: "Most points" },
  { value: "most_transactions", label: "Most closed deals" },
  { value: "most_contacts", label: "Most contacts added" },
  { value: "most_referrals", label: "Most referrals" },
  { value: "custom", label: "Custom (manual)" },
]

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  active: "default", draft: "secondary", ended: "outline", cancelled: "destructive",
}

export function ChallengesClient({ challenges, isAdmin, currentAgentId }: { challenges: ChallengeView[]; isAdmin: boolean; currentAgentId: string | null }) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    title: "", description: "", challengeType: "most_points",
    startsAt: "", endsAt: "", prizePoints: "500", prizeDescription: "", winnerCount: "1",
  })

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = await createChallenge({
        title: form.title, description: form.description || undefined,
        challengeType: form.challengeType as any, startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(), prizePoints: Number(form.prizePoints) || 0,
        prizeDescription: form.prizeDescription || undefined, winnerCount: Number(form.winnerCount) || 1,
      })
      if (!res.ok) { setError(res.error ?? "Failed to create"); return }
      setShowForm(false)
      setForm({ ...form, title: "", description: "", prizeDescription: "" })
      router.refresh()
    })
  }

  const enroll = (challengeId: string) => {
    startTransition(async () => {
      const res = await enrollInChallenge({ challengeId })
      if (!res.ok) setError(res.error ?? "Failed to enroll")
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div>
          <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? "outline" : "default"}>
            <Plus className="h-4 w-4 mr-1" /> {showForm ? "Cancel" : "New challenge"}
          </Button>
        </div>
      )}

      {error && <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">{error}</div>}

      {isAdmin && showForm && (
        <Card>
          <CardHeader><CardTitle className="text-lg">Create a challenge</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="title">Title</Label>
                <Input id="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Q3 Listing Sprint" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="desc">Description</Label>
                <Textarea id="desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What are we racing for?" />
              </div>
              <div>
                <Label htmlFor="type">Metric</Label>
                <select id="type" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" value={form.challengeType} onChange={(e) => setForm({ ...form, challengeType: e.target.value })}>
                  {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="winners">Winners</Label>
                <Input id="winners" type="number" min={1} value={form.winnerCount} onChange={(e) => setForm({ ...form, winnerCount: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="start">Starts</Label>
                <Input id="start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="end">Ends</Label>
                <Input id="end" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="pts">Prize points</Label>
                <Input id="pts" type="number" min={0} value={form.prizePoints} onChange={(e) => setForm({ ...form, prizePoints: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="prize">Prize (description)</Label>
                <Input id="prize" value={form.prizeDescription} onChange={(e) => setForm({ ...form, prizeDescription: e.target.value })} placeholder="$250 gift card" />
              </div>
            </div>
            <Button onClick={submit} disabled={pending || !form.title || !form.startsAt || !form.endsAt}>
              {pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trophy className="h-4 w-4 mr-1" />} Launch challenge
            </Button>
          </CardContent>
        </Card>
      )}

      {challenges.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          <Trophy className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No challenges yet{isAdmin ? " — launch one to get the team competing." : "."}</p>
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {challenges.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2"><Trophy className="h-5 w-5 text-yellow-500" />{c.title}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">Ranked by {c.metricLabel} · {c.participantCount} enrolled</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>{c.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {c.description && <p className="text-sm text-muted-foreground">{c.description}</p>}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {c.prizePoints > 0 && <span className="flex items-center gap-1"><Award className="h-3.5 w-3.5" />{c.prizePoints} pts</span>}
                  {c.prizeDescription && <span>{c.prizeDescription}</span>}
                  <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{c.winnerCount} winner{c.winnerCount === 1 ? "" : "s"}</span>
                </div>

                {c.standings.length > 0 ? (
                  <div className="space-y-1">
                    {c.standings.slice(0, 5).map((s) => (
                      <div key={s.agentId} className="flex items-center gap-3 text-sm">
                        <span className={"w-6 text-center font-bold " + (s.isWinner ? "text-yellow-500" : "text-muted-foreground")}>#{s.rank}</span>
                        <span className={"flex-1 truncate " + (s.agentId === currentAgentId ? "font-semibold text-blue-700" : "")}>{s.agentName}{s.agentId === currentAgentId && " (you)"}</span>
                        <span className="font-medium">{s.value.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{c.status === "draft" ? "Starts soon — standings appear once it opens." : "No standings yet."}</p>
                )}

                {c.status === "active" && currentAgentId && (
                  c.youEnrolled
                    ? <Badge variant="outline">You're in</Badge>
                    : <Button size="sm" variant="secondary" disabled={pending} onClick={() => enroll(c.id)}>Join challenge</Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
