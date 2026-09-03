import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Building2, ArrowLeft, Clock, KeyRound } from "lucide-react"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { redirect } from "next/navigation"
import { getBrokerageDetailAction } from "@/app/actions/superadmin/brokerage-management"
import { BrokerageActions } from "./brokerage-actions"
import { TenantUsersPanel } from "./tenant-users-panel"
import { TenantSetupPanel } from "./tenant-setup-panel"
import { EnterTenantButton } from "./enter-tenant-button"
import { TenantEntitlementsPanel } from "./tenant-entitlements-panel"
import { TenantAutonomyPanel } from "./tenant-autonomy-panel"
import { TenantSnapshotsPanel } from "./tenant-snapshots-panel"
import { TenantImportPanel } from "./tenant-import-panel"
import { TenantCrmPullPanel } from "./tenant-crm-pull-panel"
import { PortalClientsPanel } from "./portal-clients-panel"

export const dynamic = "force-dynamic"

function statusBadge(s: string | null | undefined) {
  switch (s) {
    case "active":    return <Badge className="bg-emerald-100 text-emerald-800">Active</Badge>
    case "suspended": return <Badge className="bg-amber-100 text-amber-800">Suspended</Badge>
    case "cancelled": return <Badge className="bg-red-100 text-red-800">Cancelled</Badge>
    case "archived":  return <Badge className="bg-slate-100 text-slate-600">Archived</Badge>
    default:          return <Badge variant="outline">{s ?? "—"}</Badge>
  }
}

export default async function SuperadminBrokerageDetailPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) {
    return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>
  }

  const { id } = await params
  const r = await getBrokerageDetailAction(id)
  if (!r.ok) return <div className="p-6 text-red-600">Failed: {r.error}</div>

  const { brokerage, users, subscriptions, auditEntries, accessSessions, aiEntitlement } = r

  // AI ENTITLEMENT TENURE (ai_subscription_tier.subscribed_at). Whole months only, and
  // only when there IS a date — an entitlement whose start was never recorded says so
  // rather than reporting "0 months", which would read as "signed up today".
  const aiTenureLabel = (() => {
    if (!aiEntitlement) return "no AI entitlement row on record"
    const tier = aiEntitlement.tierName ?? "unnamed tier"
    const state = aiEntitlement.cancelledAt
      ? `cancelled ${new Date(aiEntitlement.cancelledAt).toLocaleDateString()}`
      : aiEntitlement.isActive ? "active" : "inactive"
    if (!aiEntitlement.subscribedAt) return `${tier} · ${state} · start date not recorded`
    const started = new Date(aiEntitlement.subscribedAt)
    const months = Math.max(
      0,
      (new Date().getFullYear() - started.getFullYear()) * 12 + (new Date().getMonth() - started.getMonth()),
    )
    return `${tier} · ${state} · since ${started.toLocaleDateString()} (${months} month${months === 1 ? "" : "s"})`
  })()

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <Link href="/dashboard/superadmin/brokerages" className="text-xs text-muted-foreground hover:underline flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> All brokerages
        </Link>
        <div className="flex items-end justify-between flex-wrap gap-3 mt-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              {brokerage.name ?? "(unnamed)"}
            </h1>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              {brokerage.city && brokerage.state ? `${brokerage.city}, ${brokerage.state}` : "Location not set"} ·
              created {new Date(brokerage.created_at).toLocaleDateString()} ·
              source <span className="font-medium">{brokerage.signup_source}</span>
            </div>
            {/* AI ENTITLEMENT — the tier the AI gates read, and how long this tenant has
                held it. §5: AI is platform-covered with per-tier overage, so this is the
                tenure behind every overage number on this account. */}
            <div className="mt-1 text-xs text-muted-foreground">
              AI entitlement: <span className="font-medium">{aiTenureLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {statusBadge(brokerage.status)}
              <Badge variant="outline">{brokerage.plan_tier}</Badge>
            </div>
            {/* GoHighLevel-style "act as tenant" — operate the app as this brokerage. */}
            <EnterTenantButton brokerageId={brokerage.id} />
          </div>
        </div>
      </div>

      {/* Staff-assisted onboarding — the tenant's setup readiness, worked on their behalf */}
      <TenantSetupPanel brokerageId={brokerage.id} />

      {/* Admin actions card */}
      <BrokerageActions brokerage={brokerage} />

      {/* Per-tenant autonomy halt — pause this tenant's autonomous AI (staff-only lever) */}
      <TenantAutonomyPanel brokerageId={brokerage.id} />

      {/* Team members — actionable cross-tenant user management */}
      <TenantUsersPanel brokerageId={brokerage.id} />

      {/* Portal clients — accepted/pending portal access + users-row backfill
          (portal clients ARE users: user_type='contact', impersonable) */}
      <PortalClientsPanel brokerageId={brokerage.id} />

      {/* Per-tenant entitlements — feature flags + AI-token quota overrides */}
      <TenantEntitlementsPanel brokerageId={brokerage.id} />

      {/* Config snapshots — capture this tenant as a template / apply a template here */}
      <TenantSnapshotsPanel brokerageId={brokerage.id} />

      {/* Onboarding — white-glove data migration: land the subscriber's old-CRM
          CSV (contacts / draft listings) in THIS tenant. Inbound mirror of the
          export card below. */}
      <TenantImportPanel brokerageId={brokerage.id} />

      {/* The API half of the same white-glove migration — CSV above, vendor pull here. */}
      <TenantCrmPullPanel brokerageId={brokerage.id} />

      {/* Offboarding — the tenant's data, downloadable. Export never deletes;
          retention-law records stay put regardless of tenancy. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Offboarding &amp; data export</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground max-w-xl">
            One JSON bundle of this tenant&apos;s core business records (contacts, deals, communications,
            billing, support — 23 tables). Every export is audit-logged. Offboarding order: export → cancel
            subscription (above) → archive. Nothing is deleted by exporting; transaction and communication
            records remain under their legal retention window.
          </p>
          {/* This page admits the 'tenants' capability (all four staff roles);
              the export route is superadmin-only — a tenant's whole book leaving
              the platform as a file is not marketing's or support's authority.
              Show the link only to the role the route will actually serve. */}
          {gate.role === "superadmin" ? (
            <a href={`/api/superadmin/tenant-export/${brokerage.id}`} className="rounded-md border px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50">
              Download tenant export
            </a>
          ) : (
            <span className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground">
              Export is superadmin-only
            </span>
          )}
        </CardContent>
      </Card>

      {/* Subscriptions history */}
      {subscriptions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Subscriptions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Period start</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Period end</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s: any) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5"><Badge variant="outline" className="text-xs">{s.status}</Badge></td>
                      <td className="px-4 py-2.5 text-xs">{new Date(s.current_period_start).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-xs">{new Date(s.current_period_end).toLocaleDateString()}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Staff account access — the impersonation grant ledger for THIS tenant.
          Reads platform_impersonation_sessions: who entered, under what stated
          reason, in which mode, from where, and whether they exited or the
          grant simply expired. A grant walks the account and never exceeds it
          (CLAUDE.md §5); this is where that is checked after the fact. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Staff account access
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {accessSessions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No platform staff has entered this tenant.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Staff</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Mode</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Stated reason</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Origin</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Started</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Ended</th>
                  </tr>
                </thead>
                <tbody>
                  {accessSessions.map((s: any) => (
                    <tr key={s.id} className="border-b last:border-0 align-top">
                      <td className="px-4 py-2.5 text-xs">{s.actor_email ?? s.actor_user_id ?? "—"}</td>
                      <td className="px-4 py-2.5 text-xs">
                        <Badge variant={s.mode === "read_only" ? "secondary" : "destructive"}>{s.mode ?? "—"}</Badge>
                        {s.target_user_id ? <span className="ml-2 text-[10px] text-muted-foreground">as one user</span> : null}
                      </td>
                      {/* An entry with NO stated reason is shown as exactly that
                          — never blanked into looking routine. */}
                      <td className="px-4 py-2.5 text-xs max-w-xs">
                        {s.reason ? s.reason : <span className="text-amber-600">no reason recorded</span>}
                      </td>
                      <td className="px-4 py-2.5 text-[10px] text-muted-foreground font-mono max-w-[14rem] truncate" title={s.user_agent ?? ""}>
                        {s.ip_address ?? "ip not recorded"}
                        {s.user_agent ? ` · ${s.user_agent}` : ""}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {s.started_at ? new Date(s.started_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {s.ended_at
                          ? new Date(s.ended_at).toLocaleString()
                          : s.expires_at && Date.parse(s.expires_at) < Date.now()
                          ? `expired ${new Date(s.expires_at).toLocaleString()}`
                          : "ACTIVE NOW"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audit log */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Audit trail
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {auditEntries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No superadmin actions logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Action</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Actor</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Details</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((a: any) => (
                    <tr key={a.id} className="border-b last:border-0 align-top">
                      <td className="px-4 py-2.5 font-mono text-xs">{a.action}</td>
                      <td className="px-4 py-2.5 text-xs">{a.actor_email ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[10px] text-muted-foreground font-mono whitespace-pre-wrap max-w-xs truncate">
                        {JSON.stringify(a.details)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
