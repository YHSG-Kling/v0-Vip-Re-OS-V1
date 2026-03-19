"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ClipboardList, CheckCircle2, Clock, AlertCircle, Loader2 } from "lucide-react"
import { updateClosingPrepItem } from "@/app/actions/title-portal"
import { useRouter } from "next/navigation"

interface ClosingPrep {
  id: string
  transaction_id: string
  status?: string
  estimated_close_date?: string
  checklist?: Record<string, ChecklistItem>
}

interface ChecklistItem {
  status: "pending" | "in_progress" | "completed"
  updated_at?: string
  updated_by?: string
  notes?: string
}

// Default closing checklist items
const DEFAULT_CHECKLIST_ITEMS = [
  { key: "title_search_complete", label: "Title Search Complete", responsible: "Title Company" },
  { key: "title_commitment_issued", label: "Title Commitment Issued", responsible: "Title Company" },
  { key: "earnest_money_received", label: "Earnest Money Received", responsible: "Escrow" },
  { key: "lender_docs_received", label: "Lender Documents Received", responsible: "Lender" },
  { key: "survey_complete", label: "Survey Complete (if required)", responsible: "Surveyor" },
  { key: "hoa_docs_received", label: "HOA Documents Received (if applicable)", responsible: "HOA" },
  { key: "final_walkthrough_scheduled", label: "Final Walkthrough Scheduled", responsible: "Agent" },
  { key: "closing_disclosure_approved", label: "Closing Disclosure Approved", responsible: "Buyer/Lender" },
  { key: "wire_instructions_sent", label: "Wire Instructions Sent", responsible: "Title Company" },
  { key: "closing_scheduled", label: "Closing Scheduled", responsible: "Title Company" },
] as const

const STATUS_CONFIG = {
  pending: { icon: Clock, color: "text-muted-foreground", bg: "bg-slate-100" },
  in_progress: { icon: Clock, color: "text-blue-600", bg: "bg-blue-100" },
  completed: { icon: CheckCircle2, color: "text-green-600", bg: "bg-green-100" },
}

export function ClosingChecklist({
  transactionId,
  titleUserId,
  closingPrep,
}: {
  transactionId: string
  titleUserId: string
  closingPrep?: ClosingPrep | null
}) {
  const router = useRouter()
  const [updatingItem, setUpdatingItem] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checklist = closingPrep?.checklist || {}

  const handleStatusChange = async (itemKey: string, newStatus: "pending" | "in_progress" | "completed") => {
    setUpdatingItem(itemKey)
    setError(null)

    try {
      await updateClosingPrepItem({
        transactionId,
        titleUserId,
        itemKey,
        status: newStatus,
      })
      router.refresh()
    } catch (err: any) {
      setError(err.message || "Failed to update item")
    } finally {
      setUpdatingItem(null)
    }
  }

  const completedCount = DEFAULT_CHECKLIST_ITEMS.filter(
    (item) => checklist[item.key]?.status === "completed"
  ).length
  const totalCount = DEFAULT_CHECKLIST_ITEMS.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              Closing Coordination Checklist
            </CardTitle>
            <CardDescription>Track closing requirements and responsibilities</CardDescription>
          </div>
          <Badge variant="outline" className="text-sm">
            {completedCount} / {totalCount} Complete ({progressPercent}%)
          </Badge>
        </div>
        {/* Progress Bar */}
        <div className="w-full bg-muted rounded-full h-2 mt-2">
          <div
            className="bg-green-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {DEFAULT_CHECKLIST_ITEMS.map((item) => {
            const itemData = checklist[item.key] || { status: "pending" }
            const config = STATUS_CONFIG[itemData.status] || STATUS_CONFIG.pending
            const StatusIcon = config.icon
            const isUpdating = updatingItem === item.key

            return (
              <div
                key={item.key}
                className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                  itemData.status === "completed" ? "bg-green-50/50 border-green-200" : ""
                }`}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div
                    className={`p-1.5 rounded-full ${config.bg}`}
                    onClick={() => {
                      if (!isUpdating && itemData.status !== "completed") {
                        handleStatusChange(item.key, "completed")
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    style={{ cursor: isUpdating ? "wait" : "pointer" }}
                  >
                    {isUpdating ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <StatusIcon className={`h-4 w-4 ${config.color}`} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`font-medium text-sm ${
                        itemData.status === "completed" ? "line-through text-muted-foreground" : ""
                      }`}
                    >
                      {item.label}
                    </p>
                    <p className="text-xs text-muted-foreground">{item.responsible}</p>
                  </div>
                </div>

                <Select
                  value={itemData.status}
                  onValueChange={(value) =>
                    handleStatusChange(item.key, value as "pending" | "in_progress" | "completed")
                  }
                  disabled={isUpdating}
                >
                  <SelectTrigger className="w-[130px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
