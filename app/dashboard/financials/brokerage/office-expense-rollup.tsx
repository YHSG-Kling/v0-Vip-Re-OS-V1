// EXPENSES BY OFFICE (wave 153, lane 153A) — the read half of "each location takes care of expenses but all can roll up
// to the main tenant". Server component: the viewer's ids come from the page's SESSION read, the rollup from the ONE
// reader (lib/finance/expense-rollup.ts loadExpenseRollup), which decides consolidated vs office-scoped from the tenant
// hierarchy × the books roster and refuses on any refused read — a refusal renders as "could not be loaded", never as $0.

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Building2 } from "lucide-react"
import { usd2Grouped } from "@/lib/format/money"
import { OfficeExpenseSplitForm } from "./office-expense-split-form"

export async function OfficeExpenseRollupSection({ userId, brokerageId, userType }: { userId: string; brokerageId: string; userType: string | null }) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { loadExpenseRollup } = await import("@/lib/finance/expense-rollup")
  const svc = createServiceClient()
  const year = new Date().getUTCFullYear()
  const period = { from: `${year}-01-01`, to: `${year}-12-31` }
  const res = await loadExpenseRollup(svc, { userId, brokerageId, userType }, period)
  if (!res.ok) {
    if (res.error === "no_books_in_scope") return null
    return (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Expenses by office</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The office expense totals could not be loaded right now. Nothing was changed; reload the page to try again.
        </CardContent>
      </Card>
    )
  }
  const { rollup, authority } = res
  // A single-office tenant has nothing to break down by office — the company books above ARE the whole picture.
  if (!authority.multiLocation) return null

  // The split audit trail (who split which main-office cost, on what rule, and who replaced it) — consolidated readers only.
  const { loadExpenseSplitHistory } = await import("@/lib/finance/expense-rollup")
  const history = rollup.consolidated ? await loadExpenseSplitHistory(svc, { userId, brokerageId, userType }, { limit: 60 }) : null
  const recentSplits = history && history.ok ? history.entries.slice(0, 8) : []

  let centralRows: Array<{ id: string; description: string; amount: number; expenseDate: string }> = []
  if (authority.writeCentral) {
    const { data, error } = await svc
      .from("business_expenses")
      .select("id, description, amount, expense_date")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .is("location_id", null)
      .gt("amount", 0)
      .gte("expense_date", period.from)
      .order("expense_date", { ascending: false })
      .limit(25)
    if (!error) {
      centralRows = ((data ?? []) as Array<{ id: string; description: string | null; amount: number | string; expense_date: string }>)
        .filter((r) => !/\(reverses expense /i.test(String(r.description ?? "")))
        .map((r) => ({ id: r.id, description: String(r.description ?? "Expense"), amount: Number(r.amount) || 0, expenseDate: r.expense_date }))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Expenses by office — {year}</CardTitle>
        <CardDescription>
          {rollup.consolidated
            ? "Each office's own expenses plus its share of split main-office costs. Every expense is counted once: the offices plus the main office equal the company total."
            : "Your office's expenses and its share of split main-office costs. Other offices' details are not shown."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Phone: one card per office (the table below is for md and up). */}
        <div className="space-y-2 md:hidden">
          {rollup.offices.map((o) => (
            <div key={o.locationId} className="rounded-lg border p-3 text-sm">
              <p className="font-medium">{o.name}</p>
              <div className="mt-1 flex justify-between text-muted-foreground"><span>Own expenses</span><span className="tabular-nums">{usd2Grouped(o.owned)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Share of main-office costs</span><span className="tabular-nums">{usd2Grouped(o.allocatedIn)}</span></div>
              <div className="flex justify-between font-medium"><span>Office total</span><span className="tabular-nums">{usd2Grouped(o.total)}</span></div>
            </div>
          ))}
          {rollup.consolidated && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between"><span>Main office — not split</span><span className="tabular-nums">{usd2Grouped(rollup.centralUnallocated ?? 0)}</span></div>
              <div className="flex justify-between"><span>Main office — its own share</span><span className="tabular-nums">{usd2Grouped(rollup.centralRetained ?? 0)}</span></div>
              <div className="flex justify-between font-semibold"><span>Company total</span><span className="tabular-nums">{usd2Grouped(rollup.tenantTotal ?? 0)}</span></div>
            </div>
          )}
        </div>
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Office</th>
                <th className="px-3 py-2 font-medium text-right">Own expenses</th>
                <th className="px-3 py-2 font-medium text-right">Share of main-office costs</th>
                <th className="px-3 py-2 font-medium text-right">Office total</th>
              </tr>
            </thead>
            <tbody>
              {rollup.offices.map((o) => (
                <tr key={o.locationId} className="border-b last:border-0">
                  <td className="px-3 py-2">{o.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd2Grouped(o.owned)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd2Grouped(o.allocatedIn)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{usd2Grouped(o.total)}</td>
                </tr>
              ))}
              {rollup.consolidated && (
                <>
                  <tr className="border-b">
                    <td className="px-3 py-2">Main office — not split</td>
                    <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>{usd2Grouped(rollup.centralUnallocated ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd2Grouped(rollup.centralUnallocated ?? 0)}</td>
                  </tr>
                  <tr className="border-b">
                    <td className="px-3 py-2">Main office — its own share of split costs</td>
                    <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>{usd2Grouped(rollup.centralRetained ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{usd2Grouped(rollup.centralRetained ?? 0)}</td>
                  </tr>
                  <tr className="bg-muted/30">
                    <td className="px-3 py-2 font-semibold">Company total</td>
                    <td className="px-3 py-2" colSpan={2} />
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{usd2Grouped(rollup.tenantTotal ?? 0)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        {rollup.consolidated && rollup.reversals.count > 0 && (
          <p className="text-xs text-muted-foreground">
            Includes {rollup.reversals.count} refund{rollup.reversals.count === 1 ? "" : "s"} or credit{rollup.reversals.count === 1 ? "" : "s"} ({usd2Grouped(rollup.reversals.amount)}), each netted against the office that carried the original cost.
          </p>
        )}
        {rollup.consolidated && !rollup.balanced && (
          <p className="text-sm text-destructive">
            The office totals and the company total do not agree, so these figures are held for review. Nothing was changed; contact support with this page open.
          </p>
        )}
        {rollup.consolidated && rollup.staleSplits > 0 && (
          <p className="text-sm text-amber-800">
            {rollup.staleSplits} split{rollup.staleSplits === 1 ? " was" : "s were"} recorded before the expense amount changed. The office totals above already use the current amount by each office&apos;s share; split {rollup.staleSplits === 1 ? "it" : "them"} again to refresh the recorded amounts.
          </p>
        )}
        {history && !history.ok && (
          <p className="text-xs text-muted-foreground">The split history could not be loaded right now.</p>
        )}
        {recentSplits.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="font-medium">Recent splits</p>
            <ul className="space-y-1">
              {recentSplits.map((h) => (
                <li key={h.allocationSetId} className="flex flex-wrap gap-x-2 rounded border p-2 text-muted-foreground">
                  <span className="text-foreground">{h.ruleLabel ?? "Split"}</span>
                  <span className="tabular-nums">{usd2Grouped(h.total)} across {h.shareCount} share{h.shareCount === 1 ? "" : "s"}</span>
                  <span>by {h.createdBy ?? "unknown"} on {h.createdAt.slice(0, 10)}</span>
                  {h.supersededAt && <span>— replaced{h.supersededBy ? ` by ${h.supersededBy}` : ""} on {h.supersededAt.slice(0, 10)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {authority.writeCentral && centralRows.length > 0 && (
          <OfficeExpenseSplitForm
            expenses={centralRows}
            offices={rollup.offices.map((o) => ({ id: o.locationId, name: o.name }))}
          />
        )}
      </CardContent>
    </Card>
  )
}
