"use client"

import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  FileText,
  Download,
  Eye,
  PenTool,
  MessageCircle,
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
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"
import Loading from "./loading"

export default async function DocumentsPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Get documents with analysis
  const { data: documents } = await supabase
    .from("client_documents")
    .select("*, document_analysis(*)")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Get document requirements
  const { data: requirements } = await supabase
    .from("document_requirements")
    .select("*")
    .eq("contact_id", contactId)
    .order("required_by_date", { ascending: true })

  // Calculate folder counts
  const folders = [
    { name: "All Files", path: "all", document_count: documents?.length || 0 },
    {
      name: "Contracts",
      path: "contracts",
      document_count:
        documents?.filter(
          (d) =>
            d.ai_detected_type?.includes("agreement") ||
            d.ai_detected_type?.includes("contract") ||
            d.ai_detected_type?.includes("addendum")
        ).length || 0,
    },
    {
      name: "Disclosures",
      path: "disclosures",
      document_count: documents?.filter((d) => d.ai_detected_type?.includes("disclosure")).length || 0,
    },
    {
      name: "Financial",
      path: "financial",
      document_count:
        documents?.filter(
          (d) =>
            d.ai_detected_type?.includes("proof_of_funds") ||
            d.ai_detected_type?.includes("bank") ||
            d.ai_detected_type?.includes("appraisal")
        ).length || 0,
    },
    {
      name: "Inspections",
      path: "inspections",
      document_count: documents?.filter((d) => d.ai_detected_type?.includes("inspection")).length || 0,
    },
    {
      name: "Other",
      path: "other",
      document_count:
        documents?.filter(
          (d) =>
            !d.ai_detected_type ||
            (!d.ai_detected_type.includes("agreement") &&
              !d.ai_detected_type.includes("contract") &&
              !d.ai_detected_type.includes("addendum") &&
              !d.ai_detected_type.includes("disclosure") &&
              !d.ai_detected_type.includes("proof_of_funds") &&
              !d.ai_detected_type.includes("bank") &&
              !d.ai_detected_type.includes("appraisal") &&
              !d.ai_detected_type.includes("inspection"))
        ).length || 0,
    },
  ]

  const isNew = (createdAt: string) => {
    const hoursSince = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60)
    return hoursSince < 48
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "verified":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "flagged":
        return <AlertCircle className="h-4 w-4 text-orange-600" />
      case "processing":
        return <Clock className="h-4 w-4 text-blue-600 animate-pulse" />
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      purchase_agreement: "bg-blue-100 text-blue-800",
      inspection_report: "bg-yellow-100 text-yellow-800",
      appraisal: "bg-purple-100 text-purple-800",
      proof_of_funds: "bg-green-100 text-green-800",
      closing_disclosure: "bg-emerald-100 text-emerald-800",
      disclosure_form: "bg-orange-100 text-orange-800",
    }
    return colors[category] || "bg-gray-100 text-gray-800"
  }

  // Calculate progress
  const requiredDocs = requirements?.filter((r) => r.required) || []
  const uploadedDocs = requiredDocs.filter((r) => r.status !== "missing")
  const progressPercent = requiredDocs.length > 0 ? Math.round((uploadedDocs.length / requiredDocs.length) * 100) : 0

  const pendingSignatures = documents?.filter((d) => d.signature_status === "pending_signature") || []

  return (
    <Suspense fallback={<Loading />}>
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
                {uploadedDocs.length} of {requiredDocs.length} required documents uploaded
              </p>
            </CardContent>
          </Card>

          {/* Pending Signatures */}
          <Card className={pendingSignatures.length > 0 ? "border-orange-200 bg-orange-50" : ""}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Pending Signatures</p>
                  <p className="text-2xl font-bold">{pendingSignatures.length}</p>
                </div>
                {pendingSignatures.length > 0 && <PenTool className="h-8 w-8 text-orange-600" />}
              </div>
              {pendingSignatures.length > 0 && (
                <Button size="sm" className="w-full mt-3">
                  Sign Now
                </Button>
              )}
            </CardContent>
          </Card>

          {/* AI Insights */}
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="h-5 w-5 text-blue-600" />
                <span className="text-sm font-medium">AI Document Assistant</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Every document is analyzed and explained in plain English. Click any document to learn more.
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
              {requiredDocs.filter((r) => r.status === "missing").length > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {requiredDocs.filter((r) => r.status === "missing").length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="signatures">
              Signatures
              {pendingSignatures.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {pendingSignatures.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* All Documents */}
          <TabsContent value="all" className="space-y-4">
            {!documents || documents.length === 0 ? (
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
                {documents.map((doc) => {
                  const analysis = doc.document_analysis?.[0]
                  return (
                    <Card key={doc.id} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-4 flex-1">
                            <div className="p-3 bg-blue-50 rounded-lg">{getStatusIcon(doc.processing_status)}</div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold">{doc.document_name}</h3>
                                {isNew(doc.created_at) && (
                                  <Badge variant="default" className="text-xs">
                                    NEW
                                  </Badge>
                                )}
                                {doc.ai_detected_type && (
                                  <Badge className={getCategoryColor(doc.ai_detected_type)}>
                                    {doc.ai_detected_type.replace(/_/g, " ")}
                                  </Badge>
                                )}
                              </div>

                              {/* AI Summary */}
                              {analysis?.plain_english_explanation && (
                                <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                                  {analysis.plain_english_explanation.substring(0, 150)}...
                                </p>
                              )}

                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span>Uploaded: {new Date(doc.created_at).toLocaleDateString()}</span>
                                {doc.ai_confidence_score && (
                                  <span className="flex items-center gap-1">
                                    <Sparkles className="h-3 w-3" />
                                    {Math.round(doc.ai_confidence_score * 100)}% match
                                  </span>
                                )}
                                {doc.signature_status === "pending_signature" && (
                                  <Badge variant="outline" className="text-orange-600 border-orange-600">
                                    Signature Required
                                  </Badge>
                                )}
                                {doc.signature_status === "signed" && (
                                  <Badge variant="outline" className="text-green-600 border-green-600">
                                    Signed
                                  </Badge>
                                )}
                              </div>

                              {/* Validation Issues */}
                              {analysis?.validation_issues && analysis.validation_issues.length > 0 && (
                                <div className="mt-2 p-2 bg-yellow-50 rounded-lg border border-yellow-200">
                                  <div className="flex items-center gap-2 text-yellow-800 text-sm">
                                    <AlertCircle className="h-4 w-4" />
                                    <span>{analysis.validation_issues.length} item(s) need attention</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" asChild>
                              <Link href={`/portal/${contactId}/documents/${doc.id}`}>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </Link>
                            </Button>
                            <Button variant="outline" size="sm" asChild>
                              <a href={doc.document_url} target="_blank" rel="noopener noreferrer" download>
                                <Download className="h-4 w-4 mr-2" />
                                Download
                              </a>
                            </Button>
                            {doc.signature_status === "pending_signature" && (
                              <Button size="sm">
                                <PenTool className="h-4 w-4 mr-2" />
                                Sign
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
                    <CardTitle className="text-base">All Files ({documents?.length || 0})</CardTitle>
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
                      {documents?.map((doc) => (
                        <div key={doc.id} className="p-4 hover:bg-muted/50 flex items-center">
                          {/* File Icon */}
                          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center mr-4">
                            {doc.file_type?.includes("pdf") ? (
                              <FileText className="h-5 w-5 text-blue-600" />
                            ) : (
                              <ImageIcon className="h-5 w-5 text-blue-600" />
                            )}
                          </div>

                          {/* File Info */}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{doc.document_name}</p>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                              <span>
                                {doc.file_size_bytes
                                  ? `${(doc.file_size_bytes / 1024).toFixed(1)} KB`
                                  : "Unknown size"}
                              </span>
                              <span>•</span>
                              <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                              {doc.processing_status === "verified" && (
                                <>
                                  <span>•</span>
                                  <span className="flex items-center text-green-600">
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    AI Verified
                                  </span>
                                </>
                              )}
                              {doc.processing_status === "flagged" && (
                                <>
                                  <span>•</span>
                                  <span className="flex items-center text-yellow-600">
                                    <AlertCircle className="h-3 w-3 mr-1" />
                                    Needs Review
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2">
                            <Button variant="ghost" size="icon" asChild>
                              <Link href={`/portal/${contactId}/documents/${doc.id}`}>
                                <Eye className="h-5 w-5 text-muted-foreground" />
                              </Link>
                            </Button>
                            <Button variant="ghost" size="icon" asChild>
                              <a href={doc.document_url} target="_blank" rel="noopener noreferrer" download>
                                <Download className="h-5 w-5 text-muted-foreground" />
                              </a>
                            </Button>
                          </div>
                        </div>
                      ))}
                      {(!documents || documents.length === 0) && (
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
                      These documents are needed to complete your transaction. Upload them here or email them to your
                      agent.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {!requirements || requirements.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">All caught up!</h3>
                  <p className="text-muted-foreground">No additional documents are required at this time</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {requirements.map((req) => {
                  const statusColors = {
                    missing: "border-l-gray-300",
                    uploaded: "border-l-yellow-500",
                    verified: "border-l-blue-500",
                    approved: "border-l-green-500",
                  }
                  const statusLabels = {
                    missing: "Not Yet Uploaded",
                    uploaded: "Under Review",
                    verified: "Verified",
                    approved: "Approved",
                  }
                  return (
                    <Card
                      key={req.id}
                      className={`border-l-4 ${statusColors[req.status as keyof typeof statusColors] || "border-l-gray-300"}`}
                    >
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2 flex-wrap">
                              <h4 className="text-lg font-semibold">{req.document_type.replace(/_/g, " ")}</h4>
                              <Badge
                                variant="outline"
                                className={
                                  req.status === "approved"
                                    ? "bg-green-100 text-green-700 border-green-200"
                                    : req.status === "verified"
                                      ? "bg-blue-100 text-blue-700 border-blue-200"
                                      : req.status === "uploaded"
                                        ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                                        : "bg-gray-100 text-gray-700 border-gray-200"
                                }
                              >
                                {statusLabels[req.status as keyof typeof statusLabels] || req.status}
                              </Badge>
                              {req.required && (
                                <Badge variant="destructive" className="text-xs">
                                  Required
                                </Badge>
                              )}
                            </div>

                            <p className="text-muted-foreground mb-3">{req.description || "Please upload this document"}</p>

                            {/* Educational Context - Expandable */}
                            {(req.why_needed || req.typical_source) && (
                              <details className="mt-3 group">
                                <summary className="cursor-pointer text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1">
                                  <Info className="h-4 w-4" />
                                  Why do I need this?
                                </summary>
                                <div className="mt-2 pl-5 text-sm text-muted-foreground space-y-2 bg-muted/50 p-3 rounded-lg">
                                  {req.why_needed && (
                                    <p>
                                      <strong>Purpose:</strong> {req.why_needed}
                                    </p>
                                  )}
                                  {req.typical_source && (
                                    <p>
                                      <strong>Where to get it:</strong> {req.typical_source}
                                    </p>
                                  )}
                                  {req.help_article_url && (
                                    <a
                                      href={req.help_article_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:underline flex items-center gap-1"
                                    >
                                      <FileText className="h-4 w-4" />
                                      Learn more about this document
                                    </a>
                                  )}
                                </div>
                              </details>
                            )}

                            {/* Due Date Warning */}
                            {req.required_by_date && req.status === "missing" && (
                              <div className="mt-3 flex items-center text-sm text-orange-600">
                                <Clock className="h-4 w-4 mr-1" />
                                Due by {new Date(req.required_by_date).toLocaleDateString()} (
                                {Math.ceil(
                                  (new Date(req.required_by_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                                )}{" "}
                                days)
                              </div>
                            )}
                          </div>

                          {/* Action Buttons */}
                          <div className="ml-6 flex flex-col gap-2">
                            {req.status === "missing" ? (
                              <DocumentUploadDialog contactId={contactId} documentType={req.document_type} />
                            ) : (
                              <>
                                {req.document_id && (
                                  <Button variant="outline" size="sm" asChild className="bg-transparent">
                                    <Link href={`/portal/${contactId}/documents/${req.document_id}`}>
                                      <Eye className="h-4 w-4 mr-2" />
                                      View
                                    </Link>
                                  </Button>
                                )}
                                {req.status !== "approved" && (
                                  <DocumentUploadDialog
                                    contactId={contactId}
                                    documentType={req.document_type}
                                    buttonText="Replace"
                                    buttonVariant="outline"
                                  />
                                )}
                              </>
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

          {/* Signatures Tab */}
          <TabsContent value="signatures" className="space-y-4">
            {pendingSignatures.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center">
                  <PenTool className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No pending signatures</h3>
                  <p className="text-muted-foreground">You are all caught up on document signatures</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {pendingSignatures.map((doc) => (
                  <Card key={doc.id} className="border-orange-200">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-orange-100 rounded-lg">
                            <PenTool className="h-6 w-6 text-orange-600" />
                          </div>
                          <div>
                            <h3 className="font-semibold">{doc.document_name}</h3>
                            <p className="text-sm text-muted-foreground">
                              Uploaded: {new Date(doc.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <Button>
                          Sign Document
                          <ChevronRight className="h-4 w-4 ml-2" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Suspense>
  )
}
