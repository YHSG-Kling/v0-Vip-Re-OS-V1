// app/dashboard/whats-new/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW & PLATFORM STATUS — the tenant-facing release-notes + status
// surface. Status is composed from real rails (superadmin status_notice
// broadcast, the platform halt switch, this tenant's own service_status rows
// from the health-check cron); the changelog is the in-repo PRODUCT_CHANGELOG
// that ships with each release (lib/platform/changelog.ts). Honest empty
// states throughout — nothing is invented when a rail has no data.

import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle2, Megaphone, Sparkles, Activity } from "lucide-react"
import { getTenantPlatformStatusAction } from "@/app/actions/whats-new"
import { changelogEntries, latestChangelogDate } from "@/lib/platform/changelog"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "What's New & Platform Status",
  description: "Product release notes and current platform status for your account.",
}

function fmtDate(iso: string) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function fmtAgo(iso: string | null) {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function serviceStatusBadge(status: string) {
  switch (status) {
    case "healthy":  return <Badge className="bg-emerald-100 text-emerald-800 text-xs">healthy</Badge>
    case "degraded": return <Badge className="bg-amber-100 text-amber-800 text-xs">degraded</Badge>
    case "down":     return <Badge className="bg-red-100 text-red-800 text-xs">down</Badge>
    default:         return <Badge variant="outline" className="text-xs">unknown</Badge>
  }
}

export default async function WhatsNewPage() {
  const res = await getTenantPlatformStatusAction()
  if (!res.ok && res.error === "Unauthenticated") redirect("/login")

  const status = res.ok ? res.status : null
  const entries = changelogEntries()
  const latestDate = latestChangelogDate()

  const overallCopy: Record<string, { label: string; className: string }> = {
    operational: { label: "All systems operational", className: "text-emerald-700" },
    degraded:    { label: "Some services degraded", className: "text-amber-700" },
    critical:    { label: "A critical service is down", className: "text-red-700" },
    unknown:     { label: "No health checks recorded yet for your account", className: "text-muted-foreground" },
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">What&apos;s new &amp; platform status</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Product release notes — what your AI team learned to do — plus the current status of the platform
          and your account&apos;s connected services.
        </p>
      </div>

      {!res.ok && (
        <div className="rounded border p-4 text-sm text-red-600">Failed to load platform status: {res.error}</div>
      )}

      {/* Incident / maintenance broadcast from platform staff */}
      {status?.notice.active && (
        <Card className={
          status.notice.severity === "outage"   ? "border-red-300 bg-red-50/60"
          : status.notice.severity === "degraded" ? "border-amber-300 bg-amber-50/60"
          : "border-blue-300 bg-blue-50/60"
        }>
          <CardContent className="pt-4">
            <div className="flex items-start gap-2">
              <Megaphone className={
                "h-4 w-4 mt-0.5 shrink-0 " +
                (status.notice.severity === "outage" ? "text-red-600" : status.notice.severity === "degraded" ? "text-amber-600" : "text-blue-600")
              } />
              <div>
                <p className="text-sm font-medium">
                  {status.notice.severity === "outage" ? "Service disruption" : status.notice.severity === "degraded" ? "Degraded service" : "Platform notice"}
                </p>
                <p className="text-sm mt-1 whitespace-pre-wrap">{status.notice.message}</p>
                {status.notice.startedAt && (
                  <p className="text-xs text-muted-foreground mt-1">Since {fmtAgo(status.notice.startedAt)} · updated {fmtAgo(status.notice.updatedAt)}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform-wide autonomy halt — if the AI team is frozen, say so */}
      {status?.haltReason && (
        <Card className="border-red-300 bg-red-50/40">
          <CardContent className="pt-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              <p className="text-sm text-red-800">{status.haltReason}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* This account's service health (from the health-check cron) */}
      {status && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Your connected services
              <span className={"ml-auto text-xs font-normal flex items-center gap-1.5 " + overallCopy[status.overallStatus].className}>
                {status.overallStatus === "operational" && <CheckCircle2 className="h-3.5 w-3.5" />}
                {(status.overallStatus === "degraded" || status.overallStatus === "critical") && <AlertTriangle className="h-3.5 w-3.5" />}
                {overallCopy[status.overallStatus].label}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!status.canSeeServices ? (
              <p className="p-4 text-sm text-muted-foreground">
                Per-service detail is visible to your account&apos;s admins and brokers.
                {status.lastCheckedAt && <> Last checked {fmtAgo(status.lastCheckedAt)}.</>}
              </p>
            ) : status.services.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No service health checks have run for your account yet — they appear here once monitoring starts.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/10">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Service</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Category</th>
                      <th className="text-center px-4 py-2 font-medium text-muted-foreground">Status</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Last checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.services.map((s, i) => (
                      <tr key={`${s.serviceName}-${i}`} className="border-b last:border-0 hover:bg-muted/10">
                        <td className="px-4 py-2.5">
                          {s.serviceName}
                          {s.isCritical && <Badge variant="outline" className="ml-2 text-[10px]">critical</Badge>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.category ?? "—"}</td>
                        <td className="px-4 py-2.5 text-center">{serviceStatusBadge(s.status)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{fmtAgo(s.lastCheckedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Product changelog — ships with the release */}
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Release notes
          </h2>
          {/*
            "Last updated" comes from latestChangelogDate() (lib/platform/changelog.ts:89),
            which was written for this page and had never been called. It reads the
            newest entry off the SAME defensively re-sorted list this page renders,
            so the date in the header can never disagree with the first card below
            it — which is the whole reason not to write {entries[0].date} here.
            Null only when the changelog is empty, and then the empty state below
            is what speaks.
          */}
          {latestDate && (
            <span className="text-xs text-muted-foreground">
              Last updated {fmtDate(latestDate)}
            </span>
          )}
        </div>
        {entries.length === 0 ? (
          <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">
            No release notes published yet.
          </div>
        ) : (
          entries.map((entry) => (
            <Card key={entry.date + entry.title}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <CardTitle className="text-base">{entry.title}</CardTitle>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-xs">{entry.area}</Badge>
                    <span className="text-xs text-muted-foreground">{fmtDate(entry.date)}</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {entry.points.map((p, i) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
