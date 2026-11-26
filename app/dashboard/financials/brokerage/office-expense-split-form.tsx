"use client"

// SPLIT A MAIN-OFFICE COST ACROSS OFFICES (wave 153, lane 153A). The write half of the office rollup: the consolidated
// books keeper picks one main-office expense, gives each office (and optionally the main office itself) a percentage
// that totals exactly 100%, and names the rule. The server (allocateSharedExpense → allocateSharedExpenseCore) re-checks
// every part — this form only refuses early what the server would refuse anyway. The expense row is never copied.

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Split } from "lucide-react"
import { allocateSharedExpense } from "@/app/actions/financials"

const MAIN = "__main_office__"

export function OfficeExpenseSplitForm({ expenses, offices }: {
  expenses: Array<{ id: string; description: string; amount: number; expenseDate: string }>
  offices: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [expenseId, setExpenseId] = useState(expenses[0]?.id ?? "")
  const [percents, setPercents] = useState<Record<string, string>>({})
  const [rule, setRule] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const targets = useMemo(() => [...offices.map((o) => ({ id: o.id, name: o.name })), { id: MAIN, name: "Main office (keeps its share)" }], [offices])
  const totalBps = targets.reduce((s, t) => s + Math.round((Number(percents[t.id] ?? 0) || 0) * 100), 0)
  const expense = expenses.find((e) => e.id === expenseId) ?? null

  async function save() {
    setBusy(true); setResult(null)
    const shares = targets
      .filter((t) => Number(percents[t.id] ?? 0) > 0)
      .map((t) => ({ locationId: t.id === MAIN ? null : t.id, percent: Number(percents[t.id]) }))
    const r = await allocateSharedExpense({ expenseId, shares, ruleLabel: rule })
    setBusy(false)
    if (r.success) {
      setResult({ ok: true, text: "Saved. Each office now carries its share; the expense itself is unchanged and counted once." })
      router.refresh()
    } else {
      setResult({ ok: false, text: r.error ?? "The split could not be saved. Nothing was changed." })
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Split className="h-4 w-4" /> Split a main-office cost across offices</div>
      <div className="space-y-1">
        <Label htmlFor="split-expense">Expense</Label>
        <select id="split-expense" className="h-8 w-full rounded border bg-background text-sm" value={expenseId} onChange={(e) => setExpenseId(e.target.value)}>
          {expenses.map((e) => <option key={e.id} value={e.id}>{e.expenseDate} — {e.description} (${e.amount.toFixed(2)})</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {targets.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <Label htmlFor={`split-${t.id}`} className="flex-1 text-sm">{t.name}</Label>
            <Input id={`split-${t.id}`} type="number" min="0" max="100" step="0.01" className="h-8 w-24" placeholder="0"
              value={percents[t.id] ?? ""} onChange={(e) => setPercents((p) => ({ ...p, [t.id]: e.target.value }))} />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor="split-rule">How it is split</Label>
        <Input id="split-rule" placeholder="e.g. Shared office rent, split by headcount" value={rule} onChange={(e) => setRule(e.target.value)} />
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className={totalBps === 10000 ? "text-emerald-700" : "text-muted-foreground"}>Total {(totalBps / 100).toFixed(2)}% {totalBps === 10000 ? "" : "— must be exactly 100%"}</span>
        <Button size="sm" onClick={save} disabled={busy || !expense || totalBps !== 10000 || !rule.trim()}>
          {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save split
        </Button>
      </div>
      {result && <p role="status" className={result.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{result.text}</p>}
    </div>
  )
}
