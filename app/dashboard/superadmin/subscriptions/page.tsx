import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { getSubscriptionOversightAction } from "@/app/actions/superadmin/subscription-oversight"
import type { SubscriptionState } from "@/lib/platform/subscription-oversight"
import { loadRevenueAnalytics } from "@/lib/platform/revenue-analytics"
import { DUNNING_LADDER } from "@/lib/billing/dunning"

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
  const gate = await requirePlatformCapability("billing")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const svc = createServiceClient()
  const [res, revenue, dunningRes] = await Promise.all([
    getSubscriptionOversightAction(),
    loadRevenueAnalytics(svc).catch(() => null),
    // DUNNING LEDGER — the billing-dunning cron's audit spine (platform_dunning_events).
    // Written daily by lib/billing/dunning.ts; this is the staff read.
    svc.from("platform_dunning_events")
      .select("id, brokerage_id, subscription_id, step, channel, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ])
  if (!res.ok) return <div className="p-6 text-red-600">Failed: {res.error}</div>
  const { rows, queue, counts, totalMrrCents, attentionCount } = res.data
  const maxMonth = Math.max(1, ...(revenue?.months ?? []).map((m) => m.paidCents))

  // Dunning rollup: recent events (newest first) + each tenant's CURRENT ladder
  // step (the latest event per brokerage — rows already arrive newest-first).
  const dunningEvents = (dunningRes.data ?? []) as Array<{
    id: string; brokerage_id: string; subscription_id: string | null
    step: number; channel: string | null; detail: string | null; created_at: string
  }>
  const tenantNameById = new Map<string, string>(rows.map((r) => [r.brokerageId, r.name]))
  const latestStepByTenant = new Map<string, { step: number; at: string; channel: string | null }>()
  for (const e of dunningEvents) {
    if (!latestStepByTenant.has(e.brokerage_id)) {
      latestStepByTenant.set(e.brokerage_id, { step: e.step, at: e.created_at, channel: e.channel })
    }
  }
  const ladderStepLabel = (step: number) => {
    const rung = DUNNING_LADDER.find((s) => s.step === step)
    return rung ? `Step ${rung.step}/${DUNNING_LADDER.length} (day ${rung.afterDays})` : `Step ${step}`
  }
  const fmtAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
  }

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
          <Link href="/dashboard/superadmin/affiliates" className="rounded-md border px-3 py-1 text-sm">Affiliates</Link>
          <Link href="/dashboard/superadmin/coupons" className="rounded-md border px-3 py-1 text-sm">Coupons</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* ── Your AI team's read ──────────────────────────────────────────────
          A master console's job is to run the tenant base BY EXCEPTION: which
          dollars are actively failing to collect, which are about to walk, and
          where the book is fragile. Deterministic over the same oversight rows
          the table below lists — no new queries. Signal ownership: subscription
          + dunning oversight is the platform_sentinel domain
          (lib/kernel/manager-registry.ts). */}
      {(() => {
        const reads: Array<{ severity: "urgent" | "warn" | "good"; text: string }> = []
        const pastDue = rows.filter((r) => r.state === "past_due")
        const pastDueMrr = pastDue.reduce((s, r) => s + (r.mrrCents ?? 0), 0)
        const expiring = rows.filter((r) => r.state === "trial_expiring")
        const noSub = rows.filter((r) => r.state === "no_subscription")

        if (pastDue.length > 0) {
          reads.push({
            severity: "urgent",
            text: `${fmtCents(pastDueMrr)} of MRR is past due across ${pastDue.length} tenant${pastDue.length === 1 ? "" : "s"} — this is billed revenue actively failing to collect, not forecast. Every day in dunning lowers the odds it lands.`,
          })
        }
        if (expiring.length > 0) {
          const expiringMrr = expiring.reduce((s, r) => s + (r.mrrCents ?? 0), 0)
          const soonest = expiring.reduce((a, b) =>
            (a.daysToTrialEnd ?? 99) <= (b.daysToTrialEnd ?? 99) ? a : b)
          reads.push({
            severity: "warn",
            text: `${expiring.length} trial${expiring.length === 1 ? "" : "s"} expiring${expiringMrr > 0 ? ` (${fmtCents(expiringMrr)} at stake)` : ""} — soonest is ${soonest.name} in ${soonest.daysToTrialEnd ?? 0} day${soonest.daysToTrialEnd === 1 ? "" : "s"}. A trial that ends without a conversation converts by accident, not by design.`,
          })
        }
        if (noSub.length > 0) {
          reads.push({
            severity: "warn",
            text: `${noSub.length} tenant${noSub.length === 1 ? " has" : "s have"} no subscription attached — they're on the platform without a billing relationship. That's either intentional (comp/pilot) or silent leakage; either way it should be a decision, not a default.`,
          })
        }
        // Concentration: how exposed is the book to its largest account?
        if (totalMrrCents > 0 && rows.length > 1) {
          const top = rows.reduce((a, b) => ((a.mrrCents ?? 0) >= (b.mrrCents ?? 0) ? a : b))
          const share = Math.round(((top.mrrCents ?? 0) / totalMrrCents) * 100)
          if (share >= 40) {
            reads.push({
              severity: "warn",
              text: `${top.name} is ${share}% of total MRR — the book is concentrated. Losing one account would move the whole number, so treat their health as a platform metric.`,
            })
          }
        }
        if (reads.length === 0) {
          reads.push({
            severity: "good",
            text: `Nothing needs intervention — no past-due balances, no trials about to lapse, every tenant on a subscription. ${fmtCents(totalMrrCents)} MRR is collecting cleanly.`,
          })
        }

        const STYLE: Record<string, string> = {
          urgent: "border-red-200 bg-red-50/60", warn: "border-amber-200 bg-amber-50/60", good: "border-emerald-200 bg-emerald-50/60",
        }
        const DOT: Record<string, string> = { urgent: "bg-red-500", warn: "bg-amber-500", good: "bg-emerald-500" }

        return (
          <section className="rounded-lg border border-indigo-200 p-4 space-y-2">
            <h2 className="text-sm font-semibold">Your AI team&apos;s read</h2>
            {reads.map((r, i) => (
              <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${STYLE[r.severity]}`}>
                <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[r.severity]}`} />
                <p className="text-sm leading-relaxed">{r.text}</p>
              </div>
            ))}
          </section>
        )
      })()}

      {/* Revenue trend — collected (paid) revenue by month + churn, from billing_invoices */}
      {revenue && (
        <section className="rounded-lg border p-4 space-y-3">
          <div className="flex items-end justify-between flex-wrap gap-2">
            <h2 className="text-lg font-semibold">Revenue trend</h2>
            <div className="flex items-center gap-4 text-sm">
              <span><span className="font-bold tabular-nums">{fmtCents(revenue.currentMrrCents)}</span> <span className="text-muted-foreground">collected this month</span></span>
              <span className={revenue.momGrowth >= 0 ? "text-emerald-700" : "text-red-700"}>
                {revenue.momGrowth >= 0 ? "▲" : "▼"} {(Math.abs(revenue.momGrowth) * 100).toFixed(0)}% MoM
              </span>
              <span><span className="font-bold tabular-nums">{(revenue.churnRate * 100).toFixed(1)}%</span> <span className="text-muted-foreground">churn</span></span>
              <span className="text-muted-foreground">{revenue.activeCount} active · {revenue.trialingCount} trialing · {revenue.cancelledInWindow} cancelled</span>
            </div>
          </div>
          <div className="flex items-end gap-2 h-24">
            {revenue.months.map((m) => (
              <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full rounded-t bg-emerald-500/70" style={{ height: `${Math.max(3, Math.round((m.paidCents / maxMonth) * 80))}px` }} title={`${m.month}: ${fmtCents(m.paidCents)} (${m.invoices} invoices)`} />
                <span className="text-[10px] text-muted-foreground">{m.month.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

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
                  {/* THE DUNNING CONTACT. Merged from the deleted
                      app/actions/billing.ts:getDelinquentAccounts, whose only
                      advantage over this queue was carrying the brokerage email
                      — an attention row that says a tenant is past due without
                      saying who to reach is half an alert. */}
                  {r.email ? (
                    <p className="text-xs text-muted-foreground/80 truncate">{r.email}</p>
                  ) : (
                    <p className="text-xs italic text-muted-foreground/60 truncate">No billing email on file</p>
                  )}
                </div>
                <span className="shrink-0 text-sm font-semibold">{fmtCents(r.mrrCents)}<span className="text-xs text-muted-foreground">/mo</span></span>
                <span className="shrink-0 text-xs font-medium text-indigo-600">Manage →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Dunning ledger — platform_dunning_events (written by the billing-dunning cron) */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Dunning — recovery ladder</h2>
        {dunningRes.error ? (
          <div className="rounded-lg border p-4 text-sm text-red-600">Failed to load dunning ledger: {dunningRes.error.message}</div>
        ) : dunningEvents.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No dunning events — no past-due subscription has needed a recovery nudge. The daily billing-dunning cron records every ladder step here.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {/* Per-tenant current ladder step */}
            <div className="rounded-lg border p-4 space-y-2">
              <h3 className="text-sm font-semibold">Tenants on the ladder ({latestStepByTenant.size})</h3>
              <p className="text-xs text-muted-foreground">Latest step sent per tenant (day 0 → 3 → 7 → 14; each step sent once per past-due episode).</p>
              <ul className="space-y-1.5">
                {[...latestStepByTenant.entries()].map(([brokerageId, s]) => (
                  <li key={brokerageId} className="flex items-center gap-2 text-sm">
                    <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold " + (s.step >= 4 ? "bg-red-100 text-red-800" : s.step >= 3 ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800")}>
                      {ladderStepLabel(s.step)}
                    </span>
                    <Link href={`/dashboard/superadmin/brokerages/${brokerageId}`} className="min-w-0 flex-1 truncate text-sm font-medium text-indigo-600">
                      {tenantNameById.get(brokerageId) ?? `Brokerage ${brokerageId.slice(0, 8)}`}
                    </Link>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{s.channel ?? "in_app"} · {fmtAgo(s.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
            {/* Recent events */}
            <div className="rounded-lg border p-4 space-y-2">
              <h3 className="text-sm font-semibold">Recent dunning events</h3>
              <ul className="space-y-1.5">
                {dunningEvents.slice(0, 12).map((e) => (
                  <li key={e.id} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">step {e.step}</span>
                    <span className="shrink-0 font-medium">{tenantNameById.get(e.brokerage_id) ?? `Brokerage ${e.brokerage_id.slice(0, 8)}`}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={e.detail ?? undefined}>{e.detail ?? ""}</span>
                    <span className="shrink-0 text-muted-foreground">{e.channel ?? "in_app"} · {fmtAgo(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
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
