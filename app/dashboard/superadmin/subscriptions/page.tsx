import Link from "next/link"
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getSubscriptionOversightAction } from "@/app/actions/superadmin/subscription-oversight"
import type { SubscriptionState } from "@/lib/platform/subscription-oversight"

export const dynamic = "force-dynamic"

function fmtCents(c: number) { return `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}` }

const STATE_BADGE: Record<SubscriptionState, string> = {
  past_due: "bg-red-100 text-red-800", trial_expiring: "bg-amber-100 text-amber-800",
  renewal_due: "bg-blue-100 text-blue-800", no_subscription: "bg-slate-100 text-slate-700",
  trialing: "bg-violet-100 text-violet-800", active: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-100 text-slate-500",
}
const STATE_LABEL: Record<SubscriptionState, string> = {
  past_due: "Past due", trial_expiring: "Trial expiring", renewal_due: "Renewal due",
  no_subscription: "No subscription", trialing: "In trial", active: "Active", cancelled: "Cancelled",
}
const ORDER: SubscriptionState[] = ["past_due", "trial_expiring", "renewal_due", "trialing", "active", "no_subscription", "cancelled"]

export default async function SuperadminSubscriptionsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")
  const { data: profile } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isSuper = (profile as any)?.user_type === "superadmin" || (profile as any)?.platform_role === "superadmin"
  if (!isSuper) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await getSubscriptionOversightAction()
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  const { rows, queue, counts, totalMrrCents, attentionCount } = res.data

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Subscriptions — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Oversee and manage every subscription: trials expiring, payments past due, renewals due, churn.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border px-3 py-1 text-sm font-semibold text-emerald-700">{fmtCents(totalMrrCents)} MRR</span>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* State counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        {ORDER.map((s) => (
          <div key={s} className="rounded-lg border p-3">
            <div className="text-2xl font-bold tabular-nums">{counts[s]}</div>
            <div className={"mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + STATE_BADGE[s]}>{STATE_LABEL[s]}</div>
          </div>
        ))}
      </div>

      {/* Attention queue — needs a human */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Needs attention ({attentionCount})</h2>
        {queue.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Nothing needs attention — every subscription is healthy. 🎉</div>
        ) : (
          <div className="space-y-2">
            {queue.map((r) => (
              <Link key={r.brokerageId} href={`/dashboard/superadmin/brokerages/${r.brokerageId}`} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/50">
                <span className={"shrink-0 rounded px-2 py-0.5 text-xs font-semibold " + STATE_BADGE[r.state]}>{STATE_LABEL[r.state]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.reason}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold">{fmtCents(r.mrrCents)}<span className="text-xs text-muted-foreground">/mo</span></span>
                <span className="shrink-0 text-xs font-medium text-indigo-600">Manage →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Full roster */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All subscriptions ({rows.length})</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Tenant</th><th className="p-2">Tier</th><th className="p-2">State</th><th className="p-2">MRR</th><th className="p-2">Detail</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.brokerageId} className="border-t">
                  <td className="p-2 font-medium">{r.name}</td>
                  <td className="p-2">{r.tier}</td>
                  <td className="p-2"><span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + STATE_BADGE[r.state]}>{STATE_LABEL[r.state]}</span></td>
                  <td className="p-2 tabular-nums">{fmtCents(r.mrrCents)}</td>
                  <td className="p-2 text-xs text-muted-foreground">{r.reason}</td>
                  <td className="p-2 text-right"><Link href={`/dashboard/superadmin/brokerages/${r.brokerageId}`} className="text-xs font-medium text-indigo-600">Manage →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
