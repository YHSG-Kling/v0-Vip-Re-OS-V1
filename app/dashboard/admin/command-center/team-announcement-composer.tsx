"use client"

/**
 * TeamAnnouncementComposer — "Announce to my team" on the Command Center.
 *
 * WHY THIS HOME: the Command Center is the tenancy PRINCIPAL's governance seat
 * (the page itself gates entry with the same tier-parity principal rule the
 * server action enforces — broker/admin, solo agent on solo tier, team lead on
 * team tier). An internal announcement is a governance act from that seat, not
 * a roster-management task, so it lives here rather than on the users page.
 *
 * IN-APP ONLY: delivery is notifyBrokerageAgentsAction — one notifications row
 * per active agent/staff user in the in-app rail. Never email/SMS.
 */

import { useEffect, useState } from "react"
import {
  notifyBrokerageAgentsAction,
  draftTeamAnnouncementAction,
  listAnnouncementTeamsAction,
} from "@/app/actions/communications"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Megaphone, Sparkles, Loader2 } from "lucide-react"

export function TeamAnnouncementComposer({ canChooseScope }: { canChooseScope: boolean }) {
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium")
  const [scope, setScope] = useState<string>("brokerage") // "brokerage" | team id
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([])
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!canChooseScope) return
    listAnnouncementTeamsAction()
      .then((r) => { if (r.ok && r.teams) setTeams(r.teams) })
      .catch(() => {})
  }, [canChooseScope])

  async function handleDraft() {
    setDrafting(true)
    setResult(null)
    try {
      const r = await draftTeamAnnouncementAction({ subject, body })
      if (r.ok) {
        if (r.subject) setSubject(r.subject)
        if (r.body) setBody(r.body)
      } else {
        setResult({ ok: false, message: r.error ?? "Draft failed" })
      }
    } catch {
      setResult({ ok: false, message: "Draft failed" })
    } finally {
      setDrafting(false)
    }
  }

  async function handleSend() {
    setSending(true)
    setResult(null)
    try {
      const r = await notifyBrokerageAgentsAction({
        subject,
        body,
        priority,
        scope: scope === "brokerage" ? "brokerage" : "team",
        teamId: scope === "brokerage" ? null : scope,
      })
      if (r.ok) {
        setResult({
          ok: true,
          message: `Announced to ${r.notified} ${r.notified === 1 ? "person" : "people"}${r.scope === "team" ? " on the team" : " in the brokerage"} — in-app rail only.`,
        })
        setSubject("")
        setBody("")
        setPriority("medium")
      } else {
        setResult({ ok: false, message: r.error ?? "Send failed" })
      }
    } catch {
      setResult({ ok: false, message: "Send failed" })
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-primary" />
          Announce to my team
        </CardTitle>
        <CardDescription className="text-xs">
          One in-app notification to every active agent and staff member. Never email or SMS.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-xs">Subject</Label>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Friday sales meeting moved to 9am"
            maxLength={200}
            className="mt-1"
          />
        </div>
        <div>
          <Label className="text-xs">Message</Label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What does the team need to know?"
            rows={3}
            maxLength={460}
            className="mt-1"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as "low" | "medium" | "high")}>
              <SelectTrigger className="mt-1 h-8 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {canChooseScope && teams.length > 0 && (
            <div>
              <Label className="text-xs">Audience</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger className="mt-1 h-8 w-[190px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brokerage">Whole brokerage</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>Team — {t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              disabled={drafting || (!subject.trim() && !body.trim())}
              onClick={handleDraft}
              title="Polish in your brand voice — your own words stand if the AI is unavailable"
            >
              {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Polish with AI
            </Button>
            <Button
              size="sm"
              className="gap-1.5 text-xs"
              disabled={sending || !subject.trim() || !body.trim()}
              onClick={handleSend}
            >
              {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Announce
            </Button>
          </div>
        </div>
        {result && (
          <p className={result.ok ? "text-xs text-emerald-600" : "text-xs text-red-600"}>{result.message}</p>
        )}
      </CardContent>
    </Card>
  )
}
