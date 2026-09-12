"use client"

/**
 * app/dashboard/settings/components/team-branding-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE A TEAM LEAD SETS THEIR TEAM'S OWN BRAND, SPLIT AND SIGNATURE.
 *
 * Three cards, one screen, one team — because all three are the same person's
 * job and all three were columns with a READER AND NO WRITER:
 *
 *   1. TEAM BRAND — `teams.logo_url` and friends, read by
 *      `lib/branding/resolve-brand-context.ts` on every rendered piece.
 *   2. TEAM SPLIT AND TEAM CAP — `teams.team_split_*` / `terms_effective_date`,
 *      read by `lib/commission/waterfall/08-team-split.ts` on every closing, plus
 *      `teams.cap_amount` (m461), the ceiling on what that split may collect from
 *      one agent in a year. The REQUIRED onboarding item `lead_team_splits` sends
 *      a team lead to THIS page to set them, and until now this page could not.
 *   3. TEAM EMAIL SIGNATURE — `teams.branding_override.email_signature_html`,
 *      read by `lib/kernel/communications/assemble-email.ts` as tier 2 of the
 *      signature waterfall.
 *
 * WHAT THIS PANEL MUST TEACH, and each is a real defect if it does not:
 *
 *   • BLANK MEANS INHERIT on the brand. Clearing the logo does not remove the
 *     logo from the team's postcards — it hands the slot back to the brokerage.
 *   • THE SPLIT IS THE TEAM'S CUT, taken OUT of a team agent's net, and it does
 *     not start until `terms_effective_date`. A lead who reads "20%" as "the
 *     agent keeps 20%" has agreed to the opposite of what they meant, so the
 *     form states the direction of the money in dollars.
 *   • THE TEAM SIGNATURE IS A FALLBACK. It is used only for a teammate who has
 *     not written their own, and the email builder finds it through that
 *     person's ASSIGNED TEAM (`users.team_id`) — so the panel shows how many
 *     people it can actually reach rather than implying delivery.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
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
import { Palette, Users, Info, Percent, AlertTriangle, Mail } from "lucide-react"
import { toast } from "sonner"
import {
  loadTeamBranding,
  saveTeamBranding,
  saveTeamSplits,
  saveTeamSignature,
  saveTeamRevenueGoal,
  loadTeamRevenueGoal,
  type TeamBrandingSnapshot,
  type TeamBrandOption,
  type TeamSplitType,
} from "@/app/actions/team-branding"

/** The brand form's shape — every field a string, because "" is how a user says
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

/** The split form. `splitType` is always one of the two — never inferred from
 *  which box has a number in it, because the waterfall reads the TYPE alone. */
interface SplitForm {
  splitType: TeamSplitType
  percent: string
  flatDollars: string
  effectiveDate: string
  /** `teams.cap_amount` as typed. "" means UNCAPPED — what every team was before
   *  m461 — and is a different answer from "0". */
  capAmount: string
}

const EMPTY_SPLIT: SplitForm = {
  splitType: "percent",
  percent: "",
  flatDollars: "",
  effectiveDate: "",
  capAmount: "",
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

function splitFromTeam(team: TeamBrandOption | undefined): SplitForm {
  if (!team) return EMPTY_SPLIT
  return {
    // A row nobody has written reads as NULL here; the form opens on "percent"
    // because that is what the waterfall would treat a NULL as anyway — but
    // saving stores the choice explicitly rather than leaving it to a default.
    splitType: team.splits.splitType ?? "percent",
    percent: team.splits.percent != null ? String(team.splits.percent) : "",
    flatDollars: team.splits.flatDollars != null ? String(team.splits.flatDollars) : "",
    effectiveDate: team.splits.effectiveDate ?? "",
    // NULL and 0 are distinct facts here, so the coercion is explicit rather
    // than `String(x ?? "")` — which would turn 0 into "0" correctly but only
    // by accident, and any future `|| ""` would turn it into "uncapped".
    capAmount: team.splits.capAmount != null ? String(team.splits.capAmount) : "",
  }
}

function signatureFromTeam(team: TeamBrandOption | undefined): string {
  return team?.signature.html ?? ""
}

/** The line under every brand field that makes the cascade legible. */
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

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })

/** The worked example under the split fields.
 *
 *  Mirrors `lib/commission/team-lead-split.ts:resolveTeamLeadOverride` — percent
 *  of the agent's NET, or flat dollars, CLAMPED to the net so the agent can
 *  never go negative. It is a preview of that function's answer on a round
 *  number, not a second rule: the money is computed server-side by the waterfall
 *  and this only shows which way it flows. */
function splitExample(type: TeamSplitType, percent: string, flat: string): string | null {
  const net = 10000
  const raw = type === "percent" ? Number(percent) : Number(flat)
  if (!Number.isFinite(raw) || raw < 0 || String(type === "percent" ? percent : flat).trim() === "") return null
  const team = Math.min(type === "percent" ? Math.round(net * (raw / 100)) : Math.round(raw), net)
  if (team <= 0) {
    return `On a ${USD.format(net)} net commission the team takes nothing and the agent keeps all ${USD.format(net)}.`
  }
  return `On a ${USD.format(net)} net commission the team takes ${USD.format(team)} and the agent keeps ${USD.format(net - team)}.`
}

/** What the cap means in the terms the lead just typed above it.
 *
 *  Only the arithmetic that follows DIRECTLY from the two numbers on the form —
 *  how much production, or how many closings, it takes to reach the ceiling.
 *  Nothing here re-implements the ledger: `team_cap_tracking.cap_paid_to_date` is
 *  what the engine actually counts, and this is only a sanity check on the
 *  number being entered. Returns null when there is nothing honest to say. */
function capPreview(capRaw: string, type: TeamSplitType, percent: string, flat: string): string | null {
  const t = capRaw.trim().replace(/,/g, "").replace(/^\$/, "").trim()
  if (!t || !/^\d+(?:\.\d+)?$/.test(t)) return null
  const cap = Number(t)
  if (!Number.isFinite(cap)) return null
  if (cap === 0) {
    return "A cap of $0 means the team collects nothing from its agents at all — the split above never applies. Leave this blank instead if you meant \"no cap\"."
  }
  if (type === "percent") {
    const pct = Number(percent)
    if (!Number.isFinite(pct) || pct <= 0 || percent.trim() === "") {
      return `The team collects at most ${USD.format(cap)} from each agent per year.`
    }
    const netToReach = cap / (pct / 100)
    return `At ${pct}% of net, an agent reaches this ${USD.format(cap)} cap after about ${USD.format(netToReach)} of net commission in their year. After that the team takes nothing more from them until the year resets.`
  }
  const per = Number(flat)
  if (!Number.isFinite(per) || per <= 0 || flat.trim() === "") {
    return `The team collects at most ${USD.format(cap)} from each agent per year.`
  }
  const closings = Math.ceil(cap / per)
  return `At ${USD.format(per)} per closing, an agent reaches this ${USD.format(cap)} cap after ${closings} closing${closings === 1 ? "" : "s"} in their year. After that the team takes nothing more from them until the year resets.`
}

export function TeamBrandingPanel() {
  const [snap, setSnap] = useState<TeamBrandingSnapshot | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saved, setSaved] = useState<FormState>(EMPTY_FORM)
  const [split, setSplit] = useState<SplitForm>(EMPTY_SPLIT)
  const [savedSplit, setSavedSplit] = useState<SplitForm>(EMPTY_SPLIT)
  const [sig, setSig] = useState("")
  const [savedSig, setSavedSig] = useState("")
  const [loading, setLoading] = useState(true)
  const [brandPending, startBrand] = useTransition()
  const [splitPending, startSplit] = useTransition()
  const [sigPending, startSig] = useTransition()

  // ── TEAM REVENUE GOAL ──────────────────────────────────────────────────────
  // team_performance.goal_amount is what four surfaces divide by to state
  // attainment; nothing could set it until now, so every team read 0%.
  const [goal, setGoal] = useState("")
  const [savedGoal, setSavedGoal] = useState("")
  const [goalPeriod, setGoalPeriod] = useState("")
  const [goalRevenue, setGoalRevenue] = useState<number | null>(null)
  const [goalPending, startGoal] = useTransition()

  const apply = useCallback((s: TeamBrandingSnapshot, preferId?: string | null) => {
    setSnap(s)
    const id = preferId && s.teams.some((t) => t.id === preferId) ? preferId : s.activeTeamId
    setActiveId(id)
    const team = s.teams.find((t) => t.id === id)
    const f = formFromTeam(team)
    setForm(f)
    setSaved(f)
    const sp = splitFromTeam(team)
    setSplit(sp)
    setSavedSplit(sp)
    const sg = signatureFromTeam(team)
    setSig(sg)
    setSavedSig(sg)
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
    apply(snap, id)
  }

  const dirty = (Object.keys(form) as Array<keyof FormState>).some((k) => form[k] !== saved[k])
  const splitDirty = (Object.keys(split) as Array<keyof SplitForm>).some((k) => split[k] !== savedSplit[k])
  const sigDirty = sig !== savedSig

  const example = useMemo(
    () => splitExample(split.splitType, split.percent, split.flatDollars),
    [split.splitType, split.percent, split.flatDollars],
  )
  const capPreviewText = useMemo(
    () => capPreview(split.capAmount, split.splitType, split.percent, split.flatDollars),
    [split.capAmount, split.splitType, split.percent, split.flatDollars],
  )
  const futureTerms = useMemo(() => {
    if (!split.effectiveDate) return false
    return split.effectiveDate > new Date().toISOString().slice(0, 10)
  }, [split.effectiveDate])

  function save() {
    if (!activeId) return
    startBrand(async () => {
      const res = await saveTeamBranding({ teamId: activeId, ...form })
      if (!res.success) {
        toast.error(res.error ?? "Could not save your team's brand.")
        return
      }
      if (res.snapshot) apply(res.snapshot, activeId)
      toast.success("Team brand saved. Your team's pieces use it from now on.")
    })
  }

  function saveSplits() {
    if (!activeId) return
    startSplit(async () => {
      const res = await saveTeamSplits({ teamId: activeId, ...split })
      if (!res.success) {
        toast.error(res.error ?? "Could not save your team's split.")
        return
      }
      if (res.snapshot) apply(res.snapshot, activeId)
      toast.success(
        split.capAmount.trim()
          ? "Team split and cap saved. They apply to commissions calculated from now on."
          : "Team split saved, with no cap — the team keeps collecting all year. It applies to commissions calculated from now on.",
      )
    })
  }

  // Load the goal in force for the active team (and the revenue it is measured
  // against). A refused read is SHOWN, never rendered as "no goal set".
  useEffect(() => {
    if (!activeId) { setGoal(""); setSavedGoal(""); setGoalRevenue(null); return }
    let cancelled = false
    void loadTeamRevenueGoal({ teamId: activeId }).then((r) => {
      if (cancelled) return
      if (!r.success) { toast.error(r.error ?? "Could not read this team's revenue goal."); return }
      const g = r.goalAmount != null ? String(r.goalAmount) : ""
      setGoal(g)
      setSavedGoal(g)
      setGoalPeriod(r.periodLabel ?? "")
      setGoalRevenue(r.totalRevenue ?? null)
    })
    return () => { cancelled = true }
  }, [activeId])

  function saveGoal() {
    if (!activeId) return
    startGoal(async () => {
      const res = await saveTeamRevenueGoal({ teamId: activeId, goalAmount: goal })
      if (!res.success) {
        toast.error(res.error ?? "Could not save your team's revenue goal.")
        return
      }
      const g = res.goalAmount != null ? String(res.goalAmount) : ""
      setGoal(g)
      setSavedGoal(g)
      if (res.periodLabel) setGoalPeriod(res.periodLabel)
      toast.success(
        res.goalAmount != null
          ? `Revenue goal saved for ${res.periodLabel}. Attainment is measured against it from now on.`
          : "Revenue goal cleared. Attainment stops being reported for this period.",
      )
    })
  }

  function saveSignature() {
    if (!activeId) return
    startSig(async () => {
      const res = await saveTeamSignature({ teamId: activeId, signature: sig })
      if (!res.success) {
        toast.error(res.error ?? "Could not save your team's signature.")
        return
      }
      if (res.snapshot) apply(res.snapshot, activeId)
      toast.success(
        sig.trim() ? "Team signature saved." : "Team signature removed. Teammates fall back to the brokerage's.",
      )
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
            Team Settings
          </CardTitle>
          <CardDescription>
            {noTeamsYet
              ? "Your brokerage has no teams yet. Create a team first, and its own logo, colours, split and email signature can be set here."
              : "You don't lead a team, so there is nothing to set here. A team's brand, split and signature are set by that team's lead — the person recorded as the team's lead — or by a broker or admin at your brokerage. Your pieces use the brokerage's brand."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const cascade = snap.cascade
  const activeTeam = snap.teams.find((t) => t.id === activeId)
  const canPickTeam = snap.access === "admin" && snap.teams.length > 1
  const preservedKeys = activeTeam?.signature.otherKeys ?? []
  const unmergeable = activeTeam?.signature.unmergeable ?? false
  const reach = snap.signatureReachCount

  return (
    <div className="space-y-6">
      {/* Which team — admins only, and only when there is a choice to make. It
          sits above the cards because all three of them write the same row. */}
      {canPickTeam ? (
        <div className="space-y-2">
          <Label htmlFor="team-brand-team">Team</Label>
          <Select value={activeId} onValueChange={selectTeam}>
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
      ) : (
        activeTeam && (
          <div className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{activeTeam.name}</span>
            {activeTeam.isLed && (
              <Badge variant="secondary" className="text-[10px]">
                You lead this team
              </Badge>
            )}
          </div>
        )
      )}

      {/* ── 1. BRAND ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4" />
            Team Brand
          </CardTitle>
          <CardDescription>
            Your team may carry a different logo and colours from the brokerage. Anything you set here
            replaces the brokerage&apos;s on your team&apos;s postcards, emails, videos and public team page.
            <strong> Anything you leave blank is inherited</strong>, field by field — so you can take the
            brokerage&apos;s logo and still use your own colours.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
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
              disabled={brandPending}
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
                  disabled={brandPending}
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
                  disabled={brandPending}
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
              disabled={brandPending}
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
                disabled={brandPending}
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
                disabled={brandPending}
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
              disabled={brandPending}
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
            <Button size="sm" onClick={save} disabled={!dirty || brandPending}>
              {brandPending ? "Saving…" : "Save team brand"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 2. SPLIT ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Percent className="h-4 w-4" />
            Team Split &amp; Cap
          </CardTitle>
          <CardDescription>
            What the team takes out of a team agent&apos;s commission. This is the agreement the
            commission calculation applies on every closing by an agent on this team: the amount is
            <strong> deducted from that agent&apos;s net and paid to the team lead</strong>. It never
            applies to the lead&apos;s own deals, and it is taken after any per-member splits.
            The <strong>cap</strong> below is the ceiling on that same cut — the most the team may
            collect from one agent in an anniversary year.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="team-split-type">How the team is paid</Label>
            <Select
              value={split.splitType}
              onValueChange={(v) => setSplit({ ...split, splitType: v as TeamSplitType })}
              disabled={splitPending}
            >
              <SelectTrigger id="team-split-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percent">A percentage of the agent&apos;s net commission</SelectItem>
                <SelectItem value="flat">A flat amount per closing</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Choose one. The calculation reads this choice, not which box you filled in — so the other
              box is cleared when you save.
            </p>
          </div>

          {split.splitType === "percent" ? (
            <div className="space-y-2">
              <Label htmlFor="team-split-percent">The team&apos;s percentage</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="team-split-percent"
                  inputMode="decimal"
                  placeholder="20"
                  value={split.percent}
                  onChange={(e) => setSplit({ ...split, percent: e.target.value })}
                  disabled={splitPending}
                  className="max-w-[140px]"
                />
                <span className="text-sm text-muted-foreground">% of the agent&apos;s net</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Between 0 and 100, at most two decimal places. Enter <strong>0</strong> if the team takes
                no cut — that is a real answer and it completes this setting.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="team-split-flat">The team&apos;s flat amount</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  id="team-split-flat"
                  inputMode="decimal"
                  placeholder="500"
                  value={split.flatDollars}
                  onChange={(e) => setSplit({ ...split, flatDollars: e.target.value })}
                  disabled={splitPending}
                  className="max-w-[160px]"
                />
                <span className="text-sm text-muted-foreground">per closing</span>
              </div>
              <p className="text-xs text-muted-foreground">
                A dollar amount, at most two decimal places. If it is more than the agent&apos;s net on a
                deal, the team takes the whole net and the agent is never driven negative.
              </p>
            </div>
          )}

          {example && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                Which way the money goes
              </p>
              <p className="text-xs text-muted-foreground mt-1">{example}</p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="team-split-date">These terms start on</Label>
            <Input
              id="team-split-date"
              type="date"
              value={split.effectiveDate}
              onChange={(e) => setSplit({ ...split, effectiveDate: e.target.value })}
              disabled={splitPending}
              className="max-w-[200px]"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank for &quot;always in effect&quot;. Until this date arrives the team split is not
              applied at all — commissions calculate as if there were no team agreement.
            </p>
            {futureTerms && (
              <p className="text-xs text-amber-600 dark:text-amber-500 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                This date is in the future, so the team takes nothing until {split.effectiveDate}.
              </p>
            )}
          </div>

          {/* ── THE TEAM CAP ─────────────────────────────────────────────────
              OWNER RULING: "brokerage and teams may also have commission caps."
              It sits beside the split because it is the ceiling on that same
              cut: the split says how much per closing, the cap says when the
              team stops taking it. Until m461 the brokerage's cap stopped the
              brokerage and nothing stopped the team. */}
          <div className="space-y-2 border-t pt-5">
            <Label htmlFor="team-cap-amount">The team&apos;s cap</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                id="team-cap-amount"
                inputMode="decimal"
                placeholder="Leave blank for no cap"
                value={split.capAmount}
                onChange={(e) => setSplit({ ...split, capAmount: e.target.value })}
                disabled={splitPending}
                className="max-w-[200px]"
              />
              <span className="text-sm text-muted-foreground">per agent, per year</span>
            </div>
            <p className="text-xs text-muted-foreground">
              The most this team collects from <strong>each</strong> of its agents in an anniversary
              year. Once an agent has paid the team this much, the split above stops being taken from
              that agent for the rest of their year.
            </p>
            {/* HONEST ABOUT THE SEAM. `08-team-split.ts` enforces this ceiling by
                reading `team_cap_tracking` — the team's per-agent ledger — and a
                cap with no ledger row reads as uncapped ("an unseeded cap is an
                unenforced cap", stated in that stage). Saying otherwise here
                would be the same class of claim this whole change exists to
                stop: a number on a screen that no cheque is measured against. */}
            <p className="text-xs text-muted-foreground">
              A cap takes effect for an agent once their team cap ledger has been opened for the
              current year. Until then the calculation treats that agent as uncapped, so check with
              your broker if a cap you have set is not showing up in a payout.
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>Leave it blank for no cap</strong> — which is what every team had until now.
              Entering <strong>0</strong> is a different answer: it means the team collects nothing at
              all. At most two decimal places; a longer number is refused rather than rounded, because
              a rounded cap is not the cap you agreed.
            </p>
            {capPreviewText && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5" />
                  What the cap means here
                </p>
                <p className="text-xs text-muted-foreground mt-1">{capPreviewText}</p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-xs text-muted-foreground">
              Applies to commissions calculated after you save; already-finalised commissions are not
              recalculated.
            </p>
            <Button size="sm" onClick={saveSplits} disabled={!splitDirty || splitPending}>
              {splitPending ? "Saving…" : "Save team split"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 3. EMAIL SIGNATURE ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            Team Email Signature
          </CardTitle>
          <CardDescription>
            <strong>This is a fallback, not an override.</strong> Anyone who has written their own
            signature keeps theirs — this one is appended for teammates who have not written one. If
            neither exists, the brokerage&apos;s signature is used. So if your own emails ignore what you
            type here, that is why: write yours in your personal settings, or clear it to fall back to this.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {reach === 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                Nobody is currently reached by this signature
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Outgoing mail finds a team signature through the sender&apos;s <em>assigned team</em> on their
                own user record, and no one at your brokerage is assigned to this team yet. Being on the
                roster or being the lead is not the same thing. Set it here and an administrator can assign
                the team on each member&apos;s user record; until then this signature is stored but unused.
              </p>
            </div>
          )}
          {reach !== null && reach > 0 && (
            <p className="text-xs text-muted-foreground">
              {reach === 1 ? "1 person is" : `${reach} people are`} assigned to this team, so this signature
              reaches {reach === 1 ? "them" : "any of them"} who have not written their own.
            </p>
          )}

          {unmergeable && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                This team&apos;s stored branding cannot be edited here
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                The team&apos;s branding settings hold something other than a settings object. Saving would
                overwrite it, so saving is refused. An administrator should inspect it first.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="team-signature">Signature</Label>
            <Textarea
              id="team-signature"
              rows={6}
              placeholder={"The Williams Elite Team\n(555) 010-2200\nwilliamselite.com"}
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              disabled={sigPending || unmergeable}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Plain text is fine — line breaks are kept. Simple HTML is also accepted:{" "}
              <code className="text-[11px]">
                &lt;b&gt; &lt;i&gt; &lt;u&gt; &lt;br&gt; &lt;p&gt; &lt;div&gt; &lt;span&gt; &lt;small&gt;
                &lt;ul&gt; &lt;ol&gt; &lt;li&gt; &lt;a&gt; &lt;img&gt;
              </code>
              . Links and images must use full https:// addresses (or mailto: for links), and every
              attribute must be quoted.
            </p>
            <p className="text-xs text-muted-foreground">
              Pasted rich signatures with inline <code className="text-[11px]">style</code> or table layout
              are <strong>refused, not silently stripped</strong>, and you will be told which tag caused it.
              Mail clients rewrite inline styling anyway — set your team&apos;s colours in Team Brand above.
            </p>
            <p className="text-xs text-muted-foreground">Clearing this box removes the team signature.</p>
          </div>

          {savedSig && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Preview of the saved signature</p>
              {/* Rendered in a fully sandboxed frame (no scripts, no same-origin
                  access) and only ever from the SAVED, server-validated value —
                  never from what is being typed. */}
              <iframe
                title="Team email signature preview"
                sandbox=""
                srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:8px;font:13px/1.5 system-ui,-apple-system,sans-serif;color:#111;background:#fff">${savedSig}</body>`}
                className="w-full h-28 rounded border bg-white"
              />
              <p className="text-[11px] text-muted-foreground">
                The preview updates when you save.
              </p>
            </div>
          )}

          {preservedKeys.length > 0 && (
            <p className="text-xs text-muted-foreground">
              This team&apos;s branding settings also hold{" "}
              <span className="font-medium text-foreground">{preservedKeys.join(", ")}</span>. Saving the
              signature leaves {preservedKeys.length === 1 ? "it" : "them"} untouched.
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <Button size="sm" onClick={saveSignature} disabled={!sigDirty || sigPending || unmergeable}>
              {sigPending ? "Saving…" : "Save team signature"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 4. TEAM REVENUE GOAL ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Percent className="h-4 w-4" />
            Team Revenue Goal
          </CardTitle>
          <CardDescription>
            The revenue target this team is measured against for{" "}
            <span className="font-medium text-foreground">{goalPeriod || "this month"}</span>. Team
            attainment on the reports and the financials dashboard is this number divided into the
            revenue the nightly rollup measured — with no goal set, attainment cannot be reported at
            all.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="team-goal">Goal for this month ($)</Label>
            <Input
              id="team-goal"
              inputMode="decimal"
              placeholder="e.g. 250000"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={goalPending}
            />
            <p className="text-xs text-muted-foreground">
              {goalRevenue != null
                ? `Measured revenue so far this period: $${Number(goalRevenue).toLocaleString()}.`
                : "The nightly rollup has not measured revenue for this period yet, so attainment stays blank until it does."}{" "}
              Clearing this box removes the goal.
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <Button size="sm" onClick={saveGoal} disabled={goal === savedGoal || goalPending}>
              {goalPending ? "Saving…" : "Save revenue goal"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
