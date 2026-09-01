// CANONICAL — always import LeadIntelligencePanel from this path.
// The backwards-compat re-export that used to sit at
// app/components/features/intelligence/LeadIntelligencePanel.tsx is GONE (the
// directory no longer exists; verified 2026-09-01 — the only surviving mention
// of that path in the tree was this comment, and the one importer is
// app/leads/page.tsx:94, which already points here). Kept as a tombstone so the
// path is not re-created.
"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Brain, TrendingUp, Home, MapPin, RefreshCw, Loader2, DollarSign, Calendar } from "lucide-react"
import { enrichLeadData } from "@/app/actions/lead-intelligence"
import { useToast } from "@/hooks/use-toast"
import { timelineLabel } from "@/constants/crm-standards"

export default function LeadIntelligencePanel({ leadId, initialData }: { leadId: string; initialData?: any }) {
  const [intelligence, setIntelligence] = useState<any>(initialData || null)
  const [isEnriching, setIsEnriching] = useState(false)
  const { toast } = useToast()

  // Enrichment CONSUMES ITS RESULT instead of reloading the page.
  //
  // What was here: `window.location.reload()`. On the one page that renders this
  // panel (app/leads/page.tsx:1832) the panel is shown only while
  // `selectedLeadId` is set — client state — so a full reload did not "reload
  // intelligence data" at all: it threw away the selection and CLOSED the panel,
  // along with every filter, tab and scroll position on the page.
  //
  // What it can consume, and what it cannot. `enrichLeadData` (app/actions/
  // lead-intelligence.ts:758) returns `{ success: true, dataSources }` or
  // `{ success: false, error }` — `dataSources` is exactly the list rendered as
  // the "Data Sources" badges below, so that half is fed straight back into
  // state. It returns NO refreshed profile, and there is no reader anywhere in
  // the tree that returns this panel's shape (a `lead_intelligence` row with its
  // lead_engagement_scores / lead_property_ownership / motivated_seller_signals
  // children), so the recomputed scores cannot be pulled without BUILDING that
  // reader — a change inside app/actions/lead-intelligence.ts, which this lane
  // does not own. Until it exists the honest thing is to say the scores land on
  // the next load rather than silently show stale numbers under a success toast.
  const handleEnrich = async () => {
    setIsEnriching(true)
    try {
      const result = await enrichLeadData(leadId)
      if (result.success) {
        const dataSources = (result as { dataSources?: string[] }).dataSources ?? []
        setIntelligence((prev: any) => ({
          ...(prev ?? {}),
          data_sources: dataSources,
          last_enriched_at: new Date().toISOString(),
        }))
        toast({
          title: "Lead data enriched",
          description: dataSources.length
            ? `Consulted: ${dataSources.join(", ")}. Updated scores appear on the next load.`
            : "No external source returned data for this lead.",
        })
      } else {
        toast({ title: "Enrichment failed", description: result.error, variant: "destructive" })
      }
    } catch (error) {
      toast({ title: "Enrichment failed", variant: "destructive" })
    }
    setIsEnriching(false)
  }

  if (!intelligence) {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading intelligence data...</p>
        </CardContent>
      </Card>
    )
  }

  const engagement = intelligence.lead_engagement_scores?.[0]
  const property = intelligence.lead_property_ownership?.[0]
  const signals = intelligence.motivated_seller_signals || []

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-green-600" />
              Motivation Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{intelligence.motivation_score || 0}</div>
            <Progress value={intelligence.motivation_score || 0} className="mt-2 bg-green-100" />
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Brain className="w-4 h-4 text-blue-600" />
              Qualification Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">{intelligence.qualification_score || 0}</div>
            <Progress value={intelligence.qualification_score || 0} className="mt-2 bg-blue-100" />
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-violet-50 border-purple-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-purple-600" />
              Engagement Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-purple-600">{engagement?.overall_score || 0}</div>
            <Progress value={engagement?.overall_score || 0} className="mt-2 bg-purple-100" />
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Lead Type</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="default" className="text-base mb-2">
              {intelligence.buyer_seller_type || "Unknown"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={handleEnrich}
              disabled={isEnriching}
              className="w-full border-amber-300 bg-transparent"
            >
              {isEnriching ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Enriching...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Enrich Data
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Tabs */}
      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="bg-muted">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="property">Property Data</TabsTrigger>
          <TabsTrigger value="signals">Seller Signals ({signals.length})</TabsTrigger>
          <TabsTrigger value="engagement">Engagement</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Lead Profile & Preferences</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-green-600" />
                    Price Range
                  </h4>
                  <p className="text-sm">{intelligence.price_range || "Not specified"}</p>
                </div>
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-blue-600" />
                    Timeline
                  </h4>
                  {/* Canonical bucket label (constants/crm-standards.ts TIMELINE_LABELS) —
                      the raw value ("1-3_months") was rendered verbatim before. */}
                  <Badge>{timelineLabel(intelligence.timeline) || "Unknown"}</Badge>
                </div>
              </div>

              {intelligence.property_type?.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Property Types</h4>
                  <div className="flex flex-wrap gap-2">
                    {intelligence.property_type.map((type: string) => (
                      <Badge key={type} variant="outline">
                        {type}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {intelligence.location_preferences?.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-red-600" />
                    Location Preferences
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {intelligence.location_preferences.map((loc: string) => (
                      <Badge key={loc} variant="secondary">
                        {loc}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {intelligence.data_sources?.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2">Data Sources</h4>
                  <div className="flex flex-wrap gap-2">
                    {intelligence.data_sources.map((source: string) => (
                      <Badge key={source} variant="outline" className="text-xs">
                        {source}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="property" className="space-y-4">
          {property ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Home className="w-5 h-5 text-blue-600" />
                  Property Ownership
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold mb-2 text-muted-foreground">Address</h4>
                  <p className="font-medium">{property.property_address}</p>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center p-4 bg-green-50 rounded-lg border border-green-200">
                    <h4 className="text-xs font-semibold mb-1 text-muted-foreground">Estimated Value</h4>
                    <p className="text-2xl font-bold text-green-600">
                      ${property.estimated_value?.toLocaleString() || "N/A"}
                    </p>
                  </div>
                  <div className="text-center p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="text-xs font-semibold mb-1 text-muted-foreground">Equity</h4>
                    <p className="text-2xl font-bold text-blue-600">
                      ${property.equity_estimate?.toLocaleString() || "N/A"}
                    </p>
                  </div>
                  <div className="text-center p-4 bg-purple-50 rounded-lg border border-purple-200">
                    <h4 className="text-xs font-semibold mb-1 text-muted-foreground">Ownership</h4>
                    <p className="text-2xl font-bold text-purple-600">
                      {Math.floor((property.ownership_length_months || 0) / 12)} years
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-4 text-sm bg-muted/50 p-4 rounded-lg">
                  <div>
                    <span className="text-muted-foreground text-xs">Beds:</span>
                    <p className="font-medium text-lg">{property.property_details?.bedrooms || "N/A"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Baths:</span>
                    <p className="font-medium text-lg">{property.property_details?.bathrooms || "N/A"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Sqft:</span>
                    <p className="font-medium text-lg">{property.property_details?.sqft?.toLocaleString() || "N/A"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Built:</span>
                    <p className="font-medium text-lg">{property.property_details?.year_built || "N/A"}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <Home className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No property ownership data available</p>
                <Button onClick={handleEnrich} variant="outline" className="mt-4 bg-transparent">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Enrich to Find Property Data
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="signals" className="space-y-4">
          {signals.length > 0 ? (
            <div className="grid gap-4">
              {signals.map((signal: any) => (
                <Card key={signal.id} className="border-l-4 border-l-orange-500">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{signal.signal_type.replace("_", " ")}</CardTitle>
                      <Badge
                        variant={
                          signal.signal_strength === "urgent"
                            ? "destructive"
                            : signal.signal_strength === "strong"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {signal.signal_strength}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-2">{signal.signal_details.reason}</p>
                    <div className="text-xs text-muted-foreground">
                      Detected via: <span className="font-medium">{signal.detected_via}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <TrendingUp className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No motivated seller signals detected</p>
                <Button onClick={handleEnrich} variant="outline" className="mt-4 bg-transparent">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Run Enrichment to Detect Signals
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="engagement" className="space-y-4">
          {engagement ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Email Engagement</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.email_engagement_score}</div>
                  <Progress value={engagement.email_engagement_score} className="mt-2" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Property Views</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.property_view_score}</div>
                  <Progress value={engagement.property_view_score} className="mt-2" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Communication</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.communication_score}</div>
                  <Progress value={engagement.communication_score} className="mt-2" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Search Activity</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.search_activity_score}</div>
                  <Progress value={engagement.search_activity_score} className="mt-2" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Recency</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.recency_score}</div>
                  <Progress value={engagement.recency_score} className="mt-2" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Frequency</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{engagement.frequency_score}</div>
                  <Progress value={engagement.frequency_score} className="mt-2" />
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <Brain className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No engagement data available</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
