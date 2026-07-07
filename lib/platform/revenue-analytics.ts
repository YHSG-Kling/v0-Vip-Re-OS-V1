// lib/platform/revenue-analytics.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM REVENUE ANALYTICS — the trajectory the oversight queue lacked. The
// subscriptions page showed STATE (who's active/past-due); this rolls the same
// tables up into TREND: MRR by month (from PAID invoices — real money, not list
// price), active/trialing counts, and churn (cancellations in the window). Pure
// roll-up (provable) + a thin loader; no new tables.

export interface MonthlyRevenue {
  month: string // YYYY-MM
  paidCents: number
  invoices: number
}

export interface RevenueAnalytics {
  months: MonthlyRevenue[]
  /** Most recent full month's collected revenue. */
  currentMrrCents: number
  /** Month-over-month growth of collected revenue, -1..∞ (0 when no prior). */
  momGrowth: number
  activeCount: number
  trialingCount: number
  cancelledInWindow: number
  /** cancelled / (active + cancelled) over the window, 0..1 */
  churnRate: number
}

/** PURE: roll paid invoices + subscription states up to the revenue trend. */
export function rollupRevenueAnalytics(
  invoices: Array<{ amount_cents: number | null; status: string | null; paid_at: string | null; invoice_date: string | null }>,
  subs: Array<{ status: string | null; cancelled_at: string | null }>,
  windowMonths = 6,
  now: Date = new Date(),
): RevenueAnalytics {
  const byMonth = new Map<string, { paidCents: number; invoices: number }>()
  for (let i = windowMonths - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    byMonth.set(d.toISOString().slice(0, 7), { paidCents: 0, invoices: 0 })
  }
  for (const inv of invoices) {
    if ((inv.status ?? "") !== "paid") continue
    const when = inv.paid_at ?? inv.invoice_date
    if (!when) continue
    const key = when.slice(0, 7)
    const slot = byMonth.get(key)
    if (!slot) continue
    slot.paidCents += Number(inv.amount_cents ?? 0)
    slot.invoices += 1
  }
  const months: MonthlyRevenue[] = [...byMonth.entries()].map(([month, v]) => ({ month, ...v }))
  const last = months[months.length - 1]?.paidCents ?? 0
  const prev = months[months.length - 2]?.paidCents ?? 0
  const momGrowth = prev > 0 ? (last - prev) / prev : 0

  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - windowMonths, 1)).toISOString()
  let activeCount = 0, trialingCount = 0, cancelledInWindow = 0
  for (const s of subs) {
    const st = (s.status ?? "").toLowerCase()
    if (st === "active") activeCount++
    else if (st === "trialing") trialingCount++
    else if ((st === "cancelled" || st === "canceled") && (s.cancelled_at ?? "") >= windowStart) cancelledInWindow++
  }
  const churnRate = activeCount + cancelledInWindow > 0 ? cancelledInWindow / (activeCount + cancelledInWindow) : 0
  return { months, currentMrrCents: last, momGrowth, activeCount, trialingCount, cancelledInWindow, churnRate }
}

/** Load + roll up (cross-tenant; staff-gated by the caller). */
export async function loadRevenueAnalytics(svc: any, windowMonths = 6, now: Date = new Date()): Promise<RevenueAnalytics> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - windowMonths, 1)).toISOString().slice(0, 10)
  const [{ data: invoices }, { data: subs }] = await Promise.all([
    svc.from("billing_invoices").select("amount_cents, status, paid_at, invoice_date").gte("invoice_date", since).limit(5000),
    svc.from("subscriptions").select("status, cancelled_at").limit(5000),
  ])
  return rollupRevenueAnalytics(invoices ?? [], subs ?? [], windowMonths, now)
}
