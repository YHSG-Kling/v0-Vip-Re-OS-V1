"use client"

import { useState, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Home, Search, Loader2, ThumbsUp, ThumbsDown, Calendar, Eye, Sparkles, Bell, FlaskConical, CheckCircle2, AlertCircle } from "lucide-react"
import {
  searchPropertiesWithNaturalLanguage,
  previewSearchIntent,
  explainPropertyMatchForBuyer,
} from "@/app/actions/buyer-property-search"
import {
  generatePropertyMatches,
  learnFromBuyerFeedback,
  analyzePropertyForBuyer,
  notifyNewMatches,
} from "@/app/actions/ai-property-matching"
import { requestShowing } from "@/app/actions/smart-insights"
import { updateContact } from "@/app/actions/contacts"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { draftSmartEmail } from "@/app/actions/ai-insights"
import { sendEmail } from "@/app/actions/communications"
import { PropertyAlertsPanel } from "./property-alerts-panel"

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const BUYER_STAGES = [
  { value: "new", label: "New Lead" },
  { value: "nurturing", label: "Nurturing" },
  { value: "active", label: "Active Buyer" },
  { value: "qualified", label: "Qualified" },
  { value: "under_contract", label: "Under Contract" },
  { value: "closed", label: "Closed" },
  { value: "lost", label: "Lost" },
]

interface BuyerMatchPanelProps {
  contactId: string
  agentId: string
  brokerageId?: string
  isBuyerContact: boolean
  buyerStage?: string | null
  contactName: string
}

interface PropertyMatch {
  listing_id: string
  address?: string
  price?: number | null
  match_score?: number
  bedrooms?: number | null
  bathrooms?: number | null
  [key: string]: any
}

export function BuyerMatchPanel({
  contactId,
  agentId,
  brokerageId,
  isBuyerContact,
  buyerStage,
  contactName,
}: BuyerMatchPanelProps) {
  const [stage, setStage] = useState(buyerStage ?? "")
  // Generation counter to handle rapid stage changes — only apply result from latest request
  const stageGenRef = useRef(0)
  const [query, setQuery] = useState("")
  const [emailDialogOpen, setEmailDialogOpen] = useState(false)
  const [emailDraft, setEmailDraft] = useState("")
  const [emailLoading, setEmailLoading] = useState(false)
  const [sendingEmail, setSendingEmail] = useState(false)
  const [previewIntent, setPreviewIntent] = useState<any>(null)
  const [matches, setMatches] = useState<PropertyMatch[]>([])
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [showingForm, setShowingForm] = useState<string | null>(null)
  const [showingDate, setShowingDate] = useState("")
  const [showingNotes, setShowingNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [explainLoading, setExplainLoading] = useState<string | null>(null)
  const [showingLoading, setShowingLoading] = useState(false)
  // Deep analysis per property
  const [deepAnalysisLoading, setDeepAnalysisLoading] = useState<string | null>(null)
  const [deepAnalysisResults, setDeepAnalysisResults] = useState<Record<string, any>>({})
  // Notify new matches
  const [notifyLoading, setNotifyLoading] = useState(false)
  const [notifyResult, setNotifyResult] = useState<{ notified: number } | null>(null)

  // Only render for buyer contacts
  if (!isBuyerContact) {
    return null
  }

  const handlePreviewIntent = async () => {
    if (!query.trim()) return
    setPreviewLoading(true)
    try {
      const result = await previewSearchIntent({ contactId, naturalLanguageQuery: query })
      if (result.success && 'preview' in result) {
        setPreviewIntent(result.preview)
      }
    } catch (err) {
      console.error("Preview intent failed:", err)
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleFindMatches = async () => {
    if (!query.trim()) return
    setLoading(true)
    setMatches([])
    try {
      const result = await searchPropertiesWithNaturalLanguage({
        contactId,
        naturalLanguageQuery: query,
      })
      if (result.success && 'results' in result && result.results) {
        setMatches(result.results.map((r: any) => ({
          listing_id: r.listing_id,
          address: [r.city, r.state].filter(Boolean).join(", ") || r.listing_id,
          price: r.price,
          match_score: r.internal_match_score,
          bedrooms: r.bedrooms,
          bathrooms: r.bathrooms,
          ...r,
        })))
      }
    } catch (err) {
      console.error("Search failed:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleUseSavedCriteria = async () => {
    setLoading(true)
    setMatches([])
    try {
      const result = await generatePropertyMatches({ contactId, agentId, maxResults: 10 })
      if (result.success && 'matches' in result && result.matches) {
        setMatches((result.matches as any[]).map((m: any) => ({
          listing_id: m.propertyId ?? m.listing_id ?? m.id ?? "",
          address: m.address,
          price: m.price,
          match_score: m.matchScore ?? m.match_score,
          bedrooms: m.bedrooms,
          bathrooms: m.bathrooms,
          ...m,
        })))
      }
    } catch (err) {
      console.error("Generate matches failed:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleExplainMatch = async (listingId: string) => {
    setExplainLoading(listingId)
    setSelectedMatch(listingId)
    try {
      const result = await explainPropertyMatchForBuyer({ contactId, listingId })
      if (result.success) {
        const expl = (result as any).explanation
        if (typeof expl === "string") {
          setExplanation(expl)
        } else if (expl && typeof expl === "object") {
          setExplanation(expl.narrative ?? expl.headline ?? "This property matches based on your criteria.")
        } else {
          setExplanation("This property matches based on your criteria.")
        }
      }
    } catch (err) {
      console.error("Explain match failed:", err)
    } finally {
      setExplainLoading(null)
    }
  }

  const handleFeedback = async (listingId: string, feedback: "liked" | "disliked") => {
    try {
      await learnFromBuyerFeedback({ contactId, propertyId: listingId, feedback, agentId })
      // Update UI to show feedback was recorded
      setMatches((prev) =>
        prev.map((m) =>
          m.listing_id === listingId ? { ...m, userFeedback: feedback } : m
        )
      )
    } catch (err) {
      console.error("Feedback failed:", err)
    }
  }

  const handleScheduleShowing = async (match: PropertyMatch) => {
    if (!showingDate) return
    setShowingLoading(true)
    try {
      await requestShowing(
        contactId,
        match.listing_id,
        match.address || "Property",
        { price: match.price, bedrooms: match.bedrooms },
        [{ date: showingDate.split("T")[0] ?? showingDate, time: showingDate.split("T")[1] ?? "10:00" }],
        showingNotes
      )
      setShowingForm(null)
      setShowingDate("")
      setShowingNotes("")
    } catch (err) {
      console.error("Schedule showing failed:", err)
    } finally {
      setShowingLoading(false)
    }
  }

  const handleDeepAnalysis = async (listingId: string) => {
    setDeepAnalysisLoading(listingId)
    try {
      const result = await analyzePropertyForBuyer({ contactId, propertyId: listingId, agentId })
      if (result.success) {
        setDeepAnalysisResults((prev) => ({ ...prev, [listingId]: result }))
      }
    } catch (err) {
      console.error("Deep analysis failed:", err)
    } finally {
      setDeepAnalysisLoading(null)
    }
  }

  const handleNotifyMatches = async () => {
    setNotifyLoading(true)
    setNotifyResult(null)
    try {
      const result = await notifyNewMatches({ contactId, agentId, threshold: 85 })
      if (result.success) {
        setNotifyResult({ notified: (result as any).notifiedCount ?? (result as any).matchCount ?? (result as any).count ?? 0 })
      }
    } catch (err) {
      console.error("Notify matches failed:", err)
    } finally {
      setNotifyLoading(false)
    }
  }

  const getMatchScoreColor = (score?: number) => {
    if (!score) return "bg-gray-100 text-gray-600"
    if (score >= 70) return "bg-emerald-100 text-emerald-700"
    if (score >= 50) return "bg-amber-100 text-amber-700"
    return "bg-red-100 text-red-700"
  }

  const firstName = contactName.split(" ")[0]

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Home className="h-4 w-4 text-blue-600" />
            Find Homes for {firstName}
          </CardTitle>
          <Select
            value={stage}
            onValueChange={async (val) => {
              const prev = stage
              setStage(val)
              const gen = ++stageGenRef.current
              const result = await updateContact(contactId, { buyer_stage: val })
              if (stageGenRef.current !== gen) return // superseded by a later request
              if (!result.success) {
                setStage(prev)
                toast.error("Failed to update stage")
              } else {
                toast.success("Buyer stage updated")
              }
            }}
          >
            <SelectTrigger className="h-7 text-xs w-36">
              <SelectValue placeholder="Set stage" />
            </SelectTrigger>
            <SelectContent>
              {BUYER_STAGES.map((s) => (
                <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {/* Search input */}
        <div className="space-y-3 mb-4">
          <Textarea
            placeholder={`Describe what ${firstName} is looking for... e.g. "3-bed under $400K in Pensacola near good schools"`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={2}
          />

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={handleNotifyMatches}
              disabled={notifyLoading}
            >
              {notifyLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : notifyResult ? (
                <CheckCircle2 className="h-4 w-4 mr-1 text-emerald-500" />
              ) : (
                <Bell className="h-4 w-4 mr-1" />
              )}
              {notifyResult
                ? `Notified (${notifyResult.notified})`
                : "Notify New Matches"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePreviewIntent}
              disabled={previewLoading || !query.trim()}
            >
              {previewLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Eye className="h-4 w-4 mr-1" />
              )}
              Preview Intent
            </Button>
            <Button
              size="sm"
              onClick={handleFindMatches}
              disabled={loading || !query.trim()}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Search className="h-4 w-4 mr-1" />
              )}
              Find Matches
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleUseSavedCriteria}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              Use Saved Criteria
            </Button>
          </div>

          {/* Preview intent display */}
          {previewIntent && (
            <div className="p-3 bg-blue-50 rounded-lg text-sm">
              <p className="font-medium text-blue-800 mb-1">AI Understanding:</p>
              {previewIntent.bedrooms == null &&
               previewIntent.bathrooms == null &&
               previewIntent.price == null &&
               !(previewIntent.areas?.length > 0) &&
               !(previewIntent.keywords?.length > 0) ? (
                <p className="text-blue-700">Type a description above to preview AI property matching</p>
              ) : (
                <p className="text-blue-700">
                  Looking for:{" "}
                  {previewIntent.bedrooms != null && (
                    <span>{previewIntent.bedrooms}+ bed</span>
                  )}
                  {previewIntent.bathrooms != null && (
                    <span>{previewIntent.bedrooms != null ? ", " : ""}{previewIntent.bathrooms}+ bath</span>
                  )}
                  {previewIntent.price != null && `${previewIntent.bedrooms != null || previewIntent.bathrooms != null ? ", " : ""}max $${previewIntent.price.toLocaleString()}`}
                  {previewIntent.areas?.length > 0 && (
                    `${previewIntent.bedrooms != null || previewIntent.bathrooms != null || previewIntent.price != null ? ", " : ""}in ${previewIntent.areas.join(", ")}`
                  )}
                  {previewIntent.keywords?.length > 0 && (
                    `${previewIntent.bedrooms != null || previewIntent.bathrooms != null || previewIntent.price != null || (previewIntent.areas?.length > 0) ? ", " : ""}${previewIntent.keywords.join(", ")}`
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Match results */}
        {matches.length > 0 && (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {matches.map((match) => (
              <div
                key={match.listing_id}
                className="p-3 bg-gray-50 rounded-lg border"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-sm">{match.address || "Property"}</p>
                    {match.price && (
                      <p className="text-sm text-muted-foreground">
                        ${match.price.toLocaleString()}
                      </p>
                    )}
                  </div>
                  {match.match_score !== undefined && (
                    <Badge className={getMatchScoreColor(match.match_score)}>
                      {match.match_score}% Match
                    </Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExplainMatch(match.listing_id)}
                    disabled={explainLoading === match.listing_id}
                  >
                    {explainLoading === match.listing_id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3 mr-1" />
                    )}
                    Why This Fits
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleFeedback(match.listing_id, "liked")}
                  >
                    <ThumbsUp className="h-3 w-3 mr-1" />
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleFeedback(match.listing_id, "disliked")}
                  >
                    <ThumbsDown className="h-3 w-3 mr-1" />
                    Not a Fit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeepAnalysis(match.listing_id)}
                    disabled={deepAnalysisLoading === match.listing_id}
                  >
                    {deepAnalysisLoading === match.listing_id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <FlaskConical className="h-3 w-3 mr-1" />
                    )}
                    Deep Analysis
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowingForm(match.listing_id)}
                  >
                    <Calendar className="h-3 w-3 mr-1" />
                    Schedule Showing
                  </Button>
                </div>

                {/* Deep analysis result */}
                {deepAnalysisResults[match.listing_id] && (
                  <div className="mt-3 p-3 bg-indigo-50 border border-indigo-100 rounded-md space-y-1.5">
                    <p className="text-xs font-semibold text-indigo-800 flex items-center gap-1">
                      <FlaskConical className="h-3 w-3" /> Deep Analysis
                    </p>
                    {deepAnalysisResults[match.listing_id].fit_summary && (
                      <p className="text-xs text-indigo-900">{deepAnalysisResults[match.listing_id].fit_summary}</p>
                    )}
                    {deepAnalysisResults[match.listing_id].strengths?.length > 0 && (
                      <ul className="space-y-0.5">
                        {deepAnalysisResults[match.listing_id].strengths.slice(0, 3).map((s: string, i: number) => (
                          <li key={i} className="flex items-start gap-1 text-xs text-emerald-700">
                            <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />{s}
                          </li>
                        ))}
                      </ul>
                    )}
                    {deepAnalysisResults[match.listing_id].concerns?.length > 0 && (
                      <ul className="space-y-0.5">
                        {deepAnalysisResults[match.listing_id].concerns.slice(0, 2).map((c: string, i: number) => (
                          <li key={i} className="flex items-start gap-1 text-xs text-amber-700">
                            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />{c}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Explanation panel */}
                {selectedMatch === match.listing_id && explanation && (
                  <div className="mt-3 p-2 bg-white rounded border text-sm">
                    {explanation}
                  </div>
                )}

                {/* Showing form */}
                {showingForm === match.listing_id && (
                  <div className="mt-3 p-3 bg-white rounded border space-y-2">
                    <Input
                      type="datetime-local"
                      value={showingDate}
                      onChange={(e) => setShowingDate(e.target.value)}
                      placeholder="Preferred date/time"
                    />
                    <Textarea
                      placeholder="Notes for the showing..."
                      value={showingNotes}
                      onChange={(e) => setShowingNotes(e.target.value)}
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleScheduleShowing(match)}
                        disabled={showingLoading || !showingDate}
                      >
                        {showingLoading ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          "Request Showing"
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowingForm(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Send match email button */}
        {matches.length > 0 && (
          <div className="pt-2">
            <Button
              size="sm"
              variant="default"
              className="w-full gap-1.5"
              disabled={emailLoading}
              onClick={async () => {
                setEmailLoading(true)
                try {
                  const matchSummary = matches.slice(0, 5).map(m =>
                    `${m.address || "Property"} – $${m.price?.toLocaleString() ?? "N/A"}`
                  ).join("\n")
                  const draft = await draftSmartEmail(
                    contactId,
                    `Found ${matches.length} properties that match ${firstName}'s search criteria:\n${matchSummary}\nDraft a personalized email introducing these properties and inviting them to schedule showings.`
                  )
                  setEmailDraft(draft)
                  setEmailDialogOpen(true)
                } catch {
                  toast.error("Could not generate email draft")
                } finally {
                  setEmailLoading(false)
                }
              }}
            >
              {emailLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
              Email {firstName} about {matches.length} Match{matches.length !== 1 ? "es" : ""}
            </Button>
          </div>
        )}

        {/* Email draft dialog */}
        <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>AI-Drafted Email to {firstName}</DialogTitle>
            </DialogHeader>
            <Textarea
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              rows={10}
              className="text-sm"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setEmailDialogOpen(false)}>Cancel</Button>
              <Button
                disabled={sendingEmail}
                onClick={async () => {
                  setSendingEmail(true)
                  try {
                    const result = await sendEmail({
                      contactId,
                      subject: `Properties Matched for You, ${firstName}`,
                      html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(emailDraft)}</pre>`,
                      text: emailDraft,
                      channelPurpose: "conversation",
                    })
                    if (result.success) {
                      toast.success("Email sent")
                      setEmailDialogOpen(false)
                    } else {
                      toast.error((result as any).error ?? "Send failed")
                    }
                  } finally {
                    setSendingEmail(false)
                  }
                }}
              >
                {sendingEmail ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                Send Email
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Empty state */}
        {matches.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No saved criteria yet. Describe what {firstName} is looking for above.
          </p>
        )}

        {/* Property Alerts collapsible */}
        {brokerageId && (
          <PropertyAlertsPanel
            contactId={contactId}
            brokerageId={brokerageId}
            agentId={agentId}
          />
        )}
      </CardContent>
    </Card>
  )
}
