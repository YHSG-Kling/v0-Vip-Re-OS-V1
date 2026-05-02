"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, ShieldCheck, ClipboardList } from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  getClosingChecklist,
  completeChecklistItem,
  aiGenerateClosingChecklist,
  getClosingPrepSummary,
} from "@/app/actions/ai-closing-workflow"

interface Props {
  contactId: string
  agentId: string
  brokerageId: string
}

interface ChecklistItem {
  id: string
  item_name: string
  category: string
  sequence: number
  required: boolean
  completed: boolean
  notes: string | null
  completed_at: string | null
}

interface Transaction {
  id: string
  status: string
  close_date: string | null
}

export function ClosingWorkflowTab({ contactId, agentId, brokerageId }: Props) {
  const [loading, setLoading] = useState(true)
  const [transaction, setTransaction] = useState<Transaction | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [generating, setGenerating] = useState(false)
  const [isPending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    try {
      // Find the contact's active in-flight transaction.
      const supabase = createClient()
      const { data: txns } = await supabase
        .from("transactions")
        .select("id, status, close_date")
        .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
        .in("status", ["under_contract", "pending", "closing", "active"])
        .order("close_date", { ascending: true, nullsFirst: false })
        .limit(1)

      const txn = txns?.[0] ?? null
      setTransaction(txn as Transaction | null)

      if (txn) {
        const [checklistResult, summaryResult] = await Promise.all([
          getClosingChecklist({ transactionId: txn.id, agentId }),
          getClosingPrepSummary({ transactionId: txn.id }).catch(() => null),
        ])
        if ((checklistResult as any).success) {
          setItems(((checklistResult as any).items ?? []) as ChecklistItem[])
        }
        if (summaryResult && (summaryResult as any).success) {
          setSummary((summaryResult as any).summary ?? (summaryResult as any).data ?? null)
        }
      } else {
        setItems([])
        setSummary(null)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  function toggleComplete(item: ChecklistItem) {
    if (item.completed) return // Skip un-completing for now
    startTransition(async () => {
      const result = await completeChecklistItem({
        itemId: item.id,
        completedBy: agentId,
      })
      if ((result as any).success) {
        setItems((curr) =>
          curr.map((i) =>
            i.id === item.id
              ? { ...i, completed: true, completed_at: new Date().toISOString() }
              : i,
          ),
        )
      } else {
        toast.error((result as any).error ?? "Couldn't update item.")
      }
    })
  }

  async function generateChecklist() {
    if (!transaction) return
    setGenerating(true)
    try {
      const result = await aiGenerateClosingChecklist({
        transactionId: transaction.id,
        agentId,
        brokerageId,
      })
      if ((result as any).success) {
        toast.success(`Generated ${(result as any).itemsCreated ?? 0} checklist items.`)
        await load()
      } else {
        toast.error((result as any).error ?? "Generation failed.")
      }
    } finally {
      setGenerating(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground text-center">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Loading closing workflow…
        </CardContent>
      </Card>
    )
  }

  if (!transaction) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground text-center space-y-2">
          <ClipboardList className="h-6 w-6 mx-auto opacity-50" />
          <p>No active transaction for this contact.</p>
          <p className="text-xs">The closing workflow appears once the contact has a transaction in <code>under_contract</code>, <code>pending</code>, or <code>closing</code> status.</p>
        </CardContent>
      </Card>
    )
  }

  // Group items by category (loan / title / final_walk / etc.)
  const grouped = items.reduce<Record<string, ChecklistItem[]>>((acc, it) => {
    const cat = it.category || "other"
    ;(acc[cat] ??= []).push(it)
    return acc
  }, {})

  const totalRequired = items.filter((i) => i.required).length
  const completedRequired = items.filter((i) => i.required && i.completed).length
  const percentComplete =
    totalRequired === 0 ? 0 : Math.round((completedRequired / totalRequired) * 100)

  return (
    <div className="space-y-4">
      {/* Header — readiness summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Closing readiness
            </span>
            <Badge variant="outline" className="text-xs">
              <Link href={`/dashboard/transactions/${transaction.id}`} className="flex items-center gap-1">
                Open transaction <ExternalLink className="h-3 w-3" />
              </Link>
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">
                  Required items: {completedRequired} / {totalRequired}
                </span>
                {transaction.close_date && (
                  <span className="text-muted-foreground">
                    Closes {new Date(transaction.close_date).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percentComplete}%` }}
                />
              </div>
            </div>
            <span className="text-2xl font-bold tabular-nums">{percentComplete}%</span>
          </div>

          {summary?.ai_summary && (
            <p className="text-xs text-muted-foreground italic">{summary.ai_summary}</p>
          )}
          {summary?.closing_risk && (
            <Badge
              variant="outline"
              className={
                summary.closing_risk === "low"
                  ? "text-emerald-700 border-emerald-300"
                  : summary.closing_risk === "medium"
                  ? "text-amber-700 border-amber-300"
                  : "text-red-700 border-red-300"
              }
            >
              {summary.closing_risk === "low" ? (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              ) : (
                <AlertTriangle className="h-3 w-3 mr-1" />
              )}
              Risk: {summary.closing_risk}
            </Badge>
          )}
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <ClipboardList className="h-6 w-6 mx-auto text-muted-foreground" />
            <p className="text-sm">No checklist items yet for this transaction.</p>
            <Button onClick={generateChecklist} disabled={generating}>
              {generating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <ClipboardList className="h-4 w-4 mr-2" />
                  Generate checklist with AI
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      ) : (
        Object.entries(grouped).map(([category, catItems]) => (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm capitalize">{category.replace(/_/g, " ")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {catItems
                  .sort((a, b) => a.sequence - b.sequence)
                  .map((item) => (
                    <li key={item.id} className="flex items-start gap-3 py-2">
                      <button
                        onClick={() => toggleComplete(item)}
                        disabled={isPending || item.completed}
                        className={`mt-0.5 h-5 w-5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                          item.completed
                            ? "bg-emerald-100 border-emerald-300 text-emerald-700"
                            : "bg-background border-muted-foreground/30 hover:border-primary"
                        }`}
                        aria-label={item.completed ? "Completed" : "Mark complete"}
                      >
                        {item.completed && <CheckCircle2 className="h-3.5 w-3.5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm ${
                            item.completed ? "line-through text-muted-foreground" : "font-medium"
                          }`}
                        >
                          {item.item_name}
                          {item.required && !item.completed && (
                            <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-700">
                              required
                            </span>
                          )}
                        </p>
                        {item.notes && (
                          <p className="text-xs text-muted-foreground mt-0.5">{item.notes}</p>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}
