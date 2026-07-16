"use client"

// Scoped expense entry — the brokerage money page's write half (owner spec:
// "brokerages/agents/teams can add expenses"). Agent-scope entry already lives
// on /dashboard/financials/expenses; this section adds the missing team +
// brokerage scopes and lets a producing broker log to their own book too.
// Writes through logScopedExpense (scope semantics: agent_id / team_id /
// neither = brokerage) — the monthly rollup folds team+brokerage rows into
// brokerage_p_l expense buckets, so this is what turns the Margin Breakdown
// panel's expense lines from empty to real.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Receipt, Loader2, CheckCircle2 } from "lucide-react"
import { logScopedExpense, type ExpenseScope } from "@/app/actions/financials"

// Same category vocabulary the agent expense flow + tax concierge fold on —
// these map to brokerage_p_l buckets (marketing/office/tech/operating).
const CATEGORIES = ["marketing", "office", "technology", "education", "transportation", "other"]

export interface TeamOption { id: string; name: string }

export function ScopedExpenseEntry({ teams, canLogAgentScope }: { teams: TeamOption[]; canLogAgentScope: boolean }) {
  const router = useRouter()
  const [scope, setScope] = useState<ExpenseScope>("brokerage")
  const [teamId, setTeamId] = useState<string>(teams[0]?.id ?? "")
  const [category, setCategory] = useState("office")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [date, setDate] = useState(new Date().toISOString().split("T")[0])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!description.trim() || !amount || !date) return
    setSaving(true); setError(null); setSaved(false)
    const result = await logScopedExpense({
      scope,
      category,
      description,
      amount: Number(amount),
      expenseDate: date,
      teamId: scope === "team" ? teamId : null,
    })
    setSaving(false)
    if (result.success) {
      setSaved(true)
      setDescription(""); setAmount("")
      router.refresh()
    } else {
      setError(result.error ?? "Failed to save expense")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="w-5 h-5 text-orange-600" />
          Log Operating Expense
        </CardTitle>
        <CardDescription>
          Brokerage expenses feed the monthly P&L expense lines above. Team expenses stay on the team&apos;s own book and agent expenses on the agent&apos;s — neither rolls up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="exp-scope">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as ExpenseScope)}>
              <SelectTrigger id="exp-scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="brokerage">Brokerage</SelectItem>
                {teams.length > 0 && <SelectItem value="team">Team</SelectItem>}
                {canLogAgentScope && <SelectItem value="agent">My book (agent)</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {scope === "team" && (
            <div className="space-y-1.5">
              <Label htmlFor="exp-team">Team</Label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id="exp-team"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="exp-category">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="exp-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-amount">Amount ($)</Label>
            <Input id="exp-amount" type="number" min="0" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-date">Date</Label>
            <Input id="exp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="exp-desc">Description</Label>
          <Textarea id="exp-desc" rows={2} placeholder="e.g. Office rent — July, MLS board dues, brokerage CRM subscription" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving || !description.trim() || !amount || !date || (scope === "team" && !teamId)}>
            {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</> : "Save Expense"}
          </Button>
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600">
              <CheckCircle2 className="h-4 w-4" /> Logged — P&amp;L updates on the next nightly rollup
            </span>
          )}
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
