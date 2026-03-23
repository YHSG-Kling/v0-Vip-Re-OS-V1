"use client"

import { useEffect, useState, useCallback } from "react"
import {
  generateListingPacket,
  getListingPacketStatus,
  aiPacketQualityCheck,
  regeneratePacketDocument,
} from "@/app/actions/ai-listing-packet"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import {
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Shield,
  Download,
  ChevronDown,
  ChevronUp,
} from "lucide-react"

interface ListingPacketPanelProps {
  listingId: string
  agentId: string
  brokerageId: string
  listing: any
}

interface PacketDocument {
  type: string
  name: string
  url?: string
  content?: any
  status: "pending" | "generated" | "error"
  generatedAt?: string
}

interface PacketJob {
  id: string
  status: string
  config: {
    content?: PacketDocument[]
    quality_check?: {
      overallScore: number
      completeness: number
      quality: number
      compliance: number
      issues: string[]
      recommendations: string[]
      readyForDisplay: boolean
    }
    quality_checked_at?: string
  }
  created_at: string
  completed_at?: string
  error_message?: string
}

const DOCUMENT_OPTIONS = [
  { key: "includeFlyer", label: "AI-Generated Flyer", docType: "listing_flyer" },
  { key: "includeSellerDisclosure", label: "Seller Disclosure Forms", docType: "seller_disclosure" },
  { key: "includeUtilitiesForm", label: "Utility Information Form", docType: "utilities_form" },
  { key: "includeGISReport", label: "GIS Property Report", docType: "gis_report" },
  { key: "includeTaxRecord", label: "Tax Record", docType: "tax_record" },
  { key: "includeAppraiserReport", label: "Appraiser Site Report", docType: "appraiser_report" },
]

export function ListingPacketPanel({ listingId, agentId, brokerageId, listing }: ListingPacketPanelProps) {
  const { toast } = useToast()

  const [latestPacket, setLatestPacket] = useState<PacketJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [qualityChecking, setQualityChecking] = useState(false)
  const [qcResult, setQcResult] = useState<PacketJob["config"]["quality_check"] | null>(null)
  const [regeneratingDoc, setRegeneratingDoc] = useState<string | null>(null)
  const [showQC, setShowQC] = useState(false)

  const [selectedDocs, setSelectedDocs] = useState<Record<string, boolean>>(
    Object.fromEntries(DOCUMENT_OPTIONS.map((d) => [d.key, true]))
  )

  const fetchStatus = useCallback(async () => {
    const res = await getListingPacketStatus(listingId)
    if (res.success && res.packets && res.packets.length > 0) {
      const latest = res.packets[0] as PacketJob
      setLatestPacket(latest)
      if (latest.config?.quality_check) {
        setQcResult(latest.config.quality_check)
      }
    } else {
      setLatestPacket(null)
    }
    setLoading(false)
  }, [listingId])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Poll while generating
  useEffect(() => {
    if (latestPacket?.status === "queued" || latestPacket?.status === "processing") {
      const interval = setInterval(async () => {
        const res = await getListingPacketStatus(listingId)
        if (res.success && res.packets && res.packets.length > 0) {
          const latest = res.packets[0] as PacketJob
          setLatestPacket(latest)
          if (latest.status === "completed" || latest.status === "failed") {
            setGenerating(false)
            clearInterval(interval)
            if (latest.status === "completed") {
              toast({ title: "Listing packet ready", description: "All documents have been generated." })
            }
          }
        }
      }, 10_000)
      return () => clearInterval(interval)
    }
  }, [latestPacket?.status, listingId, toast])

  async function handleGenerate() {
    setGenerating(true)
    const res = await generateListingPacket({
      listingId,
      agentId,
      includeFlyer: selectedDocs.includeFlyer,
      includeSellerDisclosure: selectedDocs.includeSellerDisclosure,
      includeUtilitiesForm: selectedDocs.includeUtilitiesForm,
      includeGISReport: selectedDocs.includeGISReport,
      includeTaxRecord: selectedDocs.includeTaxRecord,
      includeAppraiserReport: selectedDocs.includeAppraiserReport,
      createPhysicalBinder: false,
      deliveryMethod: "email",
      copies: 1,
    })

    if (res.success) {
      toast({
        title: "Packet generation started",
        description: "Check back in a few minutes — we will refresh automatically.",
      })
      await fetchStatus()
    } else {
      toast({
        title: "Could not generate packet",
        description: res.error ?? "An error occurred.",
        variant: "destructive",
      })
      setGenerating(false)
    }
  }

  async function handleQualityCheck() {
    if (!latestPacket) return
    setQualityChecking(true)
    setShowQC(true)
    const res = await aiPacketQualityCheck(latestPacket.id)
    if (res.success && res.qualityCheck) {
      setQcResult(res.qualityCheck)
      toast({ title: "Quality check complete", description: `Score: ${res.qualityCheck.overallScore}/100` })
    } else {
      toast({ title: "Quality check failed", description: res.error ?? "An error occurred.", variant: "destructive" })
    }
    setQualityChecking(false)
  }

  async function handleRegenerate(docType: string, docName: string) {
    if (!latestPacket) return
    setRegeneratingDoc(docType)
    const res = await regeneratePacketDocument({ packetId: latestPacket.id, documentType: docType })
    if (res.success) {
      toast({ title: `Regenerated ${docName}` })
      await fetchStatus()
    } else {
      toast({ title: "Regeneration failed", description: res.error ?? "An error occurred.", variant: "destructive" })
    }
    setRegeneratingDoc(null)
  }

  function toggleDoc(key: string) {
    setSelectedDocs((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // ── LOADING ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="py-8 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading packet status...</span>
        </CardContent>
      </Card>
    )
  }

  const isGenerating =
    generating || latestPacket?.status === "queued" || latestPacket?.status === "processing"
  const isComplete = latestPacket?.status === "completed"
  const documents: PacketDocument[] = latestPacket?.config?.content ?? []

  // ── NO PACKET / GENERATE FORM ─────────────────────────────────────────────
  if (!latestPacket || latestPacket.status === "failed") {
    return (
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Listing Packet
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Generate a comprehensive packet for this listing including all disclosure forms and reports.
          </p>
          {latestPacket?.status === "failed" && latestPacket.error_message && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-xs text-destructive">{latestPacket.error_message}</p>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Documents to include</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {DOCUMENT_OPTIONS.map((doc) => (
                <label
                  key={doc.key}
                  className="flex items-center gap-2 cursor-pointer rounded-md border border-border px-3 py-2 hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    checked={selectedDocs[doc.key]}
                    onCheckedChange={() => toggleDoc(doc.key)}
                    id={doc.key}
                  />
                  <span className="text-sm text-foreground">{doc.label}</span>
                </label>
              ))}
            </div>
          </div>

          <Button
            className="w-full"
            onClick={handleGenerate}
            disabled={isGenerating || !Object.values(selectedDocs).some(Boolean)}
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-2" />
                Generate Full Packet
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ── GENERATING ────────────────────────────────────────────────────────────
  if (isGenerating) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Listing Packet
            <Badge variant="secondary" className="ml-auto">Generating</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
            <div className="flex-1 space-y-1.5">
              <p className="text-sm font-medium">Generating your listing packet...</p>
              <Progress value={undefined} className="h-1.5" />
              <p className="text-xs text-muted-foreground">
                Started {new Date(latestPacket.created_at).toLocaleTimeString()} — refreshing every 10s
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── COMPLETE ──────────────────────────────────────────────────────────────
  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <CardTitle className="text-base font-semibold">Listing Packet</CardTitle>
          <Badge className="ml-auto bg-green-100 text-green-700 border-green-200">Ready</Badge>
        </div>
        {latestPacket.completed_at && (
          <p className="text-xs text-muted-foreground">
            Generated {new Date(latestPacket.completed_at).toLocaleDateString()} at{" "}
            {new Date(latestPacket.completed_at).toLocaleTimeString()}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Document list */}
        <div className="space-y-1.5">
          {DOCUMENT_OPTIONS.map((option) => {
            const doc = documents.find((d) => d.type === option.docType)
            const isErr = doc?.status === "error"
            const isRegen = regeneratingDoc === option.docType

            return (
              <div
                key={option.key}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isErr ? (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  )}
                  <span className="text-sm text-foreground truncate">{option.label}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  {doc?.url && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      asChild
                    >
                      <a href={doc.url} target="_blank" rel="noopener noreferrer">
                        <Download className="h-3 w-3 mr-1" />
                        Download
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => handleRegenerate(option.docType, option.label)}
                    disabled={isRegen}
                    title="Regenerate document"
                  >
                    {isRegen ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Actions row */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleQualityCheck}
            disabled={qualityChecking}
          >
            {qualityChecking ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <Shield className="h-3.5 w-3.5 mr-1.5" />
                AI Quality Check
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLatestPacket(null)
              setQcResult(null)
              setShowQC(false)
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Regenerate All
          </Button>
        </div>

        {/* Quality check result */}
        {qcResult && showQC && (
          <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Quality Check Results</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">
                  Score: {qcResult.overallScore}/100
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setShowQC(false)}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Score bars */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Completeness", value: qcResult.completeness },
                { label: "Quality", value: qcResult.quality },
                { label: "Compliance", value: qcResult.compliance },
              ].map((s) => (
                <div key={s.label} className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{s.label}</span>
                    <span>{s.value}</span>
                  </div>
                  <Progress value={s.value} className="h-1.5" />
                </div>
              ))}
            </div>

            {qcResult.issues.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4" />
                Everything looks good
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Issues</p>
                <ul className="space-y-1">
                  {qcResult.issues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-foreground">
                      <AlertCircle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                      {issue}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {qcResult.recommendations.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recommendations</p>
                <ul className="space-y-1">
                  {qcResult.recommendations.map((rec, i) => (
                    <li key={i} className="text-xs text-foreground">
                      {i + 1}. {rec}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {qcResult && !showQC && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground"
            onClick={() => setShowQC(true)}
          >
            <ChevronDown className="h-3.5 w-3.5 mr-1" />
            Show quality check results (Score: {qcResult.overallScore}/100)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
