"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  FileText,
  Download,
  Eye,
  Upload,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Clock,
  Sparkles,
  Info,
  ChevronDown,
  ChevronRight,
  Folder,
  Search,
  Loader2,
  HelpCircle,
  Send,
} from "lucide-react"
import Link from "next/link"
import { DocumentUploadDialog } from "@/components/portal/DocumentUploadDialog"
import { analyzeDocument, askDocumentQuestion, getEducationalOverlay } from "@/app/actions/documents"
import { formatDistanceToNow } from "date-fns"

// ─── TYPE DEFINITIONS ────────────────────────────────────────────────────────

interface ClientDocument {
  id: string
  document_name: string | null
  document_url: string | null
  document_type: string | null
  doc_category: string | null
  is_financial_verification: boolean | null
  verification_amount: number | null
  verification_lender: string | null
  expiration_date: string | null
  verified_by: string | null
  verified_at: string | null
  uploaded_by: string | null
  created_at: string | null
}

interface TransactionDocument {
  id: string
  transaction_id: string
  doc_type: string | null
  doc_label: string | null
  status: string | null
  storage_url: string | null
  uploaded_at: string | null
  extracted_data: any | null
  classification_confidence: number | null
  rejection_reason: string | null
  notes: string | null
}

interface ExtractionLog {
  id: string
  transaction_doc_id: string
  extraction_method: string | null
  extracted_fields: any | null
  confidence_score: number | null
  processing_status: string | null
  processed_at: string | null
  error_message: string | null
}

interface DocumentChecklist {
  id: string
  transaction_id: string
  required_documents: any | null
  verified_count: number | null
  total_count: number | null
  status: string | null
}

interface DocumentClassification {
  doc_type: string
  filing_folder: string | null
  requires_review: boolean | null
  auto_route: boolean | null
}

interface StateRequirement {
  state: string
  document_type: string | null
  requirement_name: string | null
  description: string | null
  is_mandatory: boolean | null
  timeline_days: number | null
}

interface PendingSignature {
  id: string
  contract_type: string | null
  provider_name: string | null
  document_url: string | null
  sent_at: string | null
  esign_status: string
}

interface DocumentsClientProps {
  contactId: string
  clientDocs: ClientDocument[]
  txDocs: TransactionDocument[]
  extractionLogs: ExtractionLog[]
  checklist: DocumentChecklist[]
  classifications: DocumentClassification[]
  stateRequirements: StateRequirement[]
  pendingSignatures?: PendingSignature[]
}

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function getStatusColor(status: string | null): string {
  switch (status) {
    case "approved":
    case "verified":
      return "bg-green-100 text-green-800 border-green-200"
    case "rejected":
      return "bg-red-100 text-red-800 border-red-200"
    case "under_review":
      return "bg-purple-100 text-purple-800 border-purple-200"
    case "uploaded":
      return "bg-yellow-100 text-yellow-800 border-yellow-200"
    case "requested":
      return "bg-blue-100 text-blue-800 border-blue-200"
    case "missing":
    default:
      return "bg-gray-100 text-gray-800 border-gray-200"
  }
}

function getExtractionMethodBadge(method: string | null): { label: string; className: string } {
  switch (method) {
    case "ai_claude":
      return { label: "Claude AI", className: "bg-blue-100 text-blue-800" }
    case "ocr":
      return { label: "OCR", className: "bg-gray-100 text-gray-800" }
    case "dotloop_api":
      return { label: "Dotloop", className: "bg-purple-100 text-purple-800" }
    case "docusign_api":
      return { label: "DocuSign", className: "bg-purple-100 text-purple-800" }
    case "manual":
    default:
      return { label: "Manual", className: "bg-gray-100 text-gray-800" }
  }
}

function getConfidenceBadge(score: number | null): { label: string; className: string } {
  if (score === null) return { label: "Unknown", className: "bg-gray-100 text-gray-800" }
  const pct = Math.round(score * 100)
  if (pct >= 80) return { label: `${pct}% confidence`, className: "bg-green-100 text-green-800" }
  if (pct >= 60) return { label: `${pct}% confidence`, className: "bg-amber-100 text-amber-800" }
  return { label: `${pct}% confidence`, className: "bg-red-100 text-red-800" }
}

function formatFieldName(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
}

function formatFieldValue(value: any): string {
  if (typeof value === "number") {
    if (value > 1000) return `$${value.toLocaleString()}`
    return value.toString()
  }
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) return value.join(", ")
  return String(value ?? "")
}

function isExpiringSoon(expirationDate: string | null): "expired" | "expiring" | null {
  if (!expirationDate) return null
  const expDate = new Date(expirationDate)
  const today = new Date()
  const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
  
  if (expDate < today) return "expired"
  if (expDate < thirtyDaysFromNow) return "expiring"
  return null
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function DocumentsClient({
  contactId,
  clientDocs,
  txDocs,
  extractionLogs,
  checklist,
  classifications,
  stateRequirements,
  pendingSignatures = [],
}: DocumentsClientProps) {
  const [isPending, startTransition] = useTransition()
  const [analyzingDocId, setAnalyzingDocId] = useState<string | null>(null)
  const [questionDocId, setQuestionDocId] = useState<string | null>(null)
  const [questionText, setQuestionText] = useState("")
  const [answerText, setAnswerText] = useState<string | null>(null)
  const [educationalOverlays, setEducationalOverlays] = useState<Record<string, any>>({})

  // Build extraction log map by doc ID
  const extractionByDocId = extractionLogs.reduce((acc, log) => {
    if (log.transaction_doc_id && !acc[log.transaction_doc_id]) {
      acc[log.transaction_doc_id] = log
    }
    return acc
  }, {} as Record<string, ExtractionLog>)

  // Calculate progress from checklist
  const totalVerified = checklist.reduce((sum, c) => sum + (c.verified_count ?? 0), 0)
  const totalRequired = checklist.reduce((sum, c) => sum + (c.total_count ?? 0), 0)
  const progressPercent = totalRequired > 0 ? Math.round((totalVerified / totalRequired) * 100) : 0

  // Group txDocs by transaction_id
  const txDocsGrouped = txDocs.reduce((acc, doc) => {
    const txId = doc.transaction_id
    if (!acc[txId]) acc[txId] = []
    acc[txId].push(doc)
    return acc
  }, {} as Record<string, TransactionDocument[]>)

  // Handle analyze document
  const handleAnalyze = async (docId: string) => {
    setAnalyzingDocId(docId)
    startTransition(async () => {
      await analyzeDocument(docId)
      setAnalyzingDocId(null)
      // In production, you'd revalidate the page or refetch data
    })
  }

  // Handle ask question
  const handleAskQuestion = async (docId: string) => {
    if (!questionText.trim()) return
    setQuestionDocId(docId)
    startTransition(async () => {
      const result = await askDocumentQuestion(docId, questionText)
      setAnswerText(result.answer)
      setQuestionDocId(null)
    })
  }

  // Load educational overlay for a doc type
  const loadOverlay = async (docType: string) => {
    if (educationalOverlays[docType]) return
    const overlay = await getEducationalOverlay(docType)
    if (overlay) {
      setEducationalOverlays(prev => ({ ...prev, [docType]: overlay }))
    }
  }

  return (
    <div className="space-y-6">
      {/* Trust language */}
      <p className="text-xs text-muted-foreground">
        Documents shared here are between you and your agent. Nothing is shared externally
        without your approval.
      </p>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold">My Documents</h2>
          <p className="text-muted-foreground">View, understand, and manage your transaction documents</p>
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
              {totalVerified} of {totalRequired} required documents verified
            </p>
          </CardContent>
        </Card>

        {/* Client Documents Count */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">My Uploads</p>
                <p className="text-2xl font-bold">{clientDocs.length}</p>
              </div>
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>

        {/* Transaction Documents Count */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Transaction Documents</p>
                <p className="text-2xl font-bold">{txDocs.length}</p>
              </div>
              <Folder className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action Required — docs pending buyer/seller signature (txDocs + contract_signatures) */}
      {(txDocs.filter(d => d.status === "pending_signature").length > 0 || pendingSignatures.length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
            <div>
              <p className="font-semibold text-sm text-amber-900">Action Required — Signature Needed</p>
              <p className="text-xs text-amber-700">
                {txDocs.filter(d => d.status === "pending_signature").length + pendingSignatures.length} document(s) are waiting for your signature.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {/* E-sign envelopes from contract_signatures */}
            {pendingSignatures.map(sig => (
              <div key={sig.id} className="flex items-center justify-between bg-white rounded-md border border-amber-200 px-3 py-2">
                <div>
                  <p className="text-sm font-medium capitalize">
                    {(sig.contract_type ?? "Document").replace(/_/g, " ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {sig.provider_name ? `via ${sig.provider_name.charAt(0).toUpperCase() + sig.provider_name.slice(1)}` : "E-sign"}
                    {sig.sent_at && (
                      <> &middot; sent {formatDistanceToNow(new Date(sig.sent_at), { addSuffix: true })}</>
                    )}
                  </p>
                </div>
                {sig.document_url ? (
                  <a href={sig.document_url} target="_blank" rel="noreferrer">
                    <Button size="sm" className="text-xs bg-amber-600 hover:bg-amber-700 text-white">
                      <Send className="h-3.5 w-3.5 mr-1.5" />
                      Sign Now
                    </Button>
                  </a>
                ) : (
                  <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-amber-200">
                    Link pending
                  </Badge>
                )}
              </div>
            ))}
            {/* txDocs pending signature */}
            {txDocs
              .filter(d => d.status === "pending_signature")
              .map(d => (
                <div key={d.id} className="flex items-center justify-between bg-white rounded-md border border-amber-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{d.doc_label ?? d.doc_type ?? "Document"}</p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {(d.doc_type ?? "").replace(/_/g, " ")}
                      {d.uploaded_at && (
                        <> &middot; {formatDistanceToNow(new Date(d.uploaded_at), { addSuffix: true })}</>
                      )}
                    </p>
                  </div>
                  {d.storage_url ? (
                    <a href={d.storage_url} target="_blank" rel="noreferrer">
                      <Button size="sm" className="text-xs bg-amber-600 hover:bg-amber-700 text-white">
                        <Send className="h-3.5 w-3.5 mr-1.5" />
                        Open to Sign
                      </Button>
                    </a>
                  ) : (
                    <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-amber-200">
                      Link pending
                    </Badge>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="my-documents" className="space-y-4">
        <TabsList>
          <TabsTrigger value="my-documents">My Documents</TabsTrigger>
          <TabsTrigger value="transaction">Transaction Documents</TabsTrigger>
          <TabsTrigger value="checklist">
            Document Checklist
            {totalRequired - totalVerified > 0 && (
              <Badge variant="destructive" className="ml-2">
                {totalRequired - totalVerified}
              </Badge>
            )}
          </TabsTrigger>
          {stateRequirements.length > 0 && (
            <TabsTrigger value="compliance">State Compliance</TabsTrigger>
          )}
        </TabsList>

        {/* SECTION 1: My Documents (client_documents) */}
        <TabsContent value="my-documents" className="space-y-4">
          {clientDocs.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No documents uploaded yet</h3>
                <p className="text-muted-foreground mb-4">
                  Upload documents or wait for your agent to share them with you
                </p>
                <DocumentUploadDialog contactId={contactId} />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {clientDocs.map((doc) => {
                const expiryStatus = isExpiringSoon(doc.expiration_date)
                
                return (
                  <Card key={doc.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4 flex-1">
                          <div className="p-3 bg-blue-50 rounded-lg">
                            <FileText className="h-5 w-5 text-blue-600" />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="font-semibold">{doc.document_name || "Untitled Document"}</h3>
                              {doc.doc_category && (
                                <Badge variant="outline">{doc.doc_category.replace(/_/g, " ")}</Badge>
                              )}
                              {doc.verified_at && (
                                <Badge className="bg-green-100 text-green-800 border-green-200">
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  Verified {new Date(doc.verified_at).toLocaleDateString()}
                                </Badge>
                              )}
                            </div>

                            {/* Financial verification info */}
                            {doc.is_financial_verification && (
                              <div className="text-sm text-muted-foreground">
                                {doc.verification_amount && (
                                  <span className="mr-4">Amount: ${doc.verification_amount.toLocaleString()}</span>
                                )}
                                {doc.verification_lender && (
                                  <span>Lender: {doc.verification_lender}</span>
                                )}
                              </div>
                            )}

                            {/* Expiration warning */}
                            {expiryStatus === "expired" && (
                              <div className="flex items-center gap-1 text-red-600 text-sm mt-1">
                                <AlertCircle className="h-3 w-3" />
                                Expired
                              </div>
                            )}
                            {expiryStatus === "expiring" && (
                              <div className="flex items-center gap-1 text-amber-600 text-sm mt-1">
                                <AlertTriangle className="h-3 w-3" />
                                Expires {new Date(doc.expiration_date!).toLocaleDateString()}
                              </div>
                            )}

                            <div className="text-xs text-muted-foreground mt-1">
                              Uploaded: {doc.created_at ? new Date(doc.created_at).toLocaleDateString() : "Unknown"}
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
                          {doc.document_url && (
                            <Button variant="outline" size="sm" asChild>
                              <a href={doc.document_url} target="_blank" rel="noopener noreferrer" download>
                                <Download className="h-4 w-4 mr-2" />
                                Download
                              </a>
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

        {/* SECTION 2: Transaction Documents */}
        <TabsContent value="transaction" className="space-y-6">
          {txDocs.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Folder className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No transaction documents yet</h3>
                <p className="text-muted-foreground">
                  Documents will appear here once your transaction begins
                </p>
              </CardContent>
            </Card>
          ) : (
            Object.entries(txDocsGrouped).map(([txId, docs]) => (
              <div key={txId} className="space-y-4">
                {Object.keys(txDocsGrouped).length > 1 && (
                  <h3 className="text-sm font-medium text-muted-foreground">
                    Transaction: {txId.slice(0, 8)}...
                  </h3>
                )}
                
                {docs.map((doc) => {
                  const log = extractionByDocId[doc.id]
                  const hasExtractedData = doc.extracted_data && Object.keys(doc.extracted_data).length > 0
                  const canAnalyze = (doc.status === "uploaded" || doc.status === "under_review") && !log
                  const docType = doc.doc_type

                  return (
                    <Card key={doc.id} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-6 space-y-4">
                        {/* Document Header */}
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-4 flex-1">
                            <div className="p-3 bg-purple-50 rounded-lg">
                              <FileText className="h-5 w-5 text-purple-600" />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <h3 className="font-semibold">{doc.doc_label || "Untitled Document"}</h3>
                                {doc.doc_type && (
                                  <Badge variant="outline">{doc.doc_type.replace(/_/g, " ")}</Badge>
                                )}
                                <Badge className={getStatusColor(doc.status)}>
                                  {doc.status || "Unknown"}
                                </Badge>
                              </div>

                              {doc.rejection_reason && doc.status === "rejected" && (
                                <div className="text-sm text-red-600 mt-1">
                                  Rejection reason: {doc.rejection_reason}
                                </div>
                              )}

                              <div className="text-xs text-muted-foreground mt-1">
                                Uploaded: {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : "Unknown"}
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
                            {doc.storage_url && (
                              <Button variant="outline" size="sm" asChild>
                                <a href={doc.storage_url} target="_blank" rel="noopener noreferrer" download>
                                  <Download className="h-4 w-4 mr-2" />
                                  Download
                                </a>
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* AI Analysis Section */}
                        {log && log.processing_status === "completed" && (
                          <Collapsible>
                            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700">
                              <Sparkles className="h-4 w-4" />
                              AI Analysis
                              <ChevronDown className="h-4 w-4" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="mt-3 space-y-3">
                              {/* Header row */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge className={getExtractionMethodBadge(log.extraction_method).className}>
                                  {getExtractionMethodBadge(log.extraction_method).label}
                                </Badge>
                                <Badge className={getConfidenceBadge(log.confidence_score).className}>
                                  {getConfidenceBadge(log.confidence_score).label}
                                </Badge>
                                {log.processed_at && (
                                  <span className="text-xs text-muted-foreground">
                                    Analyzed {formatDistanceToNow(new Date(log.processed_at), { addSuffix: true })}
                                  </span>
                                )}
                              </div>

                              {/* Extracted Fields */}
                              {log.extracted_fields && (
                                <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                                  <h4 className="text-sm font-medium">Extracted Fields</h4>
                                  <div className="grid grid-cols-2 gap-2">
                                    {Object.entries(log.extracted_fields)
                                      .filter(([k]) => !k.startsWith("_"))
                                      .map(([key, val]) => (
                                        <div key={key} className="flex justify-between text-sm">
                                          <span className="text-muted-foreground">{formatFieldName(key)}:</span>
                                          <span className="font-medium">{formatFieldValue(val)}</span>
                                        </div>
                                      ))}
                                  </div>

                                  {/* Plain English Summary */}
                                  {log.extracted_fields._plain_english && (
                                    <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                                      <h5 className="text-sm font-medium text-blue-800 mb-1">Plain English Summary</h5>
                                      <p className="text-sm text-blue-700">{log.extracted_fields._plain_english}</p>
                                    </div>
                                  )}

                                  {/* Validation Issues */}
                                  {log.extracted_fields._validation_issues?.length > 0 && (
                                    <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                                      <h5 className="text-sm font-medium text-amber-800 mb-1">Validation Issues</h5>
                                      <ul className="text-sm text-amber-700 list-disc list-inside">
                                        {log.extracted_fields._validation_issues.map((issue: any, idx: number) => (
                                          <li key={idx}>{issue.message || JSON.stringify(issue)}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}

                                  {/* Risk Flags */}
                                  {log.extracted_fields._risk_flags?.length > 0 && (
                                    <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                                      <h5 className="text-sm font-medium text-red-800 mb-1">Risk Flags</h5>
                                      <ul className="text-sm text-red-700 list-disc list-inside">
                                        {log.extracted_fields._risk_flags.map((flag: any, idx: number) => (
                                          <li key={idx}>{flag.message || JSON.stringify(flag)}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </CollapsibleContent>
                          </Collapsible>
                        )}

                        {/* Plain-language "What this document means" explainer */}
                        {hasExtractedData && doc.extracted_data && (
                          <Collapsible>
                            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-800">
                              <HelpCircle className="h-4 w-4" />
                              What this document means for you
                              <ChevronDown className="h-4 w-4" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="mt-3">
                              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
                                {/* Summary in plain language */}
                                {typeof doc.extracted_data.summary === "string" && (
                                  <div>
                                    <h5 className="text-sm font-semibold text-blue-900 mb-1">In plain terms</h5>
                                    <p className="text-sm text-blue-800 leading-relaxed">
                                      {doc.extracted_data.summary}
                                    </p>
                                  </div>
                                )}

                                {/* What you need to do */}
                                {Array.isArray(doc.extracted_data.clientImplications) &&
                                  (doc.extracted_data.clientImplications as string[]).length > 0 && (
                                  <div>
                                    <h5 className="text-sm font-semibold text-blue-900 mb-1">What this means for you</h5>
                                    <ul className="list-disc list-inside space-y-1">
                                      {(doc.extracted_data.clientImplications as string[]).map((item, i) => (
                                        <li key={i} className="text-sm text-blue-800">{item}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Action required */}
                                {doc.extracted_data.actionRequired === true && doc.extracted_data.actionDescription && (
                                  <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                                    <h5 className="text-sm font-semibold text-amber-800 mb-1">Action needed from you</h5>
                                    <p className="text-sm text-amber-700">
                                      {String(doc.extracted_data.actionDescription)}
                                    </p>
                                  </div>
                                )}

                                {/* Recommended actions / next steps */}
                                {Array.isArray(doc.extracted_data.recommendedActions) &&
                                  (doc.extracted_data.recommendedActions as string[]).length > 0 && (
                                  <div>
                                    <h5 className="text-sm font-semibold text-blue-900 mb-1">Next steps</h5>
                                    <ul className="list-disc list-inside space-y-1">
                                      {(doc.extracted_data.recommendedActions as string[]).map((a, i) => (
                                        <li key={i} className="text-sm text-blue-800">{a}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Deadlines */}
                                {Array.isArray(doc.extracted_data.deadlines) &&
                                  (doc.extracted_data.deadlines as Array<{ description: string; date: string }>).length > 0 && (
                                  <div>
                                    <h5 className="text-sm font-semibold text-blue-900 mb-1">Key dates</h5>
                                    <div className="space-y-1">
                                      {(doc.extracted_data.deadlines as Array<{ description: string; date: string }>).map((dl, i) => (
                                        <div key={i} className="flex justify-between text-sm">
                                          <span className="text-blue-800">{dl.description}</span>
                                          <span className="font-semibold text-amber-700">{dl.date}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Confidence badge */}
                                {doc.classification_confidence && (
                                  <div className="pt-1">
                                    <Badge className={getConfidenceBadge(doc.classification_confidence).className}>
                                      {getConfidenceBadge(doc.classification_confidence).label}
                                    </Badge>
                                  </div>
                                )}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        )}

                        {/* Analyze Document Button */}
                        {canAnalyze && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAnalyze(doc.id)}
                            disabled={analyzingDocId === doc.id || isPending}
                          >
                            {analyzingDocId === doc.id ? (
                              <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Analyzing...
                              </>
                            ) : (
                              <>
                                <Sparkles className="h-4 w-4 mr-2" />
                                Analyze Document
                              </>
                            )}
                          </Button>
                        )}

                        {/* Educational Overlay */}
                        {docType && (
                          <EducationalOverlaySection 
                            docType={docType}
                            overlays={educationalOverlays}
                            onLoad={() => loadOverlay(docType)}
                          />
                        )}

                        {/* Ask a Question (only for analyzed documents) */}
                        {log && log.processing_status === "completed" && (
                          <div className="border-t pt-4 mt-4">
                            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                              <HelpCircle className="h-4 w-4" />
                              Ask a Question About This Document
                            </h4>
                            <div className="flex gap-2">
                              <Input
                                placeholder="What does this document mean for me?"
                                value={questionDocId === doc.id ? questionText : ""}
                                onChange={(e) => setQuestionText(e.target.value)}
                                onFocus={() => setQuestionDocId(doc.id)}
                                className="flex-1"
                              />
                              <Button
                                size="sm"
                                onClick={() => handleAskQuestion(doc.id)}
                                disabled={questionDocId === doc.id && isPending}
                              >
                                {questionDocId === doc.id && isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Send className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                            {answerText && questionDocId === doc.id && (
                              <div className="mt-3 p-3 bg-blue-50 rounded-lg">
                                <p className="text-sm text-blue-800">{answerText}</p>
                              </div>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            ))
          )}
        </TabsContent>

        {/* SECTION 3: Document Checklist */}
        <TabsContent value="checklist" className="space-y-4">
          {checklist.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No checklist items for this transaction</h3>
                <p className="text-muted-foreground">
                  Your agent will add required documents as your transaction progresses
                </p>
              </CardContent>
            </Card>
          ) : (
            checklist.map((item) => (
              <Card key={item.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Transaction Documents</CardTitle>
                    <Badge className={getStatusColor(item.status)}>{item.status}</Badge>
                  </div>
                  <div className="mt-2">
                    <Progress value={(item.verified_count ?? 0) / (item.total_count ?? 1) * 100} className="h-2" />
                    <p className="text-xs text-muted-foreground mt-1">
                      {item.verified_count ?? 0} of {item.total_count ?? 0} documents verified
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  {item.required_documents && typeof item.required_documents === "object" && (
                    <div className="space-y-2">
                      {(Array.isArray(item.required_documents) ? item.required_documents : Object.entries(item.required_documents)).map((req: any, idx: number) => {
                        const name = typeof req === "string" ? req : req.name || req[0]
                        const status = typeof req === "object" ? (req.status || req[1]?.status) : "missing"
                        const isRequired = typeof req === "object" ? req.required !== false : true
                        
                        return (
                          <div key={idx} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                            <div className="flex items-center gap-2">
                              {status === "verified" ? (
                                <CheckCircle2 className="h-4 w-4 text-green-600" />
                              ) : status === "uploaded" ? (
                                <Clock className="h-4 w-4 text-yellow-600" />
                              ) : (
                                <AlertCircle className="h-4 w-4 text-gray-400" />
                              )}
                              <span className="text-sm">{String(name).replace(/_/g, " ")}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={isRequired ? "border-red-300 text-red-700" : ""}>
                                {isRequired ? "Required" : "Optional"}
                              </Badge>
                              <Badge className={getStatusColor(status)}>
                                {status || "missing"}
                              </Badge>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* SECTION 4: State Compliance */}
        {stateRequirements.length > 0 && (
          <TabsContent value="compliance" className="space-y-4">
            <Card className="border-blue-200 bg-blue-50">
              <CardContent className="py-4">
                <div className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-blue-600 mt-0.5" />
                  <div>
                    <p className="text-sm text-blue-800">
                      These are state-specific compliance requirements for your documents. 
                      Items marked as mandatory must be completed within the specified timeframe.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Group by document_type */}
            {Object.entries(
              stateRequirements.reduce((acc, req) => {
                const docType = req.document_type || "General"
                if (!acc[docType]) acc[docType] = []
                acc[docType].push(req)
                return acc
              }, {} as Record<string, StateRequirement[]>)
            ).map(([docType, reqs]) => (
              <Card key={docType}>
                <CardHeader>
                  <CardTitle className="text-base">{docType.replace(/_/g, " ")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {reqs.map((req, idx) => (
                    <div key={idx} className="flex items-start justify-between p-3 bg-slate-50 rounded-lg">
                      <div className="flex items-start gap-3">
                        {req.is_mandatory && (
                          <div className="w-2 h-2 rounded-full bg-red-500 mt-2" />
                        )}
                        <div>
                          <p className="text-sm font-medium">{req.requirement_name}</p>
                          {req.description && (
                            <p className="text-xs text-muted-foreground mt-1">{req.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {req.timeline_days && (
                          <Badge variant="outline">Within {req.timeline_days} days</Badge>
                        )}
                        <Badge variant="outline">{req.state}</Badge>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        )}

      </Tabs>
    </div>
  )
}

// ─── EDUCATIONAL OVERLAY SECTION ─────────────────────────────────────────────

function EducationalOverlaySection({
  docType,
  overlays,
  onLoad,
}: {
  docType: string
  overlays: Record<string, any>
  onLoad: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const overlay = overlays[docType]

  const handleOpen = () => {
    setIsOpen(!isOpen)
    if (!overlay && !isOpen) {
      onLoad()
    }
  }

  if (!overlay && !isOpen) {
    return (
      <Button variant="ghost" size="sm" onClick={handleOpen} className="text-muted-foreground">
        <HelpCircle className="h-4 w-4 mr-2" />
        Understanding This Document
      </Button>
    )
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" onClick={handleOpen} className="text-muted-foreground">
          <HelpCircle className="h-4 w-4 mr-2" />
          Understanding This Document
          <ChevronRight className={`h-4 w-4 ml-1 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">
        {overlay ? (
          <div className="bg-slate-50 rounded-lg p-4 space-y-4">
            {/* Common Questions */}
            {overlay.common_questions?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-blue-600" />
                  Common Questions
                </h4>
                <div className="space-y-2">
                  {overlay.common_questions.map((q: any, idx: number) => (
                    <Collapsible key={idx}>
                      <CollapsibleTrigger className="flex items-center justify-between w-full text-left text-sm p-2 bg-white rounded hover:bg-blue-50">
                        <span>{q.question}</span>
                        <ChevronDown className="h-4 w-4" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="p-2 text-sm text-muted-foreground">
                        {q.answer}
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </div>
            )}

            {/* Red Flags */}
            {overlay.red_flags_to_watch?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2 text-red-600">
                  <AlertTriangle className="h-4 w-4" />
                  Red Flags to Watch
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {overlay.red_flags_to_watch.map((flag: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-red-500">•</span>
                      {flag}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Pro Tips */}
            {overlay.pro_tips?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2 text-green-600">
                  <Sparkles className="h-4 w-4" />
                  Pro Tips
                </h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {overlay.pro_tips.map((tip: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-green-500">•</span>
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading educational content...
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
