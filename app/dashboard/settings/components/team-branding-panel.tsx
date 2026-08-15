"use client"

/**
 * app/dashboard/settings/components/team-branding-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE A TEAM LEAD SETS THEIR TEAM'S OWN LOGO AND BRAND.
 *
 * The owner's ruling — "teams also may have a different logo than the
 * brokerage" — was already true in the database and already honoured by
 * `lib/branding/resolve-brand-context.ts`, which cascades
 * `team.logo_url → brokerages.logo_url → global_settings.app_logo_url` on every
 * rendered piece. What did not exist was any screen that wrote those columns, so
 * the top rung of the cascade was permanently empty and the required setup task
 * "Set your team logo & colors" (lib/onboarding/setup-readiness.ts:210) pointed
 * at a page that redirected to user management.
 *
 * THE ONE THING THIS PANEL MUST TEACH: blank means INHERIT, not "nothing".
 * Clearing the logo here does not remove the logo from the team's postcards — it
 * hands the slot back to the brokerage. A lead who cannot see that will clear a
 * field, still see a logo, and conclude the form is broken. So every field
 * states what it falls through to, and the header shows what the pieces render
 * TODAY with the resolver's own source labels (team / brokerage / default).
 * Those inherited values are not recomputed here; they come from
 * `resolveBrandContext` with no team on top, via loadTeamBranding().
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Palette, Users, Info } from "lucide-react"
import { toast } from "sonner"
import {
  loadTeamBranding,
  saveTeamBranding,
  type TeamBrandingSnapshot,
  type TeamBrandOption,
} from "@/app/actions/team-branding"

/** The form's shape — every field a string, because "" is how a user says
 *  "inherit this from the brokerage". */
interface FormState {
  logoUrl: string
  primaryColor: string
  accentColor: string
  tagline: string
  website: string
  phone: string
  bioText: string
}

const EMPTY_FORM: FormState = {
  logoUrl: "",
  primaryColor: "",
  accentColor: "",
  tagline: "",
  website: "",
  phone: "",
  bioText: "",
}

function formFromTeam(team: TeamBrandOption | undefined): FormState {
  if (!team) return EMPTY_FORM
  return {
    logoUrl: team.values.logoUrl ?? "",
    primaryColor: team.values.primaryColor ?? "",
    accentColor: team.values.accentColor ?? "",
    tagline: team.values.tagline ?? "",
    website: team.values.website ?? "",
    phone: team.values.phone ?? "",
    bioText: team.values.bioText ?? "",
  }
}

/** The line under every field that makes the cascade legible. */
function InheritNote({ value, from }: { value: string | null; from: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {value ? (
        <>
          Leave blank to inherit <span className="font-medium text-foreground">{value}</span> from {from}.
        </>
      ) : (
        <>Leave blank to inherit from {from} — which has not set one either, so the piece shows nothing here.</>
      )}
    </p>
  )
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-4 w-4 rounded border border-border align-middle"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}

const SOURCE_LABEL: Record<string, string> = {
  team: "your team",
  brokerage: "the brokerage",
  agent: "the agent",
  default: "the platform default",
  none: "nothing set",
}

export function TeamBrandingPanel() {
  const [snap, setSnap] = useState<TeamBrandingSnapshot | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saved, setSaved] = useState<FormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  const apply = useCallback((s: TeamBrandingSnapshot, preferId?: string | null) => {
    setSnap(s)
    const id = preferId && s.teams.some((t) => t.id === preferId) ? preferId : s.activeTeamId
    setActiveId(id)
    const f = formFromTeam(s.teams.find((t) => t.id === id))
    setForm(f)
    setSaved(f)
  }, [])

  useEffect(() => {
    let cancelled = false
    loadTeamBranding().then((s) => {
      if (cancelled) return
      if (!s.ok && s.error) toast.error(s.error)
      apply(s)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [apply])

  function selectTeam(id: string) {
    if (!snap) return
    setActiveId(id)
    const f = formFromTeam(snap.teams.find((t) => t.id === id))
    setForm(f)
    setSaved(f)
  }

  const dirty = (Object.keys(form) as Array<keyof FormState>).some((k) => form[k] !== saved[k])

  function save() {
    if (!activeId) return
    startTransition(async () => {
      const res = await saveTeamBranding({ teamId: activeId, ...form })
      if (!res.success) {
        toast.error(res.error ?? "Could not save your team's brand.")
        return
      }
      if (res.snapshot) apply(res.snapshot, activeId)
      toast.success("Team brand saved. Your team's pieces use it from now on.")
    })
  }

  // ── Honest empty states, never a broken form ─────────────────────────────
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4" />
            Team Brand
          </CardTitle>
          <CardDescription>Loading your team…</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (snap && !snap.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4" />
            Team Brand
          </CardTitle>
          <CardDescription className="text-destructive">
            {snap.error ?? "Your team could not be read."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  // Not a team lead, and not a broker/admin — or an admin whose brokerage has no
  // teams yet. Say which, plainly, instead of rendering a form that saves nothing.
  if (!snap || snap.access === "none" || !activeId) {
    const noTeamsYet = snap?.access === "admin" && snap.teams.length === 0
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4" />
            Team Brand
          </CardTitle>
          <CardDescription>
            {noTeamsYet
              ? "Your brokerage has no teams yet. Create a team first, and its own logo and colours can be set here."
              : "You don't lead a team, so there is no team brand to set here. A team's brand is set by that team's lead — the person recorded as the team's lead — or by a broker or admin at your brokerage. Your pieces use the brokerage's brand."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const cascade = snap.cascade
  const activeTeam = snap.teams.find((t) => t.id === activeId)
  const canPickTeam = snap.access === "admin" && snap.teams.length > 1

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="h-4 w-4" />
          Team Brand
          {activeTeam?.isLed && (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              You lead this team
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Your team may carry a different logo and colours from the brokerage. Anything you set here
          replaces the brokerage&apos;s on your team&apos;s postcards, emails, videos and public team page.
          <strong> Anything you leave blank is inherited</strong>, field by field — so you can take the
          brokerage&apos;s logo and still use your own colours.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Which team — admins only, and only when there is a choice to make. */}
        {canPickTeam && (
          <div className="space-y-2">
            <Label htmlFor="team-brand-team">Team</Label>
            <Select value={activeId} onValueChange={selectTeam} disabled={isPending}>
              <SelectTrigger id="team-brand-team">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {snap.teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!canPickTeam && activeTeam && (
          <div className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{activeTeam.name}</span>
          </div>
        )}

        {/* WHAT THE PIECES SHOW TODAY — the resolver's own answer, with its own
            source labels, so the cascade is a visible fact rather than a claim. */}
        {cascade && (
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <p className="text-xs font-medium flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              What your team&apos;s pieces show right now
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                Name shown: <span className="font-medium text-foreground">{cascade.effective.displayName}</span>
              </span>
              <span className="flex items-center gap-1.5">
                Logo:
                {cascade.effective.logoUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={cascade.effective.logoUrl}
                    alt=""
                    className="h-5 max-w-[110px] object-contain"
                  />
                ) : (
                  <span className="font-medium text-foreground">none</span>
                )}
                <Badge variant="outline" className="text-[10px]">
                  from {SOURCE_LABEL[cascade.effective.logoSource] ?? cascade.effective.logoSource}
                </Badge>
              </span>
              <span className="flex items-center gap-1.5">
                Colours: <Swatch color={cascade.effective.primaryColor} />
                <Swatch color={cascade.effective.accentColor} />
                <Badge variant="outline" className="text-[10px]">
                  from {SOURCE_LABEL[cascade.effective.colorSource] ?? cascade.effective.colorSource}
                </Badge>
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The brokerage of record stays {cascade.brokerageName} on every piece — a team logo changes the
              branding, never who signs the Fair Housing and licence line.
            </p>
          </div>
        )}

        {/* ── The fields ─────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label htmlFor="team-logo-url">Team logo URL</Label>
          <Input
            id="team-logo-url"
            type="url"
            inputMode="url"
            placeholder="https://cdn.example.com/team-logo.png"
            value={form.logoUrl}
            onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
            disabled={isPending}
          />
          <InheritNote value={cascade?.inherited.logoUrl ?? null} from="the brokerage" />
          {form.logoUrl.trim() && (
            <div className="pt-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={form.logoUrl}
                alt="Team logo preview"
                className="h-10 max-w-[200px] object-contain rounded border bg-background p-1"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="team-primary-color">Primary colour</Label>
            <div className="flex items-center gap-2">
              <Input
                id="team-primary-color"
                placeholder={cascade?.inherited.primaryColor ?? "#1d4ed8"}
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                disabled={isPending}
              />
              <Swatch color={form.primaryColor.trim() || cascade?.inherited.primaryColor || "#0f172a"} />
            </div>
            <InheritNote value={cascade?.inherited.primaryColor ?? null} from="the brokerage" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="team-accent-color">Accent colour</Label>
            <div className="flex items-center gap-2">
              <Input
                id="team-accent-color"
                placeholder={cascade?.inherited.accentColor ?? "#f59e0b"}
                value={form.accentColor}
                onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                disabled={isPending}
              />
              <Swatch color={form.accentColor.trim() || cascade?.inherited.accentColor || "#f59e0b"} />
            </div>
            <InheritNote value={cascade?.inherited.accentColor ?? null} from="the brokerage" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="team-tagline">Tagline</Label>
          <Input
            id="team-tagline"
            placeholder="The line under your team's name"
            value={form.tagline}
            onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            disabled={isPending}
            maxLength={160}
          />
          <InheritNote value={cascade?.inherited.tagline ?? null} from="the brokerage" />
          <p className="text-xs text-muted-foreground">
            An agent who has written their own personal motto keeps it on their own pieces — a team
            tagline is what everyone else on the team falls back to.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="team-website">Team website</Label>
            <Input
              id="team-website"
              type="url"
              inputMode="url"
              placeholder="https://williamselite.com"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              disabled={isPending}
            />
            <InheritNote value={cascade?.inherited.website ?? null} from="the brokerage" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="team-phone">Team phone</Label>
            <Input
              id="team-phone"
              type="tel"
              placeholder="(555) 010-2200"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              disabled={isPending}
              maxLength={32}
            />
            <InheritNote value={cascade?.inherited.phone ?? null} from="the brokerage" />
            <p className="text-xs text-muted-foreground">
              An agent&apos;s own office number wins on a piece they sign; this is the team&apos;s number
              underneath it.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="team-bio">Team bio</Label>
          <Textarea
            id="team-bio"
            rows={3}
            placeholder="A short paragraph about your team."
            value={form.bioText}
            onChange={(e) => setForm({ ...form, bioText: e.target.value })}
            disabled={isPending}
            maxLength={2000}
          />
          <p className="text-xs text-muted-foreground">
            Shown on your public team page. Unlike the fields above it is not inherited — the brokerage&apos;s
            description is never shown as your team&apos;s.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Clearing a field hands that one slot back to the brokerage.
          </p>
          <Button size="sm" onClick={save} disabled={!dirty || isPending}>
            {isPending ? "Saving…" : "Save team brand"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
