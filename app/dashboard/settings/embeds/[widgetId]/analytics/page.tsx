/**
 * Settings → Embeds → [widgetId] → Analytics
 *
 * Shows session + lead capture data for one embed widget. All numbers come
 * from embed_sessions rows — no external analytics service required.
 */

import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Globe, Users, TrendingUp } from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { getEmbedAnalytics, listMyEmbeds, type EmbedAnalytics } from "@/app/actions/embed-widgets"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ widgetId: string }>
  searchParams: Promise<{ days?: string }>
}

export default async function EmbedAnalyticsPage({ params, searchParams }: PageProps) {
  const { widgetId } = await params
  const { days: daysParam } = await searchParams
  const days = Math.min(90, Math.max(7, parseInt(daysParam ?? "30", 10) || 30))

  // Verify the widget exists and is accessible to the caller
  const { widgets } = await listMyEmbeds()
  const widget = widgets.find((w) => w.id === widgetId)
  if (!widget) notFound()

  const { ok, analytics } = await getEmbedAnalytics({ widgetId, days })
  const data: EmbedAnalytics | null = (ok ? (analytics?.[0] ?? null) : null)

  const PERIOD_OPTIONS = [7, 14, 30, 60, 90]

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/dashboard/settings/embeds"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Embeds
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">{widget.label}</h1>
          {widget.isActive ? (
            <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 text-xs">Active</Badge>
          ) : (
            <Badge variant="outline" className="text-xs">Disabled</Badge>
          )}
          {widget.agentId === null && (
            <Badge variant="outline" className="text-xs">Brokerage-wide</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Analytics — last {days} days</p>
      </div>

      {/* Period selector */}
      <div className="flex gap-1 mb-6">
        {PERIOD_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/dashboard/settings/embeds/${widgetId}/analytics?days=${d}`}
            className={`px-3 py-1 rounded-md text-xs border transition-colors ${
              d === days
                ? "border-primary bg-primary/10 text-primary font-medium"
                : "hover:bg-muted/50"
            }`}
          >
            {d}d
          </Link>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Sessions"
          value={data?.totalSessions ?? 0}
          sub="Visitors who opened the widget"
        />
        <StatCard
          icon={<Globe className="h-4 w-4" />}
          label="Leads captured"
          value={data?.totalLeads ?? 0}
          sub="Visitors who submitted their info"
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Conversion rate"
          value={`${data?.conversionRate ?? 0}%`}
          sub="Leads ÷ sessions"
        />
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Returning visitors"
          value={data?.returningVisitors ?? 0}
          sub={`Of ${data?.uniqueVisitors ?? 0} unique visitors, came back`}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Top pages */}
        <Card className="p-4">
          <p className="text-sm font-medium mb-3">Top pages</p>
          {data?.topPages && data.topPages.length > 0 ? (
            <div className="space-y-2">
              {data.topPages.map((p) => (
                <div key={p.pageUrl} className="flex items-start justify-between gap-3 text-sm">
                  <span
                    className="text-xs text-muted-foreground truncate flex-1"
                    title={p.pageUrl}
                  >
                    {p.pageUrl === "(unknown)" ? (
                      <em>Unknown page</em>
                    ) : (
                      (() => {
                        try {
                          const u = new URL(p.pageUrl)
                          return u.pathname + (u.search || "")
                        } catch {
                          return p.pageUrl
                        }
                      })()
                    )}
                  </span>
                  <div className="flex gap-3 shrink-0 text-xs">
                    <span>{p.sessions} sessions</span>
                    <span className="text-emerald-600">{p.leads} leads</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No data yet for this period.</p>
          )}
        </Card>

        {/* Daily trend */}
        <Card className="p-4">
          <p className="text-sm font-medium mb-3">Daily activity</p>
          {data?.byDay && data.byDay.length > 0 ? (
            <DailyChart rows={data.byDay} />
          ) : (
            <p className="text-sm text-muted-foreground">No data yet for this period.</p>
          )}
        </Card>

        {/* Top referrers — same shape as Top pages, keyed by the page that SENT
            the visitor (embed_sessions.referrer). "(direct)" is the honest
            label for an empty referrer, not "unknown". */}
        <Card className="p-4">
          <p className="text-sm font-medium mb-3">Top referrers</p>
          {data?.topReferrers && data.topReferrers.length > 0 ? (
            <div className="space-y-2">
              {data.topReferrers.map((r) => (
                <div key={r.referrer} className="flex items-start justify-between gap-3 text-sm">
                  <span className="text-xs text-muted-foreground truncate flex-1" title={r.referrer}>
                    {r.referrer === "(direct)" ? <em>Direct / no referrer</em> : hostAndPath(r.referrer)}
                  </span>
                  <div className="flex gap-3 shrink-0 text-xs">
                    <span>{r.sessions} sessions</span>
                    <span className="text-emerald-600">{r.leads} leads</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No data yet for this period.</p>
          )}
        </Card>

        {/* Device split — four buckets derived server-side from the User-Agent.
            The raw UA string never reaches this page (fingerprint-adjacent). */}
        <Card className="p-4">
          <p className="text-sm font-medium mb-3">Devices</p>
          {data && data.totalSessions > 0 ? (
            <DeviceSplit devices={data.devices} total={data.totalSessions} />
          ) : (
            <p className="text-sm text-muted-foreground">No data yet for this period.</p>
          )}
        </Card>

        {/* Which twin greeted visitors. A label, not a link — nothing in the
            app routes by the D-ID agent id the session stored. */}
        <Card className="p-4">
          <p className="text-sm font-medium mb-3">Sessions by twin</p>
          {data?.byTwin && data.byTwin.length > 0 ? (
            <div className="space-y-2">
              {data.byTwin.map((t) => (
                <div key={t.twinId ?? t.label} className="flex items-center justify-between gap-3 text-sm">
                  <span className={`text-xs truncate flex-1 ${t.twinId ? "" : "text-muted-foreground italic"}`}>
                    {t.label}
                  </span>
                  <span className="text-xs shrink-0">{t.sessions} sessions</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No data yet for this period.</p>
          )}
        </Card>
      </div>

      {/* Routing info */}
      {widget.agentId === null && (
        <Card className="p-4 mt-4">
          <p className="text-sm font-medium mb-1">Lead routing</p>
          <p className="text-sm text-muted-foreground">
            This is a brokerage-wide embed using{" "}
            <span className="font-medium text-foreground">
              {widget.routingMode === "round_robin" ? "round-robin" : "primary agent"}
            </span>{" "}
            routing.{" "}
            <Link
              href="/dashboard/settings/embeds"
              className="underline hover:text-foreground"
            >
              Edit routing settings
            </Link>
          </p>
        </Card>
      )}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** "https://example.com/blog/post?x=1" → "example.com/blog/post" — a referrer is a
 *  whole URL; the host is the part that identifies WHO sent the visitor. */
function hostAndPath(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === "/" ? "" : u.pathname)
  } catch {
    return url
  }
}

function DeviceSplit({ devices, total }: { devices: EmbedAnalytics["devices"]; total: number }) {
  const rows: { key: keyof EmbedAnalytics["devices"]; label: string; tone: string }[] = [
    { key: "mobile",  label: "Mobile",  tone: "bg-primary/60" },
    { key: "desktop", label: "Desktop", tone: "bg-primary/30" },
    { key: "bot",     label: "Bots / crawlers", tone: "bg-amber-400/60" },
    { key: "unknown", label: "Unknown", tone: "bg-muted-foreground/30" },
  ]
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const n = devices[r.key]
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        return (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground w-28 shrink-0">{r.label}</span>
            <div className="flex-1">
              <div className={`h-3 rounded-sm min-w-[2px] ${r.tone}`} style={{ width: `${Math.max(n > 0 ? 4 : 0, pct)}%` }} title={`${n} sessions`} />
            </div>
            <span className="text-muted-foreground w-20 text-right shrink-0">{n} · {pct}%</span>
          </div>
        )
      })}
    </div>
  )
}

function StatCard({
  icon, label, value, sub,
}: {
  icon: React.ReactNode
  label: string
  value: number | string
  sub: string
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </Card>
  )
}

function DailyChart({ rows }: { rows: { date: string; sessions: number; leads: number }[] }) {
  const maxSessions = Math.max(...rows.map((r) => r.sessions), 1)
  return (
    <div className="space-y-1.5">
      {rows.slice(-14).map((r) => (
        <div key={r.date} className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-20 shrink-0">
            {new Date(r.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
          <div className="flex-1 flex items-center gap-1">
            <div
              className="h-3 rounded-sm bg-primary/30 min-w-[2px]"
              style={{ width: `${Math.max(4, (r.sessions / maxSessions) * 100)}%` }}
              title={`${r.sessions} sessions`}
            />
            {r.leads > 0 && (
              <div
                className="h-3 rounded-sm bg-emerald-500/70 min-w-[2px]"
                style={{ width: `${Math.max(4, (r.leads / maxSessions) * 100)}%` }}
                title={`${r.leads} leads`}
              />
            )}
          </div>
          <span className="text-muted-foreground w-20 text-right shrink-0">
            {r.sessions}s / {r.leads}l
          </span>
        </div>
      ))}
      <div className="flex gap-4 pt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-primary/30" /> Sessions</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500/70" /> Leads</span>
      </div>
    </div>
  )
}
