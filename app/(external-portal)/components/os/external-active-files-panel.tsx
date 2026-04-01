"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText, Calendar, Eye, ChevronRight } from "lucide-react"
import Link from "next/link"

interface ActiveFile {
  id: string
  transactionId: string
  propertyAddress: string
  clientName?: string
  status: string
  closeDate?: string
  urgency?: "high" | "medium" | "low"
  actionRequired?: boolean
  lastActivity?: string
}

interface ExternalActiveFilesPanelProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  files: ActiveFile[]
}

export function ExternalActiveFilesPanel({
  partnerType,
  partnerId,
  files,
}: ExternalActiveFilesPanelProps) {
  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "active":
      case "in_progress":
        return "bg-blue-100 text-blue-700 border-blue-200"
      case "pending":
      case "awaiting_docs":
        return "bg-yellow-100 text-yellow-700 border-yellow-200"
      case "completed":
      case "closed":
        return "bg-green-100 text-green-700 border-green-200"
      case "urgent":
      case "attention_needed":
        return "bg-red-100 text-red-700 border-red-200"
      default:
        return "bg-gray-100 text-gray-700 border-gray-200"
    }
  }

  const getUrgencyIndicator = (urgency?: string) => {
    if (urgency === "high") return "border-l-4 border-l-red-500"
    if (urgency === "medium") return "border-l-4 border-l-orange-500"
    return ""
  }

  const getDetailLink = (file: ActiveFile) => {
    switch (partnerType) {
      case "vendor":
        return `/vendor/jobs/${file.id}`
      case "lender":
        return `/portal/lender/${file.transactionId}`
      case "title":
        return `/portal/title/${file.transactionId}`
      default:
        return "#"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Active Files ({files.length})
          </CardTitle>
          {files.filter((f) => f.actionRequired).length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {files.filter((f) => f.actionRequired).length} Need Action
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No active files</p>
          </div>
        ) : (
          <div className="space-y-2">
            {files.slice(0, 6).map((file) => (
              <div
                key={file.id}
                className={`p-3 bg-muted/50 rounded-lg hover:bg-muted transition-colors ${getUrgencyIndicator(file.urgency)}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{file.propertyAddress}</p>
                      {file.actionRequired && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 bg-orange-50 text-orange-700 border-orange-200">
                          Action
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      {file.clientName && <span>{file.clientName}</span>}
                      {file.closeDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(file.closeDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={`text-xs ${getStatusColor(file.status)}`}>
                      {file.status.replace(/_/g, " ")}
                    </Badge>
                    <Link href={getDetailLink(file)}>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            ))}
            {files.length > 6 && (
              <Link
                href={partnerType === "vendor" ? "/vendor/jobs" : partnerType === "lender" ? "/lender/pipeline" : "/title/orders"}
              >
                <Button variant="ghost" size="sm" className="w-full mt-2">
                  View All {files.length} Files
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
