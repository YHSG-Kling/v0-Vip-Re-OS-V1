"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, CheckCircle, XCircle, Clock, MessageSquare } from "lucide-react"
import { toast } from "sonner"

interface ApprovalItem {
  id: string
  type: string
  agent_id: string
  status: string
  priority: "high" | "medium" | "standard"
  content: string
  created_at: string
  approved_by?: string
  approved_at?: string
  notes?: string
  updated_at: string
  /** "deals" = offer responses — rendered in their own section, never among
   *  marketing content (lib/kernel/approval-queue-aggregator.ts). */
  section?: "deals"
  /** Action lanes. Offers carry ["approve","reject","counter"]. */
  actions?: Array<"approve" | "reject" | "counter">
  /** WHY THIS WAS FLAGGED — the content guardian's findings, decoded from
   *  approval_items.review_notes by the aggregator. Absent on sources that carry
   *  no review record. */
  review?: {
    violations: Array<{ phrase: string; severity: string | null; fix: string | null; reference: string | null }>
    excerpt: string | null
    note: string | null
  }
  /** Offer-decision metadata for the counter dialog prefill. */
  deal?: {
    offer_id: string
    offer_price: number | null
    listing_address: string | null
    buyer_name: string | null
    round: number
    response_deadline: string | null
  }
}

interface GroupedItems {
  high: ApprovalItem[]
  medium: ApprovalItem[]
  standard: ApprovalItem[]
}

const priorityConfig = {
  high: { icon: "🔥", label: "High Priority", color: "text-destructive" },
  medium: { icon: "🟡", label: "Medium Priority", color: "text-yellow-600 dark:text-yellow-500" },
  standard: { icon: "⚪", label: "Standard", color: "text-muted-foreground" },
}

// Type badge per unified-queue source (lib/kernel/approval-queue-aggregator.ts
// ApprovalSource). Unknown types fall back to the raw value.
const typeConfig: Record<string, { icon: string; label: string }> = {
  newsletter: { icon: "📧", label: "Newsletter" },
  email: { icon: "✉️", label: "Email Campaign" },
  ad_creative: { icon: "📣", label: "Ad Creative" },
  video_snippet: { icon: "🎬", label: "Video Snippet" },
  blog: { icon: "📝", label: "Blog Post" },
  podcast: { icon: "🎙️", label: "Podcast Episode" },
  video: { icon: "🎥", label: "Video Render" },
  offer: { icon: "🤝", label: "Offer" },
  property_alert: { icon: "🔔", label: "Property Alert" },
  legacy: { icon: "✅", label: "Approval" },
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [loading, setLoading] = useState(true)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  // Offer dialogs — counter terms + reject-with-reason (deal cards only)
  const [counterItem, setCounterItem] = useState<ApprovalItem | null>(null)
  const [rejectItem, setRejectItem] = useState<ApprovalItem | null>(null)

  useEffect(() => {
    fetchPendingApprovals()
  }, [])

  async function fetchPendingApprovals() {
    setLoading(true)
    try {
      const response = await fetch("/api/approvals/pending")
      const data = await response.json()

      if (response.ok) {
        setItems(data.items || [])
      } else {
        toast.error("Failed to load approvals")
      }
    } catch (error) {
      console.error("[v0] Error fetching approvals:", error)
      toast.error("Error loading approvals")
    } finally {
      setLoading(false)
    }
  }

  function markProcessing(id: string, on: boolean) {
    setProcessingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function handleApprove(item: ApprovalItem) {
    markProcessing(item.id, true)

    try {
      const response = await fetch("/api/approvals/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          agent_id: item.agent_id,
          notes: `Approved ${item.type}`,
        }),
      })

      if (response.ok) {
        setItems((prev) => prev.filter((i) => i.id !== item.id))
        toast.success(item.type === "offer" ? "Offer accepted" : "Item approved successfully")
      } else {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error ?? "Failed to approve item")
      }
    } catch (error) {
      console.error("[v0] Error approving item:", error)
      toast.error("Error approving item")
    } finally {
      markProcessing(item.id, false)
    }
  }

  async function handleReject(item: ApprovalItem, reason?: string) {
    markProcessing(item.id, true)

    try {
      const response = await fetch("/api/approvals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          agent_id: item.agent_id,
          reason: reason?.trim() || `Rejected ${item.type}`,
        }),
      })

      if (response.ok) {
        setItems((prev) => prev.filter((i) => i.id !== item.id))
        toast.success(item.type === "offer" ? "Offer declined" : "Item rejected successfully")
      } else {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error ?? "Failed to reject item")
      }
    } catch (error) {
      console.error("[v0] Error rejecting item:", error)
      toast.error("Error rejecting item")
    } finally {
      markProcessing(item.id, false)
    }
  }

  async function handleCounter(
    item: ApprovalItem,
    terms: { counterPrice: number; closingDate?: string; notes?: string },
  ): Promise<boolean> {
    markProcessing(item.id, true)

    try {
      const response = await fetch("/api/approvals/counter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          counterPrice: terms.counterPrice,
          closingDate: terms.closingDate,
          notes: terms.notes,
        }),
      })

      if (response.ok) {
        setItems((prev) => prev.filter((i) => i.id !== item.id))
        toast.success("Counter offer sent")
        return true
      }
      const data = await response.json().catch(() => ({}))
      toast.error(data.error ?? "Failed to send counter")
      return false
    } catch (error) {
      console.error("[v0] Error countering offer:", error)
      toast.error("Error sending counter")
      return false
    } finally {
      markProcessing(item.id, false)
    }
  }

  function groupByPriority(items: ApprovalItem[]): GroupedItems {
    return items.reduce(
      (acc, item) => {
        acc[item.priority].push(item)
        return acc
      },
      { high: [], medium: [], standard: [] } as GroupedItems
    )
  }

  function formatTimeAgo(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)

    if (diffMins < 1) return "just now"
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    return `${diffDays}d ago`
  }

  // Offers are DEAL DECISIONS — their own section with the full accept /
  // reject / counter response set, never mixed into the marketing feed.
  const dealItems = items.filter((i) => i.section === "deals" || i.type === "offer")
  const contentItems = items.filter((i) => !(i.section === "deals" || i.type === "offer"))
  const groupedItems = groupByPriority(contentItems)
  const totalItems = items.length

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-3 text-muted-foreground">Loading approvals...</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Approvals</h1>
            <p className="text-sm text-muted-foreground mt-1">Review and approve pending items</p>
          </div>
          {totalItems > 0 && (
            <Badge variant="secondary" className="px-3 py-1.5">
              <Clock className="h-3.5 w-3.5 mr-1.5" />
              {totalItems} pending
            </Badge>
          )}
        </div>

        {totalItems === 0 ? (
          <Card>
            <CardContent className="py-16 text-center">
              <CheckCircle className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">All caught up!</h3>
              <p className="text-sm text-muted-foreground">No items waiting for approval</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Deals — offer responses (accept / counter / reject) */}
            {dealItems.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🤝</span>
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Deals — offer responses</h2>
                    <p className="text-xs text-muted-foreground">
                      Offers received on your listings. Accept, counter with new terms, or decline.
                    </p>
                  </div>
                  <Badge variant="destructive" className="ml-auto">
                    {dealItems.length}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {dealItems.map((item) => (
                    <DealDecisionCard
                      key={item.id}
                      item={item}
                      isProcessing={processingIds.has(item.id)}
                      onAccept={() => handleApprove(item)}
                      onCounter={() => setCounterItem(item)}
                      onReject={() => setRejectItem(item)}
                      formatTimeAgo={formatTimeAgo}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* High Priority Items */}
            {groupedItems.high.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{priorityConfig.high.icon}</span>
                  <h2 className="text-lg font-semibold text-foreground">{priorityConfig.high.label}</h2>
                  <Badge variant="destructive" className="ml-auto">
                    {groupedItems.high.length}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {groupedItems.high.map((item) => (
                    <ApprovalItemCard
                      key={item.id}
                      item={item}
                      isProcessing={processingIds.has(item.id)}
                      onApprove={() => handleApprove(item)}
                      onReject={() => handleReject(item)}
                      formatTimeAgo={formatTimeAgo}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Medium Priority Items */}
            {groupedItems.medium.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{priorityConfig.medium.icon}</span>
                  <h2 className="text-lg font-semibold text-foreground">{priorityConfig.medium.label}</h2>
                  <Badge variant="secondary" className="ml-auto">
                    {groupedItems.medium.length}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {groupedItems.medium.map((item) => (
                    <ApprovalItemCard
                      key={item.id}
                      item={item}
                      isProcessing={processingIds.has(item.id)}
                      onApprove={() => handleApprove(item)}
                      onReject={() => handleReject(item)}
                      formatTimeAgo={formatTimeAgo}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Standard Priority Items */}
            {groupedItems.standard.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{priorityConfig.standard.icon}</span>
                  <h2 className="text-lg font-semibold text-foreground">{priorityConfig.standard.label}</h2>
                  <Badge variant="outline" className="ml-auto">
                    {groupedItems.standard.length}
                  </Badge>
                </div>
                <div className="space-y-3">
                  {groupedItems.standard.map((item) => (
                    <ApprovalItemCard
                      key={item.id}
                      item={item}
                      isProcessing={processingIds.has(item.id)}
                      onApprove={() => handleApprove(item)}
                      onReject={() => handleReject(item)}
                      formatTimeAgo={formatTimeAgo}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Counter dialog — mirrors the /offers counter slide-over idiom
          (price + optional notes/closing date), routed through the kernel
          issueCounterOffer via /api/approvals/counter. */}
      {counterItem && (
        <CounterOfferDialog
          item={counterItem}
          isProcessing={processingIds.has(counterItem.id)}
          onClose={() => setCounterItem(null)}
          onSubmit={async (terms) => {
            const ok = await handleCounter(counterItem, terms)
            if (ok) setCounterItem(null)
          }}
        />
      )}

      {/* Reject dialog — the kernel rejectOffer supports an optional reason
          (stored in offers.notes), so offer declines collect one. */}
      {rejectItem && (
        <RejectOfferDialog
          item={rejectItem}
          isProcessing={processingIds.has(rejectItem.id)}
          onClose={() => setRejectItem(null)}
          onSubmit={async (reason) => {
            await handleReject(rejectItem, reason)
            setRejectItem(null)
          }}
        />
      )}
    </div>
  )
}

function DealDecisionCard({
  item,
  isProcessing,
  onAccept,
  onCounter,
  onReject,
  formatTimeAgo,
}: {
  item: ApprovalItem
  isProcessing: boolean
  onAccept: () => void
  onCounter: () => void
  onReject: () => void
  formatTimeAgo: (date: string) => string
}) {
  const deal = item.deal
  const canCounter = !item.actions || item.actions.includes("counter")
  return (
    <Card className="hover:border-primary transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Badge variant="outline" className="text-xs">
                🤝 Offer
              </Badge>
              {deal && deal.round > 1 && (
                <Badge variant="secondary" className="text-xs">
                  Round {deal.round}
                </Badge>
              )}
              {deal?.response_deadline && (
                <Badge variant="secondary" className="text-xs">
                  Respond by {new Date(deal.response_deadline).toLocaleDateString()}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{formatTimeAgo(item.created_at)}</span>
            </div>
            <p className="text-sm text-foreground leading-relaxed">{item.content}</p>

            {/* THE EVIDENCE THE REVIEWER IS DECIDING ON. The content guardian has always
                written its fair-housing / brand-voice findings and the offending copy into
                approval_items.review_notes; nothing selected the column, so this card asked
                for an approve/reject on flagged content while showing neither. */}
            {(item.review?.violations.length ?? 0) > 0 && (
              <div className="mt-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 space-y-2">
                <p className="text-xs font-semibold text-amber-900">
                  Compliance findings — read before approving
                </p>
                <ul className="space-y-1.5">
                  {item.review!.violations.map((v, i) => (
                    <li key={i} className="text-xs text-amber-900">
                      <span className="font-medium">
                        {v.severity ? `[${v.severity}] ` : ""}{v.phrase}
                      </span>
                      {v.fix && <span className="block text-amber-800">Fix: {v.fix}</span>}
                      {v.reference && <span className="block text-amber-700">{v.reference}</span>}
                    </li>
                  ))}
                </ul>
                {item.review!.excerpt && (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    “{item.review!.excerpt}”
                  </p>
                )}
              </div>
            )}
            {/* A note that is not the guardian's structured record is shown as written,
                never silently dropped. */}
            {item.review?.note && (
              <p className="mt-2 text-xs text-muted-foreground break-words">
                Review note: {item.review.note}
              </p>
            )}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <Button
              size="sm"
              variant="default"
              onClick={onAccept}
              disabled={isProcessing}
              className="min-w-[80px]"
            >
              {isProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-1.5" />
                  Accept
                </>
              )}
            </Button>
            {canCounter && (
              <Button
                size="sm"
                variant="outline"
                onClick={onCounter}
                disabled={isProcessing}
                className="min-w-[80px] bg-transparent"
              >
                <MessageSquare className="h-4 w-4 mr-1.5" />
                Counter
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onReject}
              disabled={isProcessing}
              className="min-w-[80px] bg-transparent text-destructive hover:text-destructive border-destructive/40 hover:border-destructive"
            >
              <XCircle className="h-4 w-4 mr-1.5" />
              Reject
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CounterOfferDialog({
  item,
  isProcessing,
  onClose,
  onSubmit,
}: {
  item: ApprovalItem
  isProcessing: boolean
  onClose: () => void
  onSubmit: (terms: { counterPrice: number; closingDate?: string; notes?: string }) => void
}) {
  const deal = item.deal
  const [price, setPrice] = useState(deal?.offer_price ? String(deal.offer_price) : "")
  const [closingDate, setClosingDate] = useState("")
  const [notes, setNotes] = useState("")

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const parsed = parseFloat(price.replace(/[^0-9.]/g, ""))
    if (isNaN(parsed) || parsed <= 0) {
      toast.error("Enter a valid counter price")
      return
    }
    onSubmit({
      counterPrice: parsed,
      closingDate: closingDate || undefined,
      notes: notes.trim() || undefined,
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send counter offer</DialogTitle>
          <DialogDescription>
            {deal?.buyer_name ? `Countering ${deal.buyer_name}'s offer` : "Countering the offer"}
            {deal?.listing_address ? ` on ${deal.listing_address}` : ""} &middot; Round{" "}
            {(deal?.round ?? 1) + 1}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approvals-counter-price">Counter price ($)</Label>
            <Input
              id="approvals-counter-price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="e.g. 525000"
              required
            />
            {deal?.offer_price != null && (
              <p className="text-xs text-muted-foreground">
                Their offer: ${deal.offer_price.toLocaleString()}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approvals-counter-closing">Closing date (optional)</Label>
            <Input
              id="approvals-counter-closing"
              type="date"
              value={closingDate}
              onChange={(e) => setClosingDate(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approvals-counter-notes">Notes (optional)</Label>
            <Textarea
              id="approvals-counter-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contingency changes or special terms..."
              rows={3}
            />
          </div>

          <DialogFooter className="gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={isProcessing}>
              Cancel
            </Button>
            <Button type="submit" disabled={isProcessing}>
              {isProcessing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Send counter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RejectOfferDialog({
  item,
  isProcessing,
  onClose,
  onSubmit,
}: {
  item: ApprovalItem
  isProcessing: boolean
  onClose: () => void
  onSubmit: (reason?: string) => void
}) {
  const deal = item.deal
  const [reason, setReason] = useState("")

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Decline offer</DialogTitle>
          <DialogDescription>
            {deal?.buyer_name ? `Declining ${deal.buyer_name}'s offer` : "Declining the offer"}
            {deal?.listing_address ? ` on ${deal.listing_address}` : ""}. The buyer&apos;s side is
            notified.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="approvals-reject-reason">Reason (optional)</Label>
          <Textarea
            id="approvals-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Seller went with a stronger offer..."
            rows={3}
          />
        </div>

        <DialogFooter className="gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={isProcessing}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isProcessing}
            onClick={() => onSubmit(reason.trim() || undefined)}
          >
            {isProcessing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Decline offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApprovalItemCard({
  item,
  isProcessing,
  onApprove,
  onReject,
  formatTimeAgo,
}: {
  item: ApprovalItem
  isProcessing: boolean
  onApprove: () => void
  onReject: () => void
  formatTimeAgo: (date: string) => string
}) {
  return (
    <Card className="hover:border-primary transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-xs">
                {typeConfig[item.type]
                  ? `${typeConfig[item.type].icon} ${typeConfig[item.type].label}`
                  : item.type}
              </Badge>
              <span className="text-xs text-muted-foreground">{formatTimeAgo(item.created_at)}</span>
            </div>
            <p className="text-sm text-foreground line-clamp-2 leading-relaxed">{item.content}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              size="sm"
              variant="default"
              onClick={onApprove}
              disabled={isProcessing}
              className="min-w-[80px]"
            >
              {isProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="h-4 w-4 mr-1.5" />
                  Approve
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onReject}
              disabled={isProcessing}
              className="min-w-[80px] bg-transparent"
            >
              {isProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Reject
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
