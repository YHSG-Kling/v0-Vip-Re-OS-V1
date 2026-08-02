import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { validateA2pProfile, nextA2pStep, a2pCampaignApproved, type A2pState } from "@/lib/voice/a2p-registration"
import { assessA2pStall } from "@/lib/platform/provider-posture"
import { VoiceIntegrityCell } from "./voice-integrity-cell"

export const dynamic = "force-dynamic"

// PLATFORM A2P STATUS BOARD — every tenant's carrier-registration posture in one
// table. PLATFORM-GLOBAL READ by design (providers-gated, service client): the
// A2P step machine persists per-tenant state on platform_credentials
// ('twilio_a2p', config jsonb — see lib/voice/a2p-registration), the business
// profile lives in brokerage_settings.settings.a2p_business_profile, numbers in
// tenant_phone_numbers, and every runner invocation logs to phone_number_events
// (source 'a2p_registration'). Nothing here is fabricated: statuses are exactly
// what the step machine last persisted from Twilio.

function fmtAgo(iso: string | null) {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

type StageBadge = { label: string; cls: string }

function brandBadge(s: A2pState): StageBadge {
  if (!s.brand_sid) return { label: "not started", cls: "bg-slate-100 text-slate-600" }
  const st = (s.brand_status ?? "PENDING").toUpperCase()
  if (st === "APPROVED") return { label: "approved", cls: "bg-emerald-100 text-emerald-800" }
  if (st === "FAILED") return { label: "failed", cls: "bg-red-100 text-red-800" }
  return { label: `under review (${st.toLowerCase()})`, cls: "bg-amber-100 text-amber-800" }
}

function campaignBadge(s: A2pState): StageBadge {
  if (!s.campaign_sid) return { label: "not started", cls: "bg-slate-100 text-slate-600" }
  const st = (s.campaign_status ?? "PENDING").toUpperCase()
  if (st === "VERIFIED" || st === "APPROVED") return { label: st.toLowerCase(), cls: "bg-emerald-100 text-emerald-800" }
  if (st === "FAILED") return { label: "failed", cls: "bg-red-100 text-red-800" }
  return { label: `under review (${st.toLowerCase()})`, cls: "bg-amber-100 text-amber-800" }
}

/** CNAM / SHAKEN/STIR bundle badge — Twilio's own TrustHub bundle statuses
 *  (draft | pending-review | in-review | twilio-rejected | twilio-approved),
 *  exactly as the voice-integrity runner last persisted them. */
function integrityBadge(sid: string | undefined, status: string | undefined): StageBadge {
  if (!sid) return { label: "not filed", cls: "bg-slate-100 text-slate-600" }
  const st = (status ?? "pending-review").toLowerCase()
  if (st === "twilio-approved") return { label: "approved", cls: "bg-emerald-100 text-emerald-800" }
  if (st === "twilio-rejected") return { label: "rejected", cls: "bg-red-100 text-red-800" }
  if (st === "draft") return { label: "draft (not submitted)", cls: "bg-slate-100 text-slate-600" }
  return { label: `under review (${st})`, cls: "bg-amber-100 text-amber-800" }
}

/** Messaging-ready = the campaign cleared carrier review — the same terminal
 *  statuses describeA2pState treats as "carrier-verified texting is active". */
function isMessagingReady(s: A2pState): boolean {
  if (!s.campaign_sid) return false
  const st = (s.campaign_status ?? "").toUpperCase()
  return st === "VERIFIED" || st === "APPROVED"
}

export default async function SuperadminA2pPage() {
  const gate = await requirePlatformCapability("providers")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const svc = createServiceClient()

  const [brk, creds, settings, numbers, events] = await Promise.all([
    svc.from("brokerages").select("id, name, plan_tier").is("deleted_at", null).order("name"),
    svc.from("platform_credentials").select("brokerage_id, config, updated_at").eq("platform", "twilio_a2p").eq("is_active", true),
    svc.from("brokerage_settings").select("brokerage_id, settings"),
    svc.from("tenant_phone_numbers").select("brokerage_id").eq("is_active", true),
    svc.from("phone_number_events").select("brokerage_id, created_at").eq("source", "a2p_registration").order("created_at", { ascending: false }).limit(2000),
  ])
  const failed = [brk, creds, settings, numbers, events].find((r) => r.error)
  if (failed?.error) return <div className="p-6 text-red-600">Failed to load A2P board: {failed.error.message}</div>

  const stateByBrokerage = new Map<string, { state: A2pState; updatedAt: string | null }>()
  for (const c of (creds.data ?? []) as any[]) {
    stateByBrokerage.set(c.brokerage_id, { state: (c.config ?? {}) as A2pState, updatedAt: c.updated_at ?? null })
  }
  const profileOkByBrokerage = new Map<string, boolean>()
  for (const s of (settings.data ?? []) as any[]) {
    profileOkByBrokerage.set(s.brokerage_id, validateA2pProfile(s.settings?.a2p_business_profile).ok)
  }
  const numberCount = new Map<string, number>()
  for (const n of (numbers.data ?? []) as any[]) {
    numberCount.set(n.brokerage_id, (numberCount.get(n.brokerage_id) ?? 0) + 1)
  }
  const lastEventByBrokerage = new Map<string, string>()
  for (const e of (events.data ?? []) as any[]) {
    if (!lastEventByBrokerage.has(e.brokerage_id)) lastEventByBrokerage.set(e.brokerage_id, e.created_at)
  }

  const rows = ((brk.data ?? []) as any[]).map((b) => {
    const entry = stateByBrokerage.get(b.id)
    const state = entry?.state ?? {}
    // Last A2P activity: last runner event, else the persisted state's own timestamp.
    const lastEvent = lastEventByBrokerage.get(b.id) ?? state.updated_at ?? entry?.updatedAt ?? null
    // STALLED detection (pure clock over the persisted state — the #1 real-world
    // SMS blocker is a review that sat PENDING for a week with nobody watching).
    const stall = assessA2pStall(state, lastEvent)
    return {
      id: b.id as string,
      name: (b.name as string) ?? "(unnamed)",
      tier: (b.plan_tier as string) ?? "—",
      profileOk: profileOkByBrokerage.get(b.id) ?? false,
      brand: brandBadge(state),
      campaign: campaignBadge(state),
      ready: isMessagingReady(state),
      // Voice integrity (CNAM + SHAKEN/STIR) — same jsonb, appended step.
      cnam: integrityBadge(state.cnam_trust_product_sid, state.cnam_status),
      shaken: integrityBadge(state.shaken_trust_product_sid, state.shaken_status),
      integrityEligible: a2pCampaignApproved(state),
      integrityError: state.voice_integrity_error ?? null,
      nextStep: nextA2pStep(state),
      lastError: state.last_error ?? null,
      phoneCount: numberCount.get(b.id) ?? 0,
      lastEvent,
      stalled: stall.stalled,
      stallReason: stall.reason,
    }
  })
  // Stalled first (they need a human), ready last; within groups keep name order.
  rows.sort((a, b) => Number(b.stalled) - Number(a.stalled) || Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name))

  const readyCount = rows.filter((r) => r.ready).length
  const inProgressCount = rows.filter((r) => !r.ready && r.nextStep !== "customer_profile").length
  const notStartedCount = rows.length - readyCount - inProgressCount
  const failedCount = rows.filter((r) => r.brand.label === "failed" || r.campaign.label === "failed").length
  const stalledCount = rows.filter((r) => r.stalled).length

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">A2P 10DLC — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Carrier registration posture across all tenants: brand + campaign review status, messaging
            readiness, numbers, and last registration activity. Statuses are what Twilio last reported —
            never assumed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/connectors" className="rounded-md border px-3 py-1 text-sm">Connectors</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Posture counts */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{readyCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800">Messaging-ready</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{stalledCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">Stalled</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{inProgressCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">In progress</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{failedCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">Review failed</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{notStartedCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">Not started</div>
        </div>
      </div>

      {/* Every tenant */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All tenants ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No tenants yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Brokerage</th>
                  <th className="p-2">Profile</th>
                  <th className="p-2">Brand</th>
                  <th className="p-2">Campaign</th>
                  <th className="p-2">Ready</th>
                  <th className="p-2">CNAM / SHAKEN</th>
                  <th className="p-2 text-right">Numbers</th>
                  <th className="p-2">Next step</th>
                  <th className="p-2">Last A2P event</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">{r.tier}</div>
                    </td>
                    <td className="p-2">
                      <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (r.profileOk ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")}>
                        {r.profileOk ? "complete" : "incomplete"}
                      </span>
                    </td>
                    <td className="p-2"><span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + r.brand.cls}>{r.brand.label}</span></td>
                    <td className="p-2"><span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + r.campaign.cls}>{r.campaign.label}</span></td>
                    <td className="p-2">
                      <span className={"rounded px-1.5 py-0.5 text-[11px] font-semibold " + (r.ready ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")}>
                        {r.ready ? "yes" : "no"}
                      </span>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-col gap-1">
                        <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + r.cnam.cls}>CNAM: {r.cnam.label}</span>
                        <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + r.shaken.cls}>SHAKEN: {r.shaken.label}</span>
                        {r.integrityError && <span className="max-w-[220px] truncate text-[11px] text-red-600" title={r.integrityError}>{r.integrityError}</span>}
                        <VoiceIntegrityCell brokerageId={r.id} eligible={r.integrityEligible} />
                      </div>
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.phoneCount}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {r.stalled && (
                        <div>
                          <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold bg-red-100 text-red-800">STALLED</span>
                          {r.stallReason && <span className="ml-1 text-red-600" title={r.stallReason}>{r.stallReason.length > 60 ? `${r.stallReason.slice(0, 60)}…` : r.stallReason}</span>}
                        </div>
                      )}
                      {r.ready ? "—" : r.nextStep.replace(/_/g, " ")}
                      {r.lastError && <div className="text-red-600 max-w-[280px] truncate" title={r.lastError}>{r.lastError}</div>}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground" title={r.lastEvent ?? undefined}>{fmtAgo(r.lastEvent)}</td>
                    <td className="p-2 text-right"><Link href={`/dashboard/superadmin/brokerages/${r.id}`} className="text-xs font-medium text-indigo-600">Manage →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
