"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  FileText,
  Upload,
  CheckCircle2,
  Clock,
  AlertCircle,
  Download,
  Eye,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

interface DocumentStatus {
  id: string
  name: string
  type: string
  status: "pending" | "uploaded" | "approved" | "rejected" | "expired"
  required: boolean
  dueDate?: string
  uploadedAt?: string
  fileUrl?: string
  rejectionReason?: string
}

interface ExternalDocStatusPanelProps {
  partnerType: "vendor" | "lender" | "title"
  partnerId: string
  transactionId?: string
  documents: DocumentStatus[]
  onUpload?: (docType: string, context: { partnerId: string; partnerType: string }) => void
  onView?: (docId: string, context: { partnerId: string; partnerType: string }) => void
  onDownload?: (docId: string, context: { partnerId: string; partnerType: string }) => Promise<{ success: boolean; error?: string }>
}

export function ExternalDocStatusPanel({
  partnerType,
  partnerId,
  transactionId,
  documents,
  onUpload,
  onView,
  onDownload,
}: ExternalDocStatusPanelProps) {
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)

  // Kernel OS contract: scoped to specific transaction per partner
  // Filter documents to only show those for this transaction if transactionId is provided
  const scopedDocuments = transactionId 
    ? documents.filter(doc => (doc as any).transactionId === transactionId)
    : documents

  // Kernel OS contract: partnerId identifies which partner these documents belong to
  // Used for access control validation and audit logging per Kernel OS architecture
  console.log("[v0] ExternalDocStatusPanel scoped to partner:", { partnerId, partnerType, docCount: documents.length })

  const handleDownload = async (doc: DocumentStatus) => {
    if (!onDownload) return
    
    setDownloading(doc.id)
    try {
      // Pass partnerId context to backend for access control
      const result = await onDownload(doc.id, {
        partnerId,
        partnerType,
      })
      if (result.success) {
        toast.success("Document downloaded")
      } else {
        toast.error(result.error || "Failed to download document")
      }
    } catch (error) {
      console.error("[v0] Error downloading document:", error)
      toast.error("An error occurred")
    } finally {
      setDownloading(null)
    }
  }

  const getStatusIcon = (status: DocumentStatus["status"]) => {
    switch (status) {
      case "approved":
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case "uploaded":
        return <Clock className="h-4 w-4 text-blue-500" />
      case "rejected":
        return <AlertCircle className="h-4 w-4 text-red-500" />
      case "expired":
        return <AlertCircle className="h-4 w-4 text-orange-500" />
      default:
        return <FileText className="h-4 w-4 text-gray-400" />
    }
  }

  const getStatusBadge = (status: DocumentStatus["status"]) => {
    switch (status) {
      case "approved":
        return <Badge className="bg-green-100 text-green-700 border-green-200">Approved</Badge>
      case "uploaded":
        return <Badge className="bg-blue-100 text-blue-700 border-blue-200">Uploaded</Badge>
      case "rejected":
        return <Badge className="bg-red-100 text-red-700 border-red-200">Rejected</Badge>
      case "expired":
        return <Badge className="bg-orange-100 text-orange-700 border-orange-200">Expired</Badge>
      default:
        return <Badge className="bg-gray-100 text-gray-700 border-gray-200">Pending</Badge>
    }
  }

  const completedCount = documents.filter((d) => d.status === "approved" || d.status === "uploaded").length
  const requiredCount = documents.filter((d) => d.required).length
  const completedRequired = documents.filter((d) => d.required && (d.status === "approved" || d.status === "uploaded")).length
  const progressPercent = requiredCount > 0 ? Math.round((completedRequired / requiredCount) * 100) : 100

  // Partner-specific document title per Kernel OS contract
  const getDocumentTitle = () => {
    switch (partnerType) {
      case "vendor":
        return "Required Vendor Documents"
      case "lender":
        return "Required Lender Documents"
      case "title":
        return "Required Title Company Documents"
      default:
        return "Document Status"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {getDocumentTitle()}
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {completedCount}/{documents.length} Complete
          </span>
        </div>
        <div className="mt-2">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground mt-1">
            {progressPercent}% of required documents uploaded
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No documents required</p>
          </div>
        ) : (
          <div className="space-y-2">
            {scopedDocuments.map((doc) => (
              <div
                key={doc.id}
                className="p-3 bg-muted/50 rounded-lg"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {getStatusIcon(doc.status)}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {doc.name}
                        {doc.required && <span className="text-red-500 ml-1">*</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{doc.type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {getStatusBadge(doc.status)}
                    {doc.status === "pending" && onUpload && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => onUpload(doc.type, { partnerId, partnerType })}
                      >
                        <Upload className="h-3 w-3 mr-1" />
                        Upload
                      </Button>
                    )}
                    {doc.fileUrl && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => onView?.(doc.id, { partnerId, partnerType })}
                          title="View document"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {onDownload && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleDownload(doc)}
                            disabled={downloading === doc.id}
                            title="Download document"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {doc.status === "rejected" && doc.rejectionReason && (
                  <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-700 border border-red-100">
                    Rejection reason: {doc.rejectionReason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
