"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, CheckCircle, XCircle, Clock, ArrowLeft, FileCheck, Users, Building2 } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"

interface ApprovalItem {
  id: string
  type: string
  agent_id: string
  agent_name?: string
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
  high: { label: "Urgent", color: "bg-destructive text-destructive-foreground" },
  medium: { label: "Priority", color: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400" },
  standard: { label: "Standard", color: "bg-muted text-muted-foreground" },
}

export default function AdminApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [loading, setLoading] = useState(true)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState("all")

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
    } catch {
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
    } catch {
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
        toast.success("Item rejected")
      } else {
        toast.error("Failed to reject item")
      }
    } catch {
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

  const filteredItems = activeTab === "all" 
    ? items 
    : items.filter(item => item.type.toLowerCase().includes(activeTab))
  
  const groupedItems = groupByPriority(filteredItems)
  const totalItems = items.length
  const urgentCount = items.filter(i => i.priority === "high").length

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-3 text-muted-foreground">Loading approvals...</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4 mb-4">
            <Link href="/dashboard/admin">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Admin Dashboard
              </Button>
            </Link>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Admin Approvals</h1>
              <p className="text-sm text-muted-foreground mt-1">Review and approve pending items across your brokerage</p>
            </div>
            <div className="flex items-center gap-3">
              {urgentCount > 0 && (
                <Badge variant="destructive" className="px-3 py-1.5">
                  {urgentCount} urgent
                </Badge>
              )}
              <Badge variant="secondary" className="px-3 py-1.5">
                <Clock className="h-3.5 w-3.5 mr-1.5" />
                {totalItems} pending
              </Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <FileCheck className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{items.filter(i => i.type.includes("content") || i.type.includes("listing")).length}</p>
                <p className="text-xs text-muted-foreground">Content/Listings</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Users className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{items.filter(i => i.type.includes("agent") || i.type.includes("profile")).length}</p>
                <p className="text-xs text-muted-foreground">Agent Requests</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{items.filter(i => i.type.includes("transaction") || i.type.includes("compliance")).length}</p>
                <p className="text-xs text-muted-foreground">Compliance Items</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-6">
          <TabsList>
            <TabsTrigger value="all">All ({totalItems})</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="agent">Agents</TabsTrigger>
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
          </TabsList>
        </Tabs>

        {filteredItems.length === 0 ? (
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
                  <Badge className={priorityConfig.high.color}>{priorityConfig.high.label}</Badge>
                  <span className="text-sm text-muted-foreground">{groupedItems.high.length} items</span>
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
                  <Badge className={priorityConfig.medium.color}>{priorityConfig.medium.label}</Badge>
                  <span className="text-sm text-muted-foreground">{groupedItems.medium.length} items</span>
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
                  <Badge className={priorityConfig.standard.color}>{priorityConfig.standard.label}</Badge>
                  <span className="text-sm text-muted-foreground">{groupedItems.standard.length} items</span>
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
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-xs">
                {item.type}
              </Badge>
              {item.agent_name && (
                <span className="text-xs text-muted-foreground">by {item.agent_name}</span>
              )}
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
              className="min-w-[80px]"
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
