"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, Camera, Mail } from "lucide-react"
import { manualProvisionSubscriberAction } from "@/app/actions/superadmin/manual-subscriber"
import { retrySubscriberInvite } from "@/app/actions/admin/create-subscriber"
import { listSnapshotsAction, type SnapshotRow } from "@/app/actions/superadmin/config-snapshots"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"
const CANONICAL_TIERS: readonly CanonicalTier[] = ["solo_agent", "team", "brokerage", "multi_location"]

export function ManualSubscriberForm() {
  const router = useRouter()
  const [tier, setTier] = useState<CanonicalTier>("team")
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly")
  const [brokerageName, setBrokerageName] = useState("")
  const [brokerageEmail, setBrokerageEmail] = useState("")
  const [brokeragePhone, setBrokeragePhone] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [adminEmail, setAdminEmail] = useState("")
  const [notes, setNotes] = useState("")

  const [feedback, setFeedback] = useState<{
    kind: "error" | "success"
    message: string
    brokerageId?: string
    /** Set only when the tenant WAS provisioned but the owner's magic link did
     *  not go out. Carries what retrySubscriberInvite needs to resend it. */
    retryInvite?: { adminEmail: string; brokerageId: string }
  } | null>(null)
  const [isPending, startTransition] = useTransition()
  const [resending, setResending] = useState(false)
  const [resendNote, setResendNote] = useState<string | null>(null)

  // Optional config snapshot — day-one branding for the new tenant's website.
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([])
  const [snapshotsLoaded, setSnapshotsLoaded] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null)

  useEffect(() => {
    listSnapshotsAction().then((r) => {
      if (r.ok) setSnapshots(r.snapshots)
      else setSnapshotsError(r.error)
      setSnapshotsLoaded(true)
    })
  }, [])

  function selectSnapshot(s: SnapshotRow | null) {
    setSnapshotId(s?.id ?? null)
    // A snapshot can recommend a tier — preselect it (still overridable above).
    if (s?.recommendedTier && (CANONICAL_TIERS as readonly string[]).includes(s.recommendedTier)) {
      setTier(s.recommendedTier as CanonicalTier)
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    startTransition(async () => {
      const r = await manualProvisionSubscriberAction({
        brokerageName, brokerageCity: city || undefined, brokerageState: state || undefined,
        brokerageEmail, brokeragePhone: brokeragePhone || undefined,
        adminFirstName: firstName, adminLastName: lastName, adminEmail,
        tier, billingCycle, notes: notes || undefined,
        snapshotId: snapshotId ?? undefined,
      })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      const snapshotNote = snapshotId
        ? r.snapshotError
          ? ` Snapshot apply FAILED: ${r.snapshotError}.`
          : ` Snapshot applied: ${(r.snapshotApplied ?? []).join(", ") || "nothing to apply"}.`
        : ""
      setResendNote(null)
      setFeedback({
        kind: "success",
        message: `Provisioned ${brokerageName} on ${tier}. ${r.inviteSent ? "Invite email sent" : `Invite email ${r.inviteError ? "FAILED: " + r.inviteError : "skipped"}`}.${snapshotNote}`,
        brokerageId: r.brokerageId,
        // The tenant exists either way; only the magic link is missing. Until
        // now this state was reported and then abandoned — there was no way to
        // resend, so the owner simply never got in.
        retryInvite:
          !r.inviteSent && r.brokerageId
            ? { adminEmail, brokerageId: r.brokerageId }
            : undefined,
      })
    })
  }

  async function onResendInvite(target: { adminEmail: string; brokerageId: string }) {
    setResending(true)
    setResendNote(null)
    try {
      const res = await retrySubscriberInvite(target)
      // The action now reads the provider's { error } instead of assuming the
      // send happened, so this message reflects the real outcome.
      setResendNote(res.success ? `Invite re-sent to ${target.adminEmail}.` : `Resend failed: ${res.error ?? "unknown error"}`)
    } catch (e: any) {
      setResendNote(`Resend failed: ${e?.message ?? "unknown error"}`)
    } finally {
      setResending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Optional config snapshot — day-one branded website for the new tenant */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Camera className="h-4 w-4 text-primary" />Start from a config snapshot <span className="font-normal text-muted-foreground">(optional)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Applies a saved template (branding, brand voice, public-site content, feature enablement) right after
            provisioning so the tenant&apos;s day-one website comes up fully branded. Secrets are never part of a snapshot.
          </p>
          {!snapshotsLoaded ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading snapshots…</p>
          ) : snapshotsError ? (
            <p className="text-sm text-muted-foreground">Snapshots unavailable: {snapshotsError}</p>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No snapshots yet — capture one from an existing tenant&apos;s brokerage page.</p>
          ) : (
            <div className="space-y-1">
              <button type="button"
                onClick={() => selectSnapshot(null)}
                className={`w-full text-left rounded border px-2 py-1.5 text-sm ${snapshotId === null ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                <span className="font-medium">None</span>
                <span className="ml-2 text-[11px] text-muted-foreground">Provision blank — tenant starts from scratch</span>
              </button>
              {snapshots.map((s) => (
                <button key={s.id} type="button"
                  onClick={() => selectSnapshot(s)}
                  className={`w-full text-left rounded border px-2 py-1.5 text-sm ${snapshotId === s.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                  <span className="font-medium">{s.name}</span>
                  {s.recommendedTier && <Badge variant="secondary" className="ml-2 text-[9px]">recommended: {s.recommendedTier}</Badge>}
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {s.counts.global + s.counts.brand} brand · {s.counts.voice} voice · {s.counts.site} site · {s.counts.features} features
                  </span>
                  {s.description && <span className="block text-[11px] text-muted-foreground truncate">{s.description}</span>}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tier + billing */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Plan</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {(["solo_agent","team","brokerage","multi_location"] as const).map(t => (
              <Button key={t} type="button" size="sm"
                variant={tier === t ? "default" : "outline"}
                onClick={() => setTier(t)}>
                {t === "solo_agent" ? "Solo $99" : t === "team" ? "Team $299" : t === "brokerage" ? "Brokerage $799" : "Multi-loc $1,999"}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            {(["monthly","annual"] as const).map(b => (
              <Button key={b} type="button" size="sm"
                variant={billingCycle === b ? "default" : "outline"}
                onClick={() => setBillingCycle(b)}>
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Brokerage</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="brokerageName">Brokerage name</Label>
            <Input id="brokerageName" required value={brokerageName} onChange={e => setBrokerageName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="brokerageEmail">Brokerage email</Label>
              <Input id="brokerageEmail" type="email" required value={brokerageEmail} onChange={e => setBrokerageEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="brokeragePhone">Phone</Label>
              <Input id="brokeragePhone" value={brokeragePhone} onChange={e => setBrokeragePhone(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" value={city} onChange={e => setCity(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="state">State</Label>
              <Input id="state" value={state} maxLength={2} onChange={e => setState(e.target.value.toUpperCase())} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Billing admin</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="firstName">First name</Label>
              <Input id="firstName" required value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
            <div><Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" required value={lastName} onChange={e => setLastName(e.target.value)} /></div>
          </div>
          <div>
            <Label htmlFor="adminEmail">Admin email (invite goes here)</Label>
            <Input id="adminEmail" type="email" required value={adminEmail} onChange={e => setAdminEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="notes">Internal notes</Label>
            <textarea id="notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Sales rep: Jane Doe. Custom terms negotiated."
              className="w-full text-sm border rounded p-2" />
          </div>
        </CardContent>
      </Card>

      {feedback && (
        <div className={`rounded-md border p-4 text-sm ${
          feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>
          <div className="flex items-center gap-2">
            {feedback.kind === "success" && <CheckCircle2 className="h-4 w-4" />}
            <span>{feedback.message}</span>
          </div>
          {feedback.retryInvite && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <Button type="button" size="sm" variant="outline" disabled={resending}
                onClick={() => onResendInvite(feedback.retryInvite!)}>
                {resending
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Resending…</>
                  : <><Mail className="h-4 w-4 mr-2" />Resend owner invite</>}
              </Button>
              {resendNote && <span className="text-xs">{resendNote}</span>}
            </div>
          )}
          {feedback.brokerageId && (
            <div className="mt-2">
              <Button type="button" size="sm" variant="outline"
                onClick={() => router.push(`/dashboard/superadmin/brokerages/${feedback.brokerageId}`)}>
                Open brokerage
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.push("/dashboard/superadmin/brokerages")}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Provisioning…</> : "Create subscriber"}
        </Button>
      </div>
    </form>
  )
}
