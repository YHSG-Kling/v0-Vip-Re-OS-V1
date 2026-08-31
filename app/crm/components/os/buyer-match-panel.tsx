"use client"

import { useState, useRef } from "react"
import ReactMarkdown from "react-markdown"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Home, Search, Loader2, ThumbsUp, ThumbsDown, Calendar, Eye, Sparkles, Bell, CheckCircle2, AlertCircle, Send } from "lucide-react"
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
import { searchAndPushToBuyer } from "@/app/actions/ai-buyer-search-push"
import { sendFirstLookText } from "@/app/actions/instant-property-alerts"
import { requestShowing } from "@/app/actions/smart-insights"
import { updateContact } from "@/app/actions/contacts"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { draftSmartEmail } from "@/app/actions/ai-insights"
import { sendEmail } from "@/app/actions/communications"
import { PropertyAlertsPanel } from "./property-alerts-panel"
import { BUYER_STAGES, BUYER_STAGE_LABELS, isBuyerStage } from "@/lib/contacts/buyer-stage"

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// TOMBSTONE (§6) — a local seven-value stage list (new / nurturing / active /
// qualified / under_contract / closed / lost) stood here and fed the Select
// below, which writes contacts.buyer_stage. The live CHECK on that column
// admits ONLY the thirteen BUYER_* ladder tokens (scripts/check-vocabularies.ts,
// contacts.buyer_stage), so Postgres refused EVERY value this dropdown ever
// offered (23514) — the toast said "Failed to update stage" on each attempt,
// and this control has likely never saved once. SURVIVOR:
// lib/contacts/buyer-stage.ts — BUYER_STAGES (the CHECK-matched ladder) and
// BUYER_STAGE_LABELS (the wording), the same module whose header records two
// server-side consumers failing the identical silent way on invented spellings.

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
  // A stored value outside the ladder (legacy spelling, or null) renders the
  // placeholder rather than a phantom selection the CHECK would refuse to save.
  const [stage, setStage] = useState(isBuyerStage(buyerStage) ? buyerStage : "")
  // Generation counter to handle rapid stage changes — only apply result from latest request
  const stageGenRef = useRef(0)
  const [query, setQuery] = useState("")
  const [emailDialogOpen, setEmailDialogOpen] = useState(false)
  const [emailDraft, setEmailDraft] = useState("")
  const [emailLoading, setEmailLoading] = useState(false)
  const [sendingEmail, setSendingEmail] = useState(false)
  const [previewIntent, setPreviewIntent] = useState<any>(null)
  const [matches, setMatches] = useState<PropertyMatch[]>([])
  const [showingForm, setShowingForm] = useState<string | null>(null)
  const [showingDate, setShowingDate] = useState("")
  const [showingNotes, setShowingNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showingLoading, setShowingLoading] = useState(false)
  // First-look SMS (immediate text preview of a single listing to the buyer)
  const [textingId, setTextingId] = useState<string | null>(null)
  // Notify new matches
  const [notifyLoading, setNotifyLoading] = useState(false)
  const [notifyResult, setNotifyResult] = useState<{ notified: number } | null>(null)
  // Send search results to buyer portal
  const [pushLoading, setPushLoading] = useState(false)
  const [pushResult, setPushResult] = useState<{ matchCount: number } | null>(null)
  // Analysis Sheet
  const [analysisSheetMatch, setAnalysisSheetMatch] = useState<PropertyMatch | null>(null)
  const [analysisSheetLoading, setAnalysisSheetLoading] = useState(false)
  const [analysisSheetData, setAnalysisSheetData] = useState<{ explanation: string | null; deep: any | null }>(
    { explanation: null, deep: null }
  )

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

  const handleFirstLookText = async (match: PropertyMatch) => {
    setTextingId(match.listing_id)
    try {
      const res = await sendFirstLookText({ contactId, listingId: match.listing_id })
      if (res.success) {
        toast.success(`First-look text sent to ${firstName}`)
      } else {
        const reason: Record<string, string> = {
          no_phone_on_file: "No phone number on file for this buyer.",
          consent_blocked: "This buyer has opted out of SMS or is on the DNC list.",
          contact_not_found: "Buyer record not found.",
          unauthenticated: "Please sign in again.",
        }
        toast.error(reason[res.error ?? ""] ?? "Could not send the text.")
      }
    } catch {
      toast.error("Could not send the text.")
    } finally {
      setTextingId(null)
    }
  }

  const handleOpenAnalysisSheet = async (match: PropertyMatch) => {
    setAnalysisSheetMatch(match)
    setAnalysisSheetData({ explanation: null, deep: null })
    setAnalysisSheetLoading(true)
    try {
      const [explainRes, deepRes] = await Promise.all([
        explainPropertyMatchForBuyer({ contactId, listingId: match.listing_id }),
        analyzePropertyForBuyer({ contactId, propertyId: match.listing_id, agentId }),
      ])
      const expl = (explainRes as any).explanation
      const explanationText =
        typeof expl === "string" ? expl
        : expl && typeof expl === "object" ? (expl.narrative ?? expl.headline ?? null)
        : null
      const deepData = deepRes.success ? deepRes : null
      setAnalysisSheetData({ explanation: explanationText, deep: deepData })
    } catch (err) {
      console.error("Analysis sheet fetch failed:", err)
    } finally {
      setAnalysisSheetLoading(false)
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

  const handlePushToBuyer = async () => {
    if (!query.trim()) return
    setPushLoading(true)
    setPushResult(null)
    try {
      const result = await searchAndPushToBuyer({
        contactId,
        searchQuery: query,
      })
      if (result.success) {
        setPushResult({ matchCount: result.matchCount })
        toast.success(`${result.matchCount} propert${result.matchCount !== 1 ? "ies" : "y"} pushed to ${contactName}'s portal.`)
      }
    } catch {
      toast.error("Push failed. Try again.")
    } finally {
      setPushLoading(false)
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
                <SelectItem key={s} value={s} className="text-xs">{BUYER_STAGE_LABELS[s]}</SelectItem>
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
            <Button
              variant="outline"
              size="sm"
              onClick={handlePushToBuyer}
              disabled={pushLoading || !query.trim()}
              title="Run this search and push results to the buyer's portal"
            >
              {pushLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : pushResult ? (
                <CheckCircle2 className="h-4 w-4 mr-1 text-emerald-500" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {pushResult
                ? `Sent (${pushResult.matchCount})`
                : "Send to Buyer"}
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
                    onClick={() => handleOpenAnalysisSheet(match)}
                  >
                    <Sparkles className="h-3 w-3 mr-1" />
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
                    onClick={() => setShowingForm(match.listing_id)}
                  >
                    <Calendar className="h-3 w-3 mr-1" />
                    Schedule Showing
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleFirstLookText(match)}
                    disabled={textingId === match.listing_id}
                    title="Text an immediate first-look preview of this property to the buyer (SMS, consent-checked)"
                  >
                    {textingId === match.listing_id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Send className="h-3 w-3 mr-1" />
                    )}
                    Text First Look
                  </Button>
                </div>


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

      {/* Analysis Sheet */}
      <Sheet open={!!analysisSheetMatch} onOpenChange={(v) => { if (!v) setAnalysisSheetMatch(null) }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader className="pb-4 border-b">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-blue-600" />
              {analysisSheetMatch?.address || "Property"} — Match Analysis
            </SheetTitle>
            {analysisSheetMatch?.price && (
              <p className="text-sm text-muted-foreground">
                ${analysisSheetMatch.price.toLocaleString()}
                {analysisSheetMatch.match_score != null && (
                  <span className="ml-2 font-medium text-foreground">{analysisSheetMatch.match_score}% match</span>
                )}
              </p>
            )}
          </SheetHeader>

          {analysisSheetLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing this property for {firstName}…
            </div>
          )}

          {!analysisSheetLoading && (
            <div className="space-y-5 pt-4">
              {/* Why This Fits narrative */}
              {analysisSheetData.explanation && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why This Fits</p>
                  <div className="text-sm text-foreground [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5">
                    <ReactMarkdown>{analysisSheetData.explanation}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Pros */}
              {analysisSheetData.deep?.strengths?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strengths</p>
                  <ul className="space-y-1">
                    {analysisSheetData.deep.strengths.map((s: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
                        <span className="[&_p]:inline"><ReactMarkdown>{s}</ReactMarkdown></span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Cons */}
              {analysisSheetData.deep?.concerns?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Potential Concerns</p>
                  <ul className="space-y-1">
                    {analysisSheetData.deep.concerns.map((c: string, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                        <span className="[&_p]:inline"><ReactMarkdown>{c}</ReactMarkdown></span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Questions to ask */}
              {analysisSheetData.deep?.questions?.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Questions to Ask</p>
                  <ul className="space-y-1">
                    {analysisSheetData.deep.questions.map((q: string, i: number) => (
                      <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                        <span className="font-medium text-foreground shrink-0">{i + 1}.</span>
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Negotiation tips */}
              {analysisSheetData.deep?.negotiation_tips && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Negotiation Tips</p>
                  <div className="text-sm text-foreground [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5">
                    <ReactMarkdown>
                      {typeof analysisSheetData.deep.negotiation_tips === "string"
                        ? analysisSheetData.deep.negotiation_tips
                        : Array.isArray(analysisSheetData.deep.negotiation_tips)
                        ? analysisSheetData.deep.negotiation_tips.join("\n")
                        : ""}
                    </ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Fit summary fallback */}
              {analysisSheetData.deep?.fit_summary && !analysisSheetData.explanation && (
                <div className="p-3 bg-muted/50 rounded-md text-sm">
                  {analysisSheetData.deep.fit_summary}
                </div>
              )}

              {/* No data fallback */}
              {!analysisSheetData.explanation && !analysisSheetData.deep && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No analysis data available for this property.
                </p>
              )}

              {/* Request Showing CTA */}
              <div className="pt-2 border-t">
                <Button
                  className="w-full gap-2"
                  onClick={() => {
                    setAnalysisSheetMatch(null)
                    if (analysisSheetMatch) setShowingForm(analysisSheetMatch.listing_id)
                  }}
                >
                  <Calendar className="h-4 w-4" />
                  Request a Showing
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  )
}
