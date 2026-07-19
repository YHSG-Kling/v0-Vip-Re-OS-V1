"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react"
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

  async function handleApprove(item: ApprovalItem) {
    setProcessingIds((prev) => new Set(prev).add(item.id))

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
        toast.success("Item approved successfully")
      } else {
        toast.error("Failed to approve item")
      }
    } catch (error) {
      console.error("[v0] Error approving item:", error)
      toast.error("Error approving item")
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  async function handleReject(item: ApprovalItem) {
    setProcessingIds((prev) => new Set(prev).add(item.id))

    try {
      const response = await fetch("/api/approvals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          agent_id: item.agent_id,
          reason: `Rejected ${item.type}`,
        }),
      })

      if (response.ok) {
        setItems((prev) => prev.filter((i) => i.id !== item.id))
        toast.success("Item rejected successfully")
      } else {
        toast.error("Failed to reject item")
      }
    } catch (error) {
      console.error("[v0] Error rejecting item:", error)
      toast.error("Error rejecting item")
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
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

  const groupedItems = groupByPriority(items)
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
    </div>
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
