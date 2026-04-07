"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  CheckCircle2,
  FileUp,
  Send,
  RefreshCw,
  AlertTriangle,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

interface BatchItem {
  id: string
  label: string
  type: "file" | "milestone" | "document" | "status"
  status: "pending" | "ready" | "completed"
  relatedId?: string
}

interface ExternalBatchActionsPanelProps {
  partnerType: "vendor" | "lender" | "title"
  items: BatchItem[]
  onBatchConfirm?: (ids: string[]) => Promise<{ success: boolean; count: number; error?: string }>
  onBatchUpdate?: (ids: string[], newStatus: string) => Promise<{ success: boolean; count: number; error?: string }>
  onBatchSend?: (ids: string[]) => Promise<{ success: boolean; count: number; error?: string }>
}

export function ExternalBatchActionsPanel({
  partnerType,
  items,
  onBatchConfirm,
  onBatchUpdate,
  onBatchSend,
}: ExternalBatchActionsPanelProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [processing, setProcessing] = useState(false)

  const pendingItems = items.filter((i) => i.status !== "completed")
  const readyItems = items.filter((i) => i.status === "ready")

  // Kernel OS contract: each partner type has domain-specific action labels
  const partnerLabels: Record<typeof partnerType, { confirm: string; send: string; complete: string; title: string }> = {
    vendor: { confirm: "Confirm Jobs", send: "Submit Work Orders", complete: "Mark Completed", title: "Vendor Batch Actions" },
    lender: { confirm: "Confirm Approvals", send: "Send to Underwriting", complete: "Mark Cleared", title: "Lender Batch Actions" },
    title: { confirm: "Confirm Orders", send: "Send to Settlement", complete: "Mark Closed", title: "Title Batch Actions" },
  }
  const labels = partnerLabels[partnerType]

  const toggleItem = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  const toggleAll = () => {
    if (selectedIds.length === pendingItems.length) {
      setSelectedIds([])
    } else {
      setSelectedIds(pendingItems.map((i) => i.id))
    }
  }

  const handleBatchConfirm = async () => {
    if (selectedIds.length === 0 || !onBatchConfirm) return

    setProcessing(true)
    try {
      const result = await onBatchConfirm(selectedIds)
      if (result.success) {
        toast.success(`${result.count} items confirmed`)
        setSelectedIds([])
      } else {
        toast.error(result.error || "Failed to confirm items")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setProcessing(false)
    }
  }

  const handleBatchUpdate = async (newStatus: string) => {
    if (selectedIds.length === 0 || !onBatchUpdate) return

    setProcessing(true)
    try {
      const result = await onBatchUpdate(selectedIds, newStatus)
      if (result.success) {
        toast.success(`${result.count} items updated`)
        setSelectedIds([])
      } else {
        toast.error(result.error || "Failed to update items")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setProcessing(false)
    }
  }

  const handleBatchSend = async () => {
    if (selectedIds.length === 0 || !onBatchSend) return

    setProcessing(true)
    try {
      const result = await onBatchSend(selectedIds)
      if (result.success) {
        toast.success(`${result.count} items sent`)
        setSelectedIds([])
      } else {
        toast.error(result.error || "Failed to send items")
      }
    } catch (error) {
      toast.error("An error occurred while sending")
    } finally {
      setProcessing(false)
    }
  }

  const getTypeIcon = (type: BatchItem["type"]) => {
    switch (type) {
      case "file":
        return <FileUp className="h-4 w-4" />
      case "milestone":
        return <CheckCircle2 className="h-4 w-4" />
      case "document":
        return <FileUp className="h-4 w-4" />
      default:
        return <RefreshCw className="h-4 w-4" />
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {labels.title}
          </CardTitle>
          <div className="flex gap-2">
            {readyItems.length > 0 && (
              <Badge variant="secondary" className="text-xs bg-green-50 text-green-700">
                {readyItems.length} Ready
              </Badge>
            )}
            {pendingItems.length > 0 && (
              <Badge variant="outline" className="text-xs">
                {pendingItems.length} Pending
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {pendingItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-50 text-green-500" />
            <p className="text-sm">Nothing to process</p>
          </div>
        ) : (
          <>
            {/* Select All */}
            <div className="flex items-center justify-between p-2 bg-muted/50 rounded-lg mb-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="select-all"
                  checked={selectedIds.length === pendingItems.length}
                  onCheckedChange={toggleAll}
                />
                <label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
                  Select All ({pendingItems.length})
                </label>
              </div>
              {selectedIds.length > 0 && (
                <Badge className="bg-primary text-primary-foreground">
                  {selectedIds.length} Selected
                </Badge>
              )}
            </div>

            {/* Items List */}
            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {pendingItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                    selectedIds.includes(item.id) ? "bg-primary/10" : "hover:bg-muted/50"
                  }`}
                  onClick={() => toggleItem(item.id)}
                >
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    onCheckedChange={() => toggleItem(item.id)}
                  />
                  <span className="text-muted-foreground">{getTypeIcon(item.type)}</span>
                  <span className="text-sm flex-1">{item.label}</span>
                  <div className="flex items-center gap-1">
                    {item.status === "pending" && (
                      <AlertTriangle className="h-3 w-3 text-yellow-500" aria-label="Awaiting action" />
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        item.status === "ready"
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-yellow-50 text-yellow-700 border-yellow-200"
                      }`}
                    >
                      {item.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>

            {/* Batch Action Buttons */}
            <div className="flex gap-2 mt-4 pt-4 border-t flex-wrap">
              {onBatchConfirm && (
                <Button
                  className="flex-1"
                  onClick={handleBatchConfirm}
                  disabled={selectedIds.length === 0 || processing}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1" />
                  {labels.confirm} ({selectedIds.length})
                </Button>
              )}
              {onBatchSend && (
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={handleBatchSend}
                  disabled={selectedIds.length === 0 || processing}
                >
                  <Send className="h-4 w-4 mr-1" />
                  {labels.send} ({selectedIds.length})
                </Button>
              )}
              {onBatchUpdate && (
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => handleBatchUpdate("completed")}
                  disabled={selectedIds.length === 0 || processing}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {labels.complete}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
