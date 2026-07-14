"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft,
  Download,
  PenTool,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Play,
  ChevronDown,
  FileText,
} from "lucide-react"
import Link from "next/link"
import { getDocumentWithAnalysis, getEducationalOverlay, checkStateCompliance } from "@/app/actions/documents"
import { loadActiveSignaturePacket, type ActiveSignaturePacket } from "@/app/actions/portal-document-requests"

export default function DocumentViewerPage() {
  const params = useParams()
  const router = useRouter()
  const contactId = params.contactId as string
  const documentId = params.documentId as string

  const [document, setDocument] = useState<any>(null)
  const [analysis, setAnalysis] = useState<any>(null)
  const [educationalOverlay, setEducationalOverlay] = useState<any>(null)
  const [compliance, setCompliance] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [signaturePacket, setSignaturePacket] = useState<ActiveSignaturePacket | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    questions: false,
    redFlags: false,
    proTips: false,
  })

  useEffect(() => {
    async function loadDocument() {
      try {
        // Fetch document with metadata (using canonical schema columns)
        const { document: doc, extractionLog: analysisData } = await getDocumentWithAnalysis(documentId)
        
        if (!doc) {
          setDocument(null)
          setLoading(false)
          return
        }

        setDocument(doc)
        setAnalysis(analysisData)

        // Sign button gate — render only when an ACTIVE packet is out for this signer.
        loadActiveSignaturePacket({ contactId, documentId })
          .then(setSignaturePacket)
          .catch(() => setSignaturePacket(null))

        // Get educational overlay based on document_type
        if (doc.document_type) {
          const staticOverlay = getEducationalOverlay(doc.document_type)
          setEducationalOverlay(staticOverlay)

          // Check state compliance if we have extracted_data with state info
          if (analysisData?.extracted_data && typeof analysisData.extracted_data === 'object') {
            const extractedData = analysisData.extracted_data
            const state = extractedData.state || extractedData.property_state || "FL"
            const complianceResult = await checkStateCompliance(
              doc.document_type,
              extractedData,
              state
            )
            setCompliance(complianceResult)
          }
        }
      } catch (error) {
        console.error("Failed to load document:", error)
      } finally {
        setLoading(false)
      }
    }
    loadDocument()
  }, [documentId])

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }))
  }

  const formatFieldName = (key: string) => {
    return key
      .replace(/_/g, " ")
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
  }

  const formatFieldValue = (value: any) => {
    if (typeof value === "number") {
      if (value > 1000) return `$${value.toLocaleString()}`
      return value.toString()
    }
    if (typeof value === "boolean") return value ? "Yes" : "No"
    if (Array.isArray(value)) return value.join(", ")
    return String(value)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  if (!document) {
    return (
      <div className="p-6 text-center">
        <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Document not found</h2>
        <Button asChild>
          <Link href={`/portal/${contactId}/documents`}>Back to Documents</Link>
        </Button>
      </div>
    )
  }

  const isPdf = document.file_type?.includes("pdf")

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Left: Document Preview */}
      <div className="flex-1 bg-muted/30 p-6 overflow-auto">
        <div className="mb-4">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Documents
          </Button>
        </div>

        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          {isPdf ? (
            <iframe src={document.file_url} className="w-full h-[calc(100vh-12rem)]" title={document.file_name} />
          ) : (
            <img
              src={document.file_url || "/placeholder.svg"}
              alt={document.file_name}
              className="max-w-full h-auto mx-auto"
            />
          )}
        </div>
      </div>

      {/* Right: Educational Sidebar */}
      <div className="w-96 bg-background border-l overflow-auto">
        <div className="p-6 space-y-6">
          {/* Document Info */}
          <div>
            <h2 className="text-xl font-bold mb-2">{document.file_name}</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {document.document_type && (
                <Badge variant="secondary">{document.document_type.replace(/_/g, " ")}</Badge>
              )}
              {document.ocr_status === "verified" && (
                <Badge className="bg-green-100 text-green-800">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Verified
                </Badge>
              )}
            </div>
          </div>

          {/* AI-Generated Summary (using analysis.extraction_summary) */}
          {analysis?.extraction_summary && (
            <Card className="border-blue-200 bg-blue-50">
              <CardContent className="pt-4">
                <div className="flex items-start gap-2 mb-2">
                  <Sparkles className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                  <h3 className="font-semibold text-blue-900">What This Document Is</h3>
                </div>
                <p className="text-sm text-blue-800 leading-relaxed">{analysis.extraction_summary}</p>
              </CardContent>
            </Card>
          )}

          {/* Key Information (using analysis.extracted_data) */}
          {analysis?.extracted_data && typeof analysis.extracted_data === 'object' && Object.keys(analysis.extracted_data).length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Key Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(analysis.extracted_data)
                  .filter(([_, value]) => value !== null && value !== undefined)
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <div key={key} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{formatFieldName(key)}:</span>
                      <span className="font-medium text-right max-w-[60%]">{formatFieldValue(value)}</span>
                    </div>
                  ))}
              </CardContent>
            </Card>
          )}

          {/* Validation Results (using analysis.validation_notes and analysis.confidence_score) */}
          {analysis?.validation_notes && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Document Check</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold">Confidence Score</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {(analysis.confidence_score ? Math.round(analysis.confidence_score * 100) : 0)}% confidence in extraction
                      </p>
                    </div>
                  </div>
                  <div className="bg-slate-50 p-3 rounded text-sm text-muted-foreground">
                    {analysis.validation_notes}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* State Compliance */}
          {compliance && !compliance.passed && (
            <Card className="border-orange-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-orange-600" />
                  State Compliance
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {compliance.issues?.map((issue: string, idx: number) => (
                  <p key={idx} className="text-sm text-orange-800">
                    {issue}
                  </p>
                ))}
                {compliance.warnings?.map((warning: string, idx: number) => (
                  <p key={idx} className="text-sm text-yellow-700">
                    {warning}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Educational Content */}
          {educationalOverlay && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Understanding This Document</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Common Questions */}
                {educationalOverlay.common_questions?.length > 0 && (
                  <div>
                    <button
                      onClick={() => toggleSection("questions")}
                      className="flex items-center justify-between w-full text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <span className="flex items-center gap-1">
                        <HelpCircle className="h-4 w-4" />
                        Common Questions
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${expandedSections.questions ? "rotate-180" : ""}`}
                      />
                    </button>
                    {expandedSections.questions && (
                      <div className="mt-2 space-y-3 pl-5">
                        {educationalOverlay.common_questions.map((q: any, idx: number) => (
                          <div key={idx}>
                            <p className="text-sm font-medium">{q.question}</p>
                            <p className="text-sm text-muted-foreground mt-1">{q.answer}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Red Flags */}
                {educationalOverlay.red_flags_to_watch?.length > 0 && (
                  <div>
                    <button
                      onClick={() => toggleSection("redFlags")}
                      className="flex items-center justify-between w-full text-sm text-red-600 hover:text-red-700 font-medium"
                    >
                      <span className="flex items-center gap-1">
                        <AlertTriangle className="h-4 w-4" />
                        Red Flags to Watch
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${expandedSections.redFlags ? "rotate-180" : ""}`}
                      />
                    </button>
                    {expandedSections.redFlags && (
                      <ul className="mt-2 space-y-1 pl-5">
                        {educationalOverlay.red_flags_to_watch.map((flag: string, idx: number) => (
                          <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-red-500">•</span>
                            {flag}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Pro Tips */}
                {educationalOverlay.pro_tips?.length > 0 && (
                  <div>
                    <button
                      onClick={() => toggleSection("proTips")}
                      className="flex items-center justify-between w-full text-sm text-green-600 hover:text-green-700 font-medium"
                    >
                      <span className="flex items-center gap-1">
                        <Sparkles className="h-4 w-4" />
                        Pro Tips
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${expandedSections.proTips ? "rotate-180" : ""}`}
                      />
                    </button>
                    {expandedSections.proTips && (
                      <ul className="mt-2 space-y-1 pl-5">
                        {educationalOverlay.pro_tips.map((tip: string, idx: number) => (
                          <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-green-500">•</span>
                            {tip}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Video Explainer */}
                {educationalOverlay.video_explainer_url && (
                  <Button variant="outline" className="w-full mt-3 bg-transparent" asChild>
                    <a href={educationalOverlay.video_explainer_url} target="_blank" rel="noopener noreferrer">
                      <Play className="h-4 w-4 mr-2" />
                      Watch Explainer Video
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <div className="space-y-2">
            <Button variant="outline" className="w-full bg-transparent" asChild>
              <a href={document.file_url} target="_blank" rel="noopener noreferrer" download>
                <Download className="h-4 w-4 mr-2" />
                Download
              </a>
            </Button>

            {/* Sign appears ONLY when the agent has an ACTIVE packet out for this signer
                (owner rule) — with a direct route to the envelope when the provider gave one. */}
            {signaturePacket && (
              signaturePacket.signingUrl ? (
                <Button className="w-full" asChild>
                  <a href={signaturePacket.signingUrl} target="_blank" rel="noopener noreferrer">
                    <PenTool className="h-4 w-4 mr-2" />
                    Sign Document
                  </a>
                </Button>
              ) : (
                <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/20 p-3 text-sm text-blue-800 dark:text-blue-200">
                  <p className="font-medium flex items-center gap-1.5"><PenTool className="h-4 w-4" /> Ready for your signature</p>
                  <p className="mt-1">
                    Your signing invite{signaturePacket.sentAt ? ` was sent ${new Date(signaturePacket.sentAt).toLocaleDateString()}` : " is on its way"} — open the email from your e-sign provider to sign.
                    {signaturePacket.expiresAt ? ` It expires ${new Date(signaturePacket.expiresAt).toLocaleDateString()}.` : ""}
                  </p>
                </div>
              )
            )}

            {document.ocr_status !== "verified" && (
              <Button variant="outline" className="w-full bg-transparent" asChild>
                <a href={`/portal/${contactId}/documents`}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Replace Document
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
