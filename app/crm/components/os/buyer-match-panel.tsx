"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
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

interface BuyerMatchPanelProps {
  contactId: string
  agentId: string
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
  isBuyerContact,
  buyerStage,
  contactName,
}: BuyerMatchPanelProps) {
  const [query, setQuery] = useState("")
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
        <CardTitle className="text-base flex items-center gap-2">
          <Home className="h-4 w-4 text-blue-600" />
          Find Homes for {firstName}
        </CardTitle>
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
              <p className="text-blue-700">
                Looking for: {previewIntent.bedrooms}+ bed
                {previewIntent.price && `, max $${previewIntent.price.toLocaleString()}`}
                {previewIntent.areas?.length > 0 && `, in ${previewIntent.areas.join(", ")}`}
                {previewIntent.keywords?.length > 0 && `, ${previewIntent.keywords.join(", ")}`}
              </p>
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

        {/* Empty state */}
        {matches.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No saved criteria yet. Describe what {firstName} is looking for above.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
