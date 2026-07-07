import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listAllTicketsAction } from "@/app/actions/superadmin/support-console"

export const dynamic = "force-dynamic"

const STATUS_BADGE: Record<string, string> = {
  open: "bg-amber-100 text-amber-800", in_progress: "bg-blue-100 text-blue-800",
  resolved: "bg-emerald-100 text-emerald-800", closed: "bg-slate-100 text-slate-600",
}
const PRIORITY_BADGE: Record<string, string> = {
  urgent: "bg-red-100 text-red-800", high: "bg-orange-100 text-orange-800", medium: "bg-slate-100 text-slate-600", low: "bg-slate-100 text-slate-500",
}

export default async function SuperadminSupportPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const gate = await requirePlatformCapability("support")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: platform support only</div>

  const { status } = await searchParams
  const res = await listAllTicketsAction(status ? { status } : undefined)
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  const { rows, counts, awaiting, breached, csatAverage, csatRated } = res

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Support — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Respond to any tenant&apos;s tickets. {awaiting} awaiting first response
            {breached > 0 ? <> · <span className="font-semibold text-red-600">{breached} past SLA</span></> : " · SLA green"}
            {csatAverage != null && <> · CSAT {csatAverage.toFixed(1)}/5 ({csatRated} rated)</>}
          </p>
        </div>
        <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/dashboard/superadmin/support" className={"rounded-md border px-3 py-1 text-sm " + (!status ? "bg-slate-900 text-white" : "")}>All</Link>
        {(["open", "in_progress", "resolved", "closed"] as const).map((s) => (
          <Link key={s} href={`/dashboard/superadmin/support?status=${s}`} className={"rounded-md border px-3 py-1 text-sm " + (status === s ? "bg-slate-900 text-white" : "")}>
            {s.replace("_", " ")} ({counts[s] ?? 0})
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">No tickets. 🎉</div>
      ) : (
        <div className="space-y-2">
          {rows.map((t) => (
            <Link key={t.id} href={`/dashboard/superadmin/support/${t.id}`} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50">
              <span className={"shrink-0 rounded px-2 py-0.5 text-xs font-medium " + (STATUS_BADGE[t.status] ?? "")}>{t.status.replace("_", " ")}</span>
              {t.priority && <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " + (PRIORITY_BADGE[t.priority] ?? "")}>{t.priority}</span>}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{t.subject ?? "(no subject)"}</p>
                <p className="text-xs text-muted-foreground truncate">{t.brokerageName ?? "Unknown tenant"}{t.category ? ` · ${t.category}` : ""}</p>
              </div>
              {t.slaBreaches.length > 0 && <span className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">SLA breached</span>}
              {t.slaBreaches.length === 0 && t.slaAtRisk && <span className="shrink-0 rounded bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white">SLA at risk</span>}
              {t.awaitingFirstResponse && <span className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">needs reply</span>}
              {t.satisfactionRating != null && <span className="shrink-0 text-[11px] text-muted-foreground">⭐ {t.satisfactionRating}/5</span>}
              <span className="shrink-0 text-xs text-indigo-600 font-medium">Open →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
