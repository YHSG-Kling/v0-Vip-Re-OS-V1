"use client"

import { useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Shield, Plus, Trash2, Users, Building2, User, Layers } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeatureFlag {
  id: string
  feature_key: string
  display_name: string
  description: string | null
  category: string | null
  enabled: boolean | null
  beta: boolean | null
  deprecated: boolean | null
  superadmin_only: boolean | null
  solo_agent_access: boolean | null
  team_access: boolean | null
  brokerage_access: boolean | null
  multi_location_access: boolean | null
  updated_at: string | null
}

interface AccessOverride {
  id: string
  user_id: string | null
  brokerage_id: string | null
  team_id: string | null
  feature_key: string
  override_type: string | null
  trial_ends_at: string | null
  notes: string | null
  created_at: string | null
  created_by: string | null
  // feature_access_overrides → users carries TWO FKs (user_id = the person GOVERNED,
  // created_by = the admin who GRANTED). Each embed names its own constraint and is
  // aliased, so the two never collapse into one `users` key.
  grantee: { id: string; email: string } | null
  granted_by: { id: string; email: string } | null
}

interface FeatureGovernanceClientProps {
  flags: FeatureFlag[]
  overrides: AccessOverride[]
  usageMap: Record<string, number>
  brokerageId: string
  isSuperadmin: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function TierIcon({
  label,
  active,
}: {
  label: string
  active: boolean | null
}) {
  const icons: Record<string, React.ReactNode> = {
    solo: <User className="h-4 w-4" />,
    team: <Users className="h-4 w-4" />,
    brokerage: <Building2 className="h-4 w-4" />,
    multi: <Layers className="h-4 w-4" />,
  }
  return (
    <span
      className={active ? "text-primary" : "text-muted-foreground/30"}
      title={label}
    >
      {icons[label]}
    </span>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FeatureGovernanceClient({
  flags,
  overrides: initialOverrides,
  usageMap,
  brokerageId,
  isSuperadmin,
}: FeatureGovernanceClientProps) {
  const router = useRouter()
  const supabase = createClient()
  const [isPending, startTransition] = useTransition()

  // Local flag enabled state for optimistic toggles
  const [flagStates, setFlagStates] = useState<Record<string, boolean>>(
    Object.fromEntries(flags.map((f) => [f.id, f.enabled ?? false]))
  )
  const [overrides, setOverrides] = useState(initialOverrides)

  // Grant trial sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [grantEmail, setGrantEmail] = useState("")
  const [grantFeatureKey, setGrantFeatureKey] = useState("")
  const [grantNotes, setGrantNotes] = useState("")
  const [grantPending, setGrantPending] = useState(false)

  // Group flags by category
  const grouped = flags.reduce<Record<string, FeatureFlag[]>>((acc, f) => {
    const cat = f.category ?? "Uncategorized"
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(f)
    return acc
  }, {})
  const categories = Object.keys(grouped).sort()

  // Usage analytics: sort by usage desc, split into used vs zero
  const flagsWithUsage = flags
    .map((f) => ({ ...f, uses: usageMap[f.feature_key] ?? 0 }))
    .sort((a, b) => b.uses - a.uses)
  const usedFlags = flagsWithUsage.filter((f) => f.uses > 0)
  const zeroFlags = flagsWithUsage.filter((f) => f.uses === 0)

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleFlagToggle(flagId: string, flagKey: string, next: boolean) {
    if (!isSuperadmin) {
      toast.error("Only superadmins can toggle feature flags")
      return
    }
    setFlagStates((prev) => ({ ...prev, [flagId]: next }))
    const { error } = await supabase
      .from("feature_flags")
      .update({ enabled: next })
      .eq("id", flagId)
    if (error) {
      setFlagStates((prev) => ({ ...prev, [flagId]: !next }))
      toast.error("Failed to update flag")
    } else {
      toast.success(`${flagKey} ${next ? "enabled" : "disabled"}`)
    }
  }

  // Percentage rollout: deterministic per-tenant cohort (resolveEntitlement step 4).
  // 100 = fully rolled out; an explicit grant_trial override can still pull one
  // tenant into a partial rollout.
  async function handleRolloutChange(flagId: string, flagKey: string, pct: number) {
    if (!isSuperadmin) {
      toast.error("Only superadmins can change rollout percentage")
      return
    }
    const clamped = Math.max(0, Math.min(100, Math.round(pct)))
    const { error } = await supabase
      .from("feature_flags")
      .update({ rollout_percentage: clamped })
      .eq("id", flagId)
    if (error) toast.error("Failed to update rollout")
    else toast.success(`${flagKey} rolling out to ${clamped}% of tenants`)
  }

  async function handleRevoke(overrideId: string) {
    const { error } = await supabase
      .from("feature_access_overrides")
      .delete()
      .eq("id", overrideId)
    if (error) {
      toast.error("Failed to revoke override")
    } else {
      setOverrides((prev) => prev.filter((o) => o.id !== overrideId))
      toast.success("Override revoked")
    }
  }

  async function handleGrantTrial() {
    if (!grantEmail || !grantFeatureKey) {
      toast.error("Email and feature are required")
      return
    }
    setGrantPending(true)

    // Who is actually granting this. The row previously recorded created_by as the
    // TARGET user ("caller id not exposed — use target for now"), so every override on
    // this governance surface read as if the recipient had granted it to themselves.
    // On an audit trail, a wrong actor is worse than a missing one.
    const { data: { user: caller } } = await supabase.auth.getUser()
    if (!caller) {
      toast.error("Your session expired — sign in again to grant access")
      setGrantPending(false)
      return
    }

    // Look up user_id by email — SCOPED TO THIS BROKERAGE. The lookup was previously
    // global, so an email from another tenant resolved and produced an override row
    // binding a foreign user_id to this brokerage_id: a cross-tenant write through a
    // plain text field.
    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .select("id")
      .eq("email", grantEmail.trim().toLowerCase())
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (userErr || !userRow) {
      toast.error("No user in your brokerage has that email")
      setGrantPending(false)
      return
    }

    const trialEnd = new Date()
    trialEnd.setDate(trialEnd.getDate() + 30)

    const { data: inserted, error } = await supabase
      .from("feature_access_overrides")
      .insert({
        user_id: userRow.id,
        brokerage_id: brokerageId,
        feature_key: grantFeatureKey,
        override_type: "grant_trial",
        trial_ends_at: trialEnd.toISOString(),
        notes: grantNotes || null,
        created_by: caller.id,
      })
      // Same two-FK disambiguation as the server read (page.tsx) — the bare
      // `users(email)` here was ambiguous too (PGRST201), so the insert SUCCEEDED but
      // its returning select was refused: `inserted` came back null, the UI showed
      // "Failed to grant trial access", and an admin re-granting produced duplicate
      // override rows for a grant that had actually worked the first time.
      .select("id, user_id, brokerage_id, team_id, feature_key, override_type, trial_ends_at, notes, created_at, created_by, grantee:users!feature_access_overrides_user_id_fkey(id, email), granted_by:users!feature_access_overrides_created_by_fkey(id, email)")
      .single()

    if (error || !inserted) {
      toast.error("Failed to grant trial access")
    } else {
      setOverrides((prev) => [inserted as AccessOverride, ...prev])
      toast.success(`30-day trial granted for ${grantFeatureKey}`)
      setSheetOpen(false)
      setGrantEmail("")
      setGrantFeatureKey("")
      setGrantNotes("")
    }
    setGrantPending(false)
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Feature Governance</h1>
            <p className="text-sm text-muted-foreground">
              {isSuperadmin
                ? "Manage feature flags, trial access grants, and usage analytics"
                : "See which capabilities your tenant has, and grant early access to your own people"}
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="flags">
        <TabsList>
          <TabsTrigger value="flags">Feature Flags</TabsTrigger>
          <TabsTrigger value="overrides">
            Access Overrides
            {overrides.length > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs">{overrides.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="usage">Usage Analytics</TabsTrigger>
        </TabsList>

        {/* ── TAB 1: Feature Flags ───────────────────────────────────────── */}
        <TabsContent value="flags" className="mt-4 space-y-6">
          {/* Walkthrough [4]: "this is for platform and can't change enrollment so not
              really functional". The page admits admin/broker but every switch here is
              disabled={!isSuperadmin}, so a broker met a wall of dead controls with no
              explanation — indistinguishable from a broken page. Flag DEFINITIONS are
              genuinely platform-level (they decide what exists for every tenant, so one
              brokerage must not flip them). What a broker CAN do lives on the next tab,
              and this now says so instead of leaving them to guess. */}
          {!isSuperadmin && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">This tab is read-only for your role</p>
              <p className="text-muted-foreground mt-1">
                Feature flags decide what exists across every tenant on the platform, so they
                are set by platform staff — not per brokerage. Use it to see what your tier
                includes and how much your people are using it. To switch a capability on for
                someone in your brokerage early, use{" "}
                <span className="font-medium text-foreground">Access Overrides</span>, which
                you can change.
              </p>
            </div>
          )}
          {categories.map((cat) => (
            <div key={cat}>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {cat}
                </h2>
                <Badge variant="outline" className="text-xs">
                  {grouped[cat].length}
                </Badge>
              </div>

              <div className="rounded-lg border divide-y">
                {grouped[cat].map((flag) => (
                  <div
                    key={flag.id}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    {/* Left: name + description */}
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1 pr-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{flag.display_name}</span>
                        {flag.superadmin_only && (
                          <Badge variant="outline" className="text-[10px] border-amber-400 text-amber-600">
                            superadmin only
                          </Badge>
                        )}
                        {flag.beta && (
                          <Badge variant="outline" className="text-[10px]">beta</Badge>
                        )}
                        {flag.deprecated && (
                          <Badge variant="outline" className="text-[10px] border-red-400 text-red-600">
                            deprecated
                          </Badge>
                        )}
                        {(usageMap[flag.feature_key] ?? 0) > 0 && (
                          <Badge variant="secondary" className="text-[10px]">
                            {usageMap[flag.feature_key]} use{usageMap[flag.feature_key] === 1 ? "" : "s"} this month
                          </Badge>
                        )}
                      </div>
                      {flag.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-xl">
                          {flag.description}
                        </p>
                      )}
                    </div>

                    {/* Right: tier icons + toggle */}
                    <div className="flex items-center gap-4 flex-shrink-0">
                      {/* Tier access icons */}
                      <div className="flex items-center gap-1.5">
                        <TierIcon label="solo" active={flag.solo_agent_access} />
                        <TierIcon label="team" active={flag.team_access} />
                        <TierIcon label="brokerage" active={flag.brokerage_access} />
                        <TierIcon label="multi" active={flag.multi_location_access} />
                      </div>

                      {/* Percentage rollout — deterministic tenant cohorts; 100 = everyone */}
                      <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Gradual rollout: % of tenants (deterministic cohort). A grant-trial override can pull a tenant in early.">
                        <input
                          type="number" min={0} max={100}
                          defaultValue={(flag as any).rollout_percentage ?? 100}
                          disabled={!isSuperadmin}
                          onBlur={(e) => {
                            const v = Number(e.target.value)
                            if (!Number.isNaN(v) && v !== ((flag as any).rollout_percentage ?? 100)) {
                              handleRolloutChange(flag.id, flag.feature_key, v)
                            }
                          }}
                          className="w-14 rounded border px-1 py-0.5 text-right text-xs"
                        />
                        %
                      </label>

                      <Switch
                        checked={flagStates[flag.id] ?? false}
                        disabled={!isSuperadmin}
                        onCheckedChange={(next) =>
                          handleFlagToggle(flag.id, flag.feature_key, next)
                        }
                        aria-label={`Toggle ${flag.display_name}`}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <Separator className="mt-6" />
            </div>
          ))}

          {flags.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No feature flags found.
            </p>
          )}

          {!isSuperadmin && (
            <p className="text-xs text-muted-foreground">
              Flag toggles are locked to superadmin. Contact platform support to change flag states.
            </p>
          )}
        </TabsContent>

        {/* ── TAB 2: Access Overrides ───────────────────────────────────── */}
        <TabsContent value="overrides" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Manage per-user trial grants and feature disables for this brokerage.
            </p>
            <Button size="sm" onClick={() => setSheetOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Grant Trial Access
            </Button>
          </div>

          {overrides.length > 0 ? (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Granted By</TableHead>
                    <TableHead>Feature</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Trial Ends</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((o) => (
                    <TableRow key={o.id}>
                      {/* grantee = user_id (the person governed) */}
                      <TableCell className="text-sm">
                        {o.grantee?.email ?? o.user_id ?? "—"}
                      </TableCell>
                      {/* granted_by = created_by (the admin who set it) — the audit
                          half of the trail, previously unreachable because the
                          ambiguous embed refused the entire read. */}
                      <TableCell className="text-sm text-muted-foreground">
                        {o.granted_by?.email ?? o.created_by ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs font-mono">
                          {o.feature_key}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={o.override_type === "grant_trial" ? "default" : "destructive"}
                          className="text-xs"
                        >
                          {o.override_type ?? "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {o.trial_ends_at
                          ? new Date(o.trial_ends_at).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {o.notes ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleRevoke(o.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Revoke</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center border rounded-lg">
              No access overrides for this brokerage.
            </p>
          )}

          {/* Grant Trial Sheet */}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Grant Trial Access</SheetTitle>
                <SheetDescription>
                  Give a user 30-day access to a feature outside their current tier.
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-4 mt-6">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="grant-email">User Email</Label>
                  <Input
                    id="grant-email"
                    type="email"
                    placeholder="agent@brokerage.com"
                    value={grantEmail}
                    onChange={(e) => setGrantEmail(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="grant-feature">Feature</Label>
                  <Select value={grantFeatureKey} onValueChange={setGrantFeatureKey}>
                    <SelectTrigger id="grant-feature">
                      <SelectValue placeholder="Select feature..." />
                    </SelectTrigger>
                    <SelectContent>
                      {flags.map((f) => (
                        <SelectItem key={f.feature_key} value={f.feature_key}>
                          {f.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="grant-notes">Notes (optional)</Label>
                  <Input
                    id="grant-notes"
                    placeholder="Reason for trial..."
                    value={grantNotes}
                    onChange={(e) => setGrantNotes(e.target.value)}
                  />
                </div>

                <Button
                  onClick={handleGrantTrial}
                  disabled={grantPending}
                  className="mt-2"
                >
                  {grantPending ? "Granting..." : "Grant 30-Day Trial"}
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </TabsContent>

        {/* ── TAB 3: Usage Analytics ────────────────────────────────────── */}
        <TabsContent value="usage" className="mt-4 space-y-6">
          <p className="text-sm text-muted-foreground">
            Feature usage by unique users this month within your brokerage.
          </p>

          {usedFlags.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Active Features</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Feature Key</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead className="text-right">Uses This Month</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usedFlags.map((f) => (
                      <TableRow key={f.feature_key}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {f.feature_key}
                        </TableCell>
                        <TableCell className="text-sm">{f.display_name}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="secondary">{f.uses}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {zeroFlags.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Zero Usage This Month
                  <span className="text-xs ml-2 font-normal">(adoption gaps)</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Feature Key</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Category</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {zeroFlags.map((f) => (
                      <TableRow key={f.feature_key} className="opacity-60">
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {f.feature_key}
                        </TableCell>
                        <TableCell className="text-sm">{f.display_name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {f.category ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {flags.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No feature data available.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
