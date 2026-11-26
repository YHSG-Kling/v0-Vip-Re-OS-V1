"use client"

/**
 * TEAMS THAT JOINED — carry their checklist (wave 145, lane 145H; owner ruling 21: "Teams required document checklist
 * should follow the team"). Lists the teams of this brokerage that joined through a completed adoption and lets a
 * person who may manage that team's rules carry the team's required-document rules from its previous workspace
 * (app/actions/compliance/manage-required-docs.ts carryJoinedTeamChecklist → lib/compliance/team-checklist-carry.ts).
 * The result says what was carried, what was already here, and what a human still has to decide.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { carryJoinedTeamChecklist } from "@/app/actions/compliance/manage-required-docs"

export interface JoinedTeamRow {
  teamId: string
  teamName: string | null
  completedAt: string | null
  workspaceWasTheTeams: boolean
}

export function TeamChecklistCarryPanel({ teams }: { teams: JoinedTeamRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyTeam, setBusyTeam] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  const carry = (teamId: string) => {
    setBusyTeam(teamId)
    startTransition(async () => {
      const r = await carryJoinedTeamChecklist({ teamId })
      const text = r.ok
        ? [
            `${r.carried} rule${r.carried === 1 ? "" : "s"} carried`,
            r.alreadyCarried ? `${r.alreadyCarried} already carried` : null,
            r.equivalentExists ? `${r.equivalentExists} already covered by an equal team rule` : null,
            r.templatesDropped ? `${r.templatesDropped} without its template (the template stayed with the previous workspace — attach one of yours)` : null,
            r.reattestation ? `${r.reattestation} state requirement(s) carried as team policy — a compliance approver re-attests the official source` : null,
            r.held.length ? `HELD for a person: ${r.held.map((h) => `${h.classification} (${h.reason})`).join("; ")}` : null,
          ].filter(Boolean).join(" · ")
        : `Not carried: ${r.error}`
      setResults((m) => ({ ...m, [teamId]: text }))
      setBusyTeam(null)
      if (r.ok) router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader><CardTitle>Teams that joined — their checklist follows them</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A team that joined through an adoption keeps its required-document checklist as the team's rules here. Its
          rules can add or tighten requirements, never loosen this brokerage's own or a cited state requirement. The
          previous workspace's rules are kept there as history.
        </p>
        <ul className="divide-y">
          {teams.map((t) => (
            <li key={t.teamId} className="py-2 space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  <span className="font-medium">{t.teamName ?? "Team"}</span>
                  <span className="text-muted-foreground"> · joined {t.completedAt ? t.completedAt.slice(0, 10) : "—"}{t.workspaceWasTheTeams ? " (its own workspace)" : ""}</span>
                </div>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => carry(t.teamId)}>
                  {busyTeam === t.teamId ? "Carrying…" : "Carry its checklist"}
                </Button>
              </div>
              <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{results[t.teamId] ?? ""}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
