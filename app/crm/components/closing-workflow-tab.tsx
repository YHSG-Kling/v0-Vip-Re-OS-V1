"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  ClipboardList,
  User,
  Building2,
  FileText,
  Banknote,
} from "lucide-react"
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

// pass 13: the live closing_checklist_items columns are item_name/category/
// notes — the old item_label/phase/owner/due_date fields never existed and the
// whole tab rendered blanks. Owner + due date ride in notes ("owner: x · due: y").
interface ChecklistItem {
  id: string
  item_name: string
  category: string
  notes: string | null
  completed: boolean
  completed_at: string | null
}

function ownerFromNotes(notes: string | null): string {
  const m = /owner:\s*([\w-]+)/i.exec(notes ?? "")
  return m?.[1] ?? "agent"
}

function dueFromNotes(notes: string | null): string | null {
  const m = /due:\s*(\d{4}-\d{2}-\d{2})/i.exec(notes ?? "")
  return m?.[1] ?? null
}

interface Transaction {
  id: string
  status: string
  close_date: string | null
  buyer_contact_id: string | null
  seller_contact_id: string | null
}

interface CDARecord {
  id: string
  status: "not_started" | "pending" | "submitted" | "approved"
}

const OWNER_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  agent:  { label: "Agent",   icon: <User className="h-3 w-3" />,      color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  tc:     { label: "TC",      icon: <ClipboardList className="h-3 w-3" />, color: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200" },
  lender: { label: "Lender",  icon: <Banknote className="h-3 w-3" />,   color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" },
  title:  { label: "Title",   icon: <Building2 className="h-3 w-3" />,  color: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
  client: { label: "Client",  icon: <User className="h-3 w-3" />,       color: "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200" },
  buyer:  { label: "Buyer",   icon: <User className="h-3 w-3" />,       color: "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200" },
  seller: { label: "Seller",  icon: <User className="h-3 w-3" />,       color: "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200" },
  compliance: { label: "Compliance", icon: <ShieldCheck className="h-3 w-3" />, color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
}

function OwnerBadge({ owner }: { owner: string }) {
  const meta = OWNER_META[owner.toLowerCase()] ?? { label: owner, icon: <FileText className="h-3 w-3" />, color: "bg-muted text-muted-foreground" }
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium ${meta.color}`}>
      {meta.icon}
      {meta.label}
    </span>
  )
}

// Seller-side checklist phases / items
const SELLER_PHASES = new Set(["financial", "documents", "compliance", "agent"])
// Buyer-side checklist phases
const BUYER_PHASES  = new Set(["lender", "inspection", "title", "client"])
// Agent-owned items (CDA gate)
const AGENT_PHASES  = new Set(["agent", "compliance"])

export function ClosingWorkflowTab({ contactId, agentId, brokerageId }: Props) {
  const [loading, setLoading]       = useState(true)
  const [transaction, setTransaction] = useState<Transaction | null>(null)
  const [items, setItems]           = useState<ChecklistItem[]>([])
  const [summary, setSummary]       = useState<any>(null)
  const [cda, setCda]               = useState<CDARecord | null>(null)
  const [generating, setGenerating] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [contactRole, setContactRole] = useState<"buyer" | "seller" | "both">("both")

  async function load() {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data: txns } = await supabase
        .from("transactions")
        .select("id, status, close_date, buyer_contact_id, seller_contact_id")
        .or(`contact_id.eq.${contactId},buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
        .in("status", ["under_contract", "pending", "closing", "active"])
        .order("close_date", { ascending: true, nullsFirst: false })
        .limit(1)

      const txn = txns?.[0] ?? null
      setTransaction(txn as Transaction | null)

      if (txn) {
        // Determine if this contact is buyer or seller
        if (txn.buyer_contact_id === contactId && txn.seller_contact_id === contactId) {
          setContactRole("both")
        } else if (txn.buyer_contact_id === contactId) {
          setContactRole("buyer")
        } else if (txn.seller_contact_id === contactId) {
          setContactRole("seller")
        } else {
          setContactRole("both")
        }

        const [checklistResult, summaryResult, cdaResult] = await Promise.all([
          getClosingChecklist({ transactionId: txn.id, agentId }),
          getClosingPrepSummary({ transactionId: txn.id }).catch(() => null),
          supabase
            .from("closing_disclosure_agreement")
            .select("id, status")
            .eq("transaction_id", txn.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ])

        if ((checklistResult as any).success) {
          const rawItems = (checklistResult as any).data?.items ?? (checklistResult as any).items ?? []
          setItems(rawItems as ChecklistItem[])
        }
        if (summaryResult && (summaryResult as any).success) {
          setSummary((summaryResult as any).summary ?? (summaryResult as any).data ?? null)
        }
        setCda((cdaResult.data as CDARecord | null) ?? null)
      } else {
        setItems([])
        setSummary(null)
        setCda(null)
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
    if (item.completed) return
    startTransition(async () => {
      const result = await completeChecklistItem({ itemId: item.id, completedBy: agentId })
      if ((result as any).success) {
        setItems((curr) =>
          curr.map((i) =>
            i.id === item.id ? { ...i, completed: true, completed_at: new Date().toISOString() } : i
          )
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
      const result = await aiGenerateClosingChecklist({ transactionId: transaction.id, agentId, brokerageId })
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
          <p className="text-xs">
            The closing workflow appears once the contact has a transaction in{" "}
            <code>under_contract</code>, <code>pending</code>, or <code>closing</code> status.
          </p>
        </CardContent>
      </Card>
    )
  }

  const totalItems      = items.length
  const completedItems  = items.filter((i) => i.completed).length
  const percentComplete = totalItems === 0 ? 0 : Math.round((completedItems / totalItems) * 100)

  // Split into buyer / seller / agent sections (live column: category)
  const buyerItems  = items.filter((i) => BUYER_PHASES.has(i.category?.toLowerCase()))
  const sellerItems = items.filter((i) => SELLER_PHASES.has(i.category?.toLowerCase()) && !AGENT_PHASES.has(i.category?.toLowerCase()))
  const agentItems  = items.filter((i) => AGENT_PHASES.has(i.category?.toLowerCase()))
  // Any items that don't fit neatly into either bucket
  const otherItems  = items.filter(
    (i) => !BUYER_PHASES.has(i.category?.toLowerCase()) &&
           !SELLER_PHASES.has(i.category?.toLowerCase()) &&
           !AGENT_PHASES.has(i.category?.toLowerCase())
  )

  const cdaStatus = cda?.status ?? "not_started"
  const cdaApproved = cdaStatus === "approved"
  const cdaSubmitted = cdaStatus === "submitted" || cdaApproved

  function ChecklistSection({ title, sectionItems }: { title: string; sectionItems: ChecklistItem[] }) {
    if (sectionItems.length === 0) return null
    const done = sectionItems.filter((i) => i.completed).length
    return (
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{title}</CardTitle>
            <span className="text-xs text-muted-foreground">
              {done}/{sectionItems.length}
            </span>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <ul className="divide-y">
            {sectionItems
              .sort((a, b) => {
                if (a.completed === b.completed) return 0
                return a.completed ? 1 : -1
              })
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
                    <p className={`text-sm leading-snug ${item.completed ? "line-through text-muted-foreground" : "font-medium"}`}>
                      {item.item_name}
                    </p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <OwnerBadge owner={ownerFromNotes(item.notes)} />
                      {dueFromNotes(item.notes) && !item.completed && (
                        <span className="text-[10px] text-muted-foreground">
                          Due {new Date(dueFromNotes(item.notes) as string).toLocaleDateString()}
                        </span>
                      )}
                      {item.completed && item.completed_at && (
                        <span className="text-[10px] text-emerald-600">
                          ✓ {new Date(item.completed_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
          </ul>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Readiness header */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Closing readiness
            </span>
            <Badge variant="outline" className="text-xs">
              <Link href={`/dashboard/transactions/${transaction.id}`} className="flex items-center gap-1">
                Open transaction <ExternalLink className="h-3 w-3 ml-0.5" />
              </Link>
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-muted-foreground">
                  {completedItems} / {totalItems} items complete
                </span>
                {transaction.close_date && (
                  <span className="text-muted-foreground">
                    Closes {new Date(transaction.close_date).toLocaleDateString()}
                  </span>
                )}
              </div>
              <Progress value={percentComplete} className="h-2" />
            </div>
            <span className="text-2xl font-bold tabular-nums">{percentComplete}%</span>
          </div>

          {summary?.ai_summary && (
            <p className="text-xs text-muted-foreground italic border-l-2 pl-2">{summary.ai_summary}</p>
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

      {/* CDA status — hard gate for agent payment */}
      <Card className={cdaApproved ? "border-emerald-300" : cdaSubmitted ? "border-amber-300" : "border-red-200"}>
        <CardContent className="px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className={`h-4 w-4 shrink-0 ${cdaApproved ? "text-emerald-600" : cdaSubmitted ? "text-amber-600" : "text-red-500"}`} />
            <div>
              <p className="text-sm font-medium">Commission Disbursement Authorization (CDA)</p>
              <p className="text-xs text-muted-foreground">
                {cdaApproved
                  ? "Approved — agent can be paid at closing"
                  : cdaSubmitted
                  ? "Submitted to compliance — awaiting approval"
                  : "Not yet submitted — agent cannot be paid without CDA approval"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="outline"
              className={
                cdaApproved
                  ? "text-emerald-700 border-emerald-300 bg-emerald-50"
                  : cdaSubmitted
                  ? "text-amber-700 border-amber-300 bg-amber-50"
                  : "text-red-700 border-red-300 bg-red-50"
              }
            >
              {cdaApproved ? "Approved" : cdaSubmitted ? "Pending" : "Not Started"}
            </Badge>
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
              <Link href={`/dashboard/transactions/${transaction.id}/cda`}>
                CDA Workflow <ExternalLink className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </div>
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
        <>
          {/* Show buyer checklist if contact is buyer or both */}
          {(contactRole === "buyer" || contactRole === "both") && (
            <ChecklistSection title="Buyer Checklist" sectionItems={buyerItems} />
          )}

          {/* Show seller checklist if contact is seller or both */}
          {(contactRole === "seller" || contactRole === "both") && (
            <ChecklistSection title="Seller Checklist" sectionItems={sellerItems} />
          )}

          {/* Agent responsibilities (always shown) */}
          <ChecklistSection title="Agent Responsibilities" sectionItems={agentItems} />

          {/* Other items */}
          <ChecklistSection title="Additional Items" sectionItems={otherItems} />
        </>
      )}
    </div>
  )
}
