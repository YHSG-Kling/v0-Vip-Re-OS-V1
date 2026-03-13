"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  FileText,
  Download,
  Eye,
  PenTool,
  Upload,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  Info,
  ChevronRight,
  Folder,
  ImageIcon,
  Search,
} from "lucide-react"
import Link from "next/link"
import { DocumentUploadDialog } from "@/components/portal/DocumentUploadDialog"

interface ClientDocument {
  id: string
  name: string | null
  document_type: string | null
  file_url: string | null
  uploaded_at: string | null
  uploaded_by: string | null
  review_status: string | null
  notes: string | null
}

interface TransactionDocument {
  id: string
  name: string | null
  document_type: string | null
  file_url: string | null
  uploaded_at: string | null
  required: boolean | null
  status: string | null
  transaction_id: string
}

interface ChecklistItem {
  id: string
  item_name: string | null
  required: boolean | null
  status: string | null
  due_date: string | null
  notes: string | null
  transaction_id: string
}

interface DocumentsClientProps {
  contactId: string
  clientDocuments: ClientDocument[]
  transactionDocuments: TransactionDocument[]
  documentChecklist: ChecklistItem[]
}

export function DocumentsClient({
  contactId,
  clientDocuments,
  transactionDocuments,
  documentChecklist,
}: DocumentsClientProps) {
  // Combine all documents for display
  const allDocuments = [
    ...clientDocuments.map(d => ({
      id: d.id,
      name: d.name || "Untitled Document",
      document_type: d.document_type,
      file_url: d.file_url,
      uploaded_at: d.uploaded_at,
      status: d.review_status,
      source: "client" as const,
    })),
    ...transactionDocuments.map(d => ({
      id: d.id,
      name: d.name || "Untitled Document",
      document_type: d.document_type,
      file_url: d.file_url,
      uploaded_at: d.uploaded_at,
      status: d.status,
      source: "transaction" as const,
    })),
  ]

  // Calculate folder counts by document_type
  const folders = [
    { name: "All Files", path: "all", document_count: allDocuments.length },
    {
      name: "Contracts",
      path: "contracts",
      document_count: allDocuments.filter(d =>
        d.document_type?.toLowerCase().includes("contract") ||
        d.document_type?.toLowerCase().includes("agreement")
      ).length,
    },
    {
      name: "Disclosures",
      path: "disclosures",
      document_count: allDocuments.filter(d =>
        d.document_type?.toLowerCase().includes("disclosure")
      ).length,
    },
    {
      name: "Financial",
      path: "financial",
      document_count: allDocuments.filter(d =>
        d.document_type?.toLowerCase().includes("financial") ||
        d.document_type?.toLowerCase().includes("bank") ||
        d.document_type?.toLowerCase().includes("proof")
      ).length,
    },
    {
      name: "Inspections",
      path: "inspections",
      document_count: allDocuments.filter(d =>
        d.document_type?.toLowerCase().includes("inspection")
      ).length,
    },
    {
      name: "Other",
      path: "other",
      document_count: allDocuments.filter(d =>
        !d.document_type ||
        (!d.document_type.toLowerCase().includes("contract") &&
          !d.document_type.toLowerCase().includes("agreement") &&
          !d.document_type.toLowerCase().includes("disclosure") &&
          !d.document_type.toLowerCase().includes("financial") &&
          !d.document_type.toLowerCase().includes("bank") &&
          !d.document_type.toLowerCase().includes("proof") &&
          !d.document_type.toLowerCase().includes("inspection"))
      ).length,
    },
  ]

  const isNew = (uploadedAt: string | null) => {
    if (!uploadedAt) return false
    const hoursSince = (Date.now() - new Date(uploadedAt).getTime()) / (1000 * 60 * 60)
    return hoursSince < 48
  }

  const getStatusIcon = (status: string | null) => {
    switch (status) {
      case "approved":
      case "verified":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "flagged":
      case "rejected":
        return <AlertCircle className="h-4 w-4 text-orange-600" />
      case "pending":
      case "processing":
        return <Clock className="h-4 w-4 text-blue-600 animate-pulse" />
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getStatusColor = (status: string | null) => {
    switch (status) {
      case "approved":
      case "verified":
        return "bg-green-100 text-green-800"
      case "flagged":
      case "rejected":
        return "bg-orange-100 text-orange-800"
      case "pending":
      case "processing":
        return "bg-blue-100 text-blue-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  // Calculate progress from checklist
  const requiredItems = documentChecklist.filter(item => item.required)
  const completedItems = requiredItems.filter(item => item.status === "completed" || item.status === "approved")
  const progressPercent = requiredItems.length > 0 
    ? Math.round((completedItems.length / requiredItems.length) * 100) 
    : 0

  // Pending items from checklist
  const pendingItems = documentChecklist.filter(item => item.status === "pending" || item.status === "missing")

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">My Documents</h2>
          <p className="text-muted-foreground">View, understand, and sign your transaction documents</p>
        </div>
        <DocumentUploadDialog contactId={contactId} />
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Document Progress */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Documents Complete</span>
              <span className="text-2xl font-bold">{progressPercent}%</span>
            </div>
            <Progress value={progressPercent} className="h-2" />
            <p className="text-xs text-muted-foreground mt-2">
              {completedItems.length} of {requiredItems.length} required documents uploaded
            </p>
          </CardContent>
        </Card>

        {/* Pending Items */}
        <Card className={pendingItems.length > 0 ? "border-orange-200 bg-orange-50" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Pending Items</p>
                <p className="text-2xl font-bold">{pendingItems.length}</p>
              </div>
              {pendingItems.length > 0 && <AlertCircle className="h-8 w-8 text-orange-600" />}
            </div>
            {pendingItems.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                Documents still needed for your transaction
              </p>
            )}
          </CardContent>
        </Card>

        {/* AI Insights - Coming Soon */}
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-medium">AI Document Analysis</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Coming Soon — Documents will be analyzed and explained in plain English.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="all" className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">All Documents</TabsTrigger>
          <TabsTrigger value="folders">
            <Folder className="h-4 w-4 mr-1" />
            Folders
          </TabsTrigger>
          <TabsTrigger value="required">
            Required
            {pendingItems.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {pendingItems.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* All Documents */}
        <TabsContent value="all" className="space-y-4">
          {allDocuments.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No documents yet</h3>
                <p className="text-muted-foreground mb-4">
                  Upload documents or wait for your agent to share them with you
                </p>
                <DocumentUploadDialog contactId={contactId} />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {allDocuments.map((doc) => (
                <Card key={doc.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4 flex-1">
                        <div className="p-3 bg-blue-50 rounded-lg">
                          {getStatusIcon(doc.status)}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{doc.name}</h3>
                            {isNew(doc.uploaded_at) && (
                              <Badge variant="default" className="text-xs">
                                NEW
                              </Badge>
                            )}
                            {doc.document_type && (
                              <Badge className={getStatusColor(doc.status)}>
                                {doc.document_type.replace(/_/g, " ")}
                              </Badge>
                            )}
                          </div>

                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>
                              Uploaded: {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : "Unknown"}
                            </span>
                            {doc.status && (
                              <Badge variant="outline" className={getStatusColor(doc.status)}>
                                {doc.status}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/portal/${contactId}/documents/${doc.id}`}>
                            <Eye className="h-4 w-4 mr-2" />
                            View
                          </Link>
                        </Button>
                        {doc.file_url && (
                          <Button variant="outline" size="sm" asChild>
                            <a href={doc.file_url} target="_blank" rel="noopener noreferrer" download>
                              <Download className="h-4 w-4 mr-2" />
                              Download
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Folders View */}
        <TabsContent value="folders" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Left Sidebar: Folder Navigation */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Folders</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="space-y-1 px-4 pb-4">
                  {folders.map((folder) => (
                    <div
                      key={folder.path}
                      className="w-full text-left px-3 py-2 rounded-lg flex items-center text-sm hover:bg-muted cursor-pointer"
                    >
                      <Folder className="h-4 w-4 mr-2 text-muted-foreground" />
                      {folder.name}
                      <span className="ml-auto text-xs text-muted-foreground">{folder.document_count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Right: File List */}
            <div className="lg:col-span-3">
              <Card>
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <CardTitle className="text-base">All Files ({allDocuments.length})</CardTitle>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type="search"
                      placeholder="Search files..."
                      className="pl-9 pr-3 py-2 border rounded-lg text-sm w-64"
                    />
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y">
                    {allDocuments.map((doc) => (
                      <div key={doc.id} className="p-4 hover:bg-muted/50 flex items-center">
                        {/* File Icon */}
                        <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center mr-4">
                          <FileText className="h-5 w-5 text-blue-600" />
                        </div>

                        {/* File Info */}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{doc.name}</p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                            <span>{doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : "Unknown date"}</span>
                            {doc.status === "approved" || doc.status === "verified" ? (
                              <>
                                <span>•</span>
                                <span className="flex items-center text-green-600">
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  Verified
                                </span>
                              </>
                            ) : doc.status === "flagged" ? (
                              <>
                                <span>•</span>
                                <span className="flex items-center text-yellow-600">
                                  <AlertCircle className="h-3 w-3 mr-1" />
                                  Needs Review
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" asChild>
                            <Link href={`/portal/${contactId}/documents/${doc.id}`}>
                              <Eye className="h-5 w-5 text-muted-foreground" />
                            </Link>
                          </Button>
                          {doc.file_url && (
                            <Button variant="ghost" size="icon" asChild>
                              <a href={doc.file_url} target="_blank" rel="noopener noreferrer" download>
                                <Download className="h-5 w-5 text-muted-foreground" />
                              </a>
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {allDocuments.length === 0 && (
                      <div className="p-8 text-center text-muted-foreground">
                        <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No documents in this folder</p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Required Documents */}
        <TabsContent value="required" className="space-y-4">
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-blue-600 mt-0.5" />
                <div>
                  <p className="text-sm text-blue-800">
                    These documents are needed to complete your transaction. Upload them here or email them to your agent.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {documentChecklist.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">All caught up!</h3>
                <p className="text-muted-foreground">No additional documents are required at this time</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {documentChecklist.map((item) => {
                const statusColors: Record<string, string> = {
                  missing: "border-l-gray-300",
                  pending: "border-l-yellow-500",
                  uploaded: "border-l-yellow-500",
                  verified: "border-l-blue-500",
                  approved: "border-l-green-500",
                  completed: "border-l-green-500",
                }
                const statusLabels: Record<string, string> = {
                  missing: "Not Yet Uploaded",
                  pending: "Pending",
                  uploaded: "Under Review",
                  verified: "Verified",
                  approved: "Approved",
                  completed: "Completed",
                }
                return (
                  <Card
                    key={item.id}
                    className={`border-l-4 ${statusColors[item.status || "missing"] || "border-l-gray-300"}`}
                  >
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2 flex-wrap">
                            <h4 className="text-lg font-semibold">{item.item_name?.replace(/_/g, " ") || "Document"}</h4>
                            <Badge
                              variant="outline"
                              className={
                                item.status === "approved" || item.status === "completed"
                                  ? "bg-green-100 text-green-700 border-green-200"
                                  : item.status === "verified"
                                    ? "bg-blue-100 text-blue-700 border-blue-200"
                                    : item.status === "uploaded" || item.status === "pending"
                                      ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                                      : "bg-gray-100 text-gray-700 border-gray-200"
                              }
                            >
                              {statusLabels[item.status || "missing"] || item.status}
                            </Badge>
                            {item.required && (
                              <Badge variant="destructive" className="text-xs">
                                Required
                              </Badge>
                            )}
                          </div>

                          {item.notes && (
                            <p className="text-muted-foreground mb-3">{item.notes}</p>
                          )}

                          {/* Due Date Warning */}
                          {item.due_date && (item.status === "missing" || item.status === "pending") && (
                            <div className="mt-3 flex items-center text-sm text-orange-600">
                              <Clock className="h-4 w-4 mr-1" />
                              Due by {new Date(item.due_date).toLocaleDateString()} (
                              {Math.ceil(
                                (new Date(item.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                              )}{" "}
                              days)
                            </div>
                          )}
                        </div>

                        {/* Action Buttons */}
                        <div className="ml-6 flex flex-col gap-2">
                          {item.status === "missing" || item.status === "pending" ? (
                            <DocumentUploadDialog contactId={contactId} documentType={item.item_name || undefined} />
                          ) : (
                            <Button variant="outline" size="sm" className="bg-transparent">
                              <Eye className="h-4 w-4 mr-2" />
                              View
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
