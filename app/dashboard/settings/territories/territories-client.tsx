"use client"

/**
 * Settings → Territories, client half.
 *
 * TENANCY IS NOT A PROP. This component receives claims and labels, never a
 * brokerage id it could send back — every server action re-resolves the session
 * itself. The `writableGrains` list drives which controls RENDER; it is not the
 * gate. authorizeTerritoryWrite() on the server is the gate, and it runs again on
 * every single write regardless of what this component chose to show.
 */

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { AlertTriangle, Building2, Loader2, MapPin, Plus, RotateCcw, Star, Users, XCircle } from "lucide-react"
import {
  addTerritoryZips,
  setTerritoryActive,
  setTerritoryPrimary,
  type TerritoryClaim,
  type TerritorySettingsView,
} from "@/app/actions/settings/territories"
import { parseZipInput, type TerritoryGrain } from "./territory-rules"

const GRAIN_LABEL: Record<TerritoryGrain, string> = {
  brokerage: "Brokerage-wide",
  team: "Team",
  agent: "Agent",
}

const GRAIN_ICON: Record<TerritoryGrain, typeof Building2> = {
  brokerage: Building2,
  team: Users,
  agent: MapPin,
}

export function TerritoriesClient({ view }: { view: TerritorySettingsView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const writable = view.viewer?.writableGrains ?? []
  const [grain, setGrain] = useState<TerritoryGrain>(writable[0] ?? "agent")
  const [teamId, setTeamId] = useState<string>("")
  const [agentUserId, setAgentUserId] = useState<string>(view.viewer?.userId ?? "")
  const [zipText, setZipText] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")

  // Live echo of the SAME pure parser the server uses, so what is shown and what
  // is enforced cannot drift apart.
  const parsed = useMemo(() => parseZipInput(zipText), [zipText])

  const selectableTeams = useMemo(
    () => (view.viewer?.isBrokerageAdmin ? view.teams : view.teams.filter((t) => t.isLed)),
    [view.teams, view.viewer?.isBrokerageAdmin],
  )
  const selectableAgents = useMemo(
    () => (view.viewer?.isBrokerageAdmin ? view.agents : view.agents.filter((a) => a.id === view.viewer?.userId)),
    [view.agents, view.viewer?.isBrokerageAdmin, view.viewer?.userId],
  )

  const active = view.claims.filter((c) => c.active)
  const retired = view.claims.filter((c) => !c.active)

  function run(fn: () => Promise<{ success?: boolean; ok?: boolean; error?: string }>, okText: string) {
    setNotice(null)
    startTransition(async () => {
      const res = await fn()
      if (res.error) { setNotice({ kind: "err", text: res.error }); return }
      setNotice({ kind: "ok", text: okText })
      router.refresh()
    })
  }

  if (!view.ok || !view.viewer) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Territories unavailable
            </CardTitle>
            <CardDescription>{view.error ?? "Could not resolve your brokerage."}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Territories covered</h1>
        <p className="text-sm text-muted-foreground">
          The ZIPs this brokerage claims. Brokerage-wide claims are what the platform lead rotation reads —
          team and agent claims record who covers what inside your brokerage and never change what the
          platform sends you.
        </p>
      </div>

      {notice && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* ── ADD ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claim ZIPs</CardTitle>
          <CardDescription>Five-digit ZIPs, separated by spaces or commas. Anything that is not five digits is refused, not skipped.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="territory-grain">Coverage level</Label>
              <Select value={grain} onValueChange={(v) => setGrain(v as TerritoryGrain)}>
                <SelectTrigger id="territory-grain"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {writable.map((g) => (
                    <SelectItem key={g} value={g}>{GRAIN_LABEL[g]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {grain === "team" && (
              <div className="space-y-1.5">
                <Label htmlFor="territory-team">Team</Label>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger id="territory-team"><SelectValue placeholder="Pick a team" /></SelectTrigger>
                  <SelectContent>
                    {selectableTeams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {grain === "agent" && (
              <div className="space-y-1.5">
                <Label htmlFor="territory-agent">Agent</Label>
                <Select value={agentUserId} onValueChange={setAgentUserId}>
                  <SelectTrigger id="territory-agent"><SelectValue placeholder="Pick an agent" /></SelectTrigger>
                  <SelectContent>
                    {selectableAgents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="territory-zips">ZIP codes</Label>
            <Input
              id="territory-zips"
              value={zipText}
              placeholder="90210, 90211, 90212"
              onChange={(e) => setZipText(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {parsed.zips.map((z) => <Badge key={z} variant="secondary">{z}</Badge>)}
              {parsed.rejected.map((z) => (
                <Badge key={z} variant="destructive" title="Not a five-digit ZIP">{z}</Badge>
              ))}
            </div>
            {parsed.rejected.length > 0 && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {parsed.rejected.join(", ")} {parsed.rejected.length === 1 ? "is not a" : "are not"} five-digit ZIP
                {parsed.rejected.length === 1 ? "" : "s"} — nothing will be saved until they are fixed or removed.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="territory-city">City (optional)</Label>
              <Input id="territory-city" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="territory-state">State (optional)</Label>
              <Input id="territory-state" value={state} maxLength={2} placeholder="CA" onChange={(e) => setState(e.target.value)} />
            </div>
          </div>

          <Button
            disabled={pending || parsed.zips.length === 0 || parsed.rejected.length > 0}
            onClick={() =>
              run(async () => {
                const res = await addTerritoryZips({ zips: zipText, grain, teamId: teamId || null, agentUserId: agentUserId || null, city, state })
                if (res.success) setZipText("")
                return res
              }, "Territory saved.")
            }
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Claim {parsed.zips.length > 0 ? `${parsed.zips.length} ZIP${parsed.zips.length === 1 ? "" : "s"}` : "ZIPs"}
          </Button>
        </CardContent>
      </Card>

      {/* ── ACTIVE ──────────────────────────────────────────────────────── */}
      <ClaimTable
        title="Active coverage"
        description={
          active.length === 0
            ? "Nothing is claimed yet. Until a brokerage-wide ZIP is claimed here, the platform lead rotation has no row to route to."
            : "A star marks the primary ZIP for that claimant. Retiring a ZIP keeps its history — nothing is deleted."
        }
        claims={active}
        pending={pending}
        onPrimary={(id) => run(() => setTerritoryPrimary(id), "Primary territory updated.")}
        onToggle={(id) => run(() => setTerritoryActive(id, false), "Territory retired.")}
        toggleLabel="Retire"
        ToggleIcon={XCircle}
      />

      {retired.length > 0 && (
        <ClaimTable
          title="Retired coverage"
          description="Kept for history — these ZIPs used to be covered and explain past lead routing."
          claims={retired}
          pending={pending}
          onToggle={(id) => run(() => setTerritoryActive(id, true), "Territory re-opened.")}
          toggleLabel="Re-open"
          ToggleIcon={RotateCcw}
        />
      )}
    </div>
  )
}

function ClaimTable({
  title, description, claims, pending, onPrimary, onToggle, toggleLabel, ToggleIcon,
}: {
  title: string
  description: string
  claims: TerritoryClaim[]
  pending: boolean
  onPrimary?: (id: string) => void
  onToggle: (id: string) => void
  toggleLabel: string
  ToggleIcon: typeof XCircle
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {claims.map((c) => {
          const Icon = GRAIN_ICON[c.grain]
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-sm font-medium">{c.zipCode}</span>
              <span className="text-sm text-muted-foreground">
                {[c.city, c.state].filter(Boolean).join(", ") || "—"}
              </span>
              <Badge variant="outline">
                {GRAIN_LABEL[c.grain]}
                {c.grain === "team" && c.teamName ? ` · ${c.teamName}` : ""}
                {c.grain === "agent" && c.agentName ? ` · ${c.agentName}` : ""}
              </Badge>
              {c.isPrimary && <Badge className="gap-1"><Star className="h-3 w-3" /> Primary</Badge>}
              {c.feedsRotation
                ? <Badge variant="secondary">Receives platform leads</Badge>
                : <Badge variant="outline" className="text-muted-foreground">Internal only</Badge>}
              <div className="ml-auto flex gap-2">
                {onPrimary && !c.isPrimary && (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => onPrimary(c.id)}>
                    <Star className="mr-1 h-3.5 w-3.5" /> Make primary
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onToggle(c.id)}>
                  <ToggleIcon className="mr-1 h-3.5 w-3.5" /> {toggleLabel}
                </Button>
              </div>
            </div>
          )
        })}
        {claims.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
      </CardContent>
    </Card>
  )
}
