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
  ImageIcon,
} from "lucide-react"
import Link from "next/link"
import { getDocumentWithAnalysis, getEducationalOverlay, checkStateCompliance } from "@/app/actions/documents"

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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    questions: false,
    redFlags: false,
    proTips: false,
  })

  useEffect(() => {
    async function loadDocument() {
      try {
        const { document: doc, educationalOverlay: overlay } = await getDocumentWithAnalysis(documentId)
        setDocument(doc)
        setAnalysis(doc?.document_analysis?.[0])

        // Get educational overlay
        if (doc?.ai_detected_type) {
          const staticOverlay = getEducationalOverlay(doc.ai_detected_type)
          setEducationalOverlay(staticOverlay || overlay)

          // Check state compliance if we have key fields
          if (analysis?.key_fields_extracted) {
            const state = analysis.key_fields_extracted.state || "FL"
            const complianceResult = await checkStateCompliance(
              doc.ai_detected_type,
              analysis.key_fields_extracted,
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
            <iframe src={document.document_url} className="w-full h-[calc(100vh-12rem)]" title={document.document_name} />
          ) : (
            <ImageIcon
              src={document.document_url || "/placeholder.svg"}
              alt={document.document_name}
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
            <h2 className="text-xl font-bold mb-2">{document.document_name}</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {document.ai_detected_type && (
                <Badge variant="secondary">{document.ai_detected_type.replace(/_/g, " ")}</Badge>
              )}
              {document.processing_status === "verified" && (
                <Badge className="bg-green-100 text-green-800">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  AI Verified
                </Badge>
              )}
            </div>
          </div>

          {/* AI-Generated Summary */}
          {analysis?.plain_english_explanation && (
            <Card className="border-blue-200 bg-blue-50">
              <CardContent className="pt-4">
                <div className="flex items-start gap-2 mb-2">
                  <Sparkles className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                  <h3 className="font-semibold text-blue-900">What This Document Is</h3>
                </div>
                <p className="text-sm text-blue-800 leading-relaxed">{analysis.plain_english_explanation}</p>
              </CardContent>
            </Card>
          )}

          {/* Key Information */}
          {analysis?.key_fields_extracted && Object.keys(analysis.key_fields_extracted).length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Key Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(analysis.key_fields_extracted)
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

          {/* Validation Results */}
          {analysis?.validation_status && analysis.validation_status !== "pending" && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Document Check</CardTitle>
              </CardHeader>
              <CardContent>
                {analysis.validation_status === "pass" && (
                  <div className="bg-green-50 border-l-4 border-green-500 p-3 rounded-r">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-green-900">All Good!</p>
                        <p className="text-sm text-green-700 mt-1">This document passed all validation checks.</p>
                      </div>
                    </div>
                  </div>
                )}

                {analysis.validation_issues?.length > 0 && (
                  <div className="space-y-2">
                    {analysis.validation_issues.map((issue: any, idx: number) => (
                      <div
                        key={idx}
                        className={`border-l-4 p-3 rounded-r ${
                          issue.severity === "critical"
                            ? "bg-red-50 border-red-500"
                            : "bg-yellow-50 border-yellow-500"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {issue.severity === "critical" ? (
                            <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                          ) : (
                            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0" />
                          )}
                          <div>
                            <p
                              className={`text-sm font-semibold ${
                                issue.severity === "critical" ? "text-red-900" : "text-yellow-900"
                              }`}
                            >
                              {issue.field || issue.type}
                            </p>
                            <p
                              className={`text-sm mt-1 ${
                                issue.severity === "critical" ? "text-red-700" : "text-yellow-700"
                              }`}
                            >
                              {issue.message}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
                {compliance.issues.map((issue: string, idx: number) => (
                  <p key={idx} className="text-sm text-orange-800">
                    {issue}
                  </p>
                ))}
                {compliance.warnings.map((warning: string, idx: number) => (
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
                  <Button variant="outline" className="w-full mt-3 bg-transparent">
                    <Play className="h-4 w-4 mr-2" />
                    Watch Explainer Video
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <div className="space-y-2">
            <Button variant="outline" className="w-full bg-transparent" asChild>
              <a href={document.document_url} target="_blank" rel="noopener noreferrer" download>
                <Download className="h-4 w-4 mr-2" />
                Download
              </a>
            </Button>

            {document.signature_status === "pending_signature" && (
              <Button className="w-full">
                <PenTool className="h-4 w-4 mr-2" />
                Sign Document
              </Button>
            )}

            {document.processing_status !== "verified" && (
              <Button variant="outline" className="w-full bg-transparent">
                <RefreshCw className="h-4 w-4 mr-2" />
                Replace Document
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
