"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { TrendingUp, MapPin, Calendar, DollarSign, Home, Users, Target } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

export default function LeadInsightsPanel({ lead }: { lead: any }) {
  const intelligence = lead.lead_intelligence?.[0]
  const behavioralData = lead.lead_behavioral_data?.[0]

  return (
    <Card className="bg-background border">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2 text-foreground">
          <Target className="w-4 h-4 text-green-600" />
          Lead Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Basic Info */}
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              Location
            </span>
            <span className="font-medium text-foreground">
              {lead.city}, {lead.state}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Last Contact
            </span>
            <span className="font-medium text-foreground">
              {lead.last_contacted_at
                ? formatDistanceToNow(new Date(lead.last_contacted_at), { addSuffix: true })
                : "Never"}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Users className="w-3 h-3" />
              Source
            </span>
            <Badge variant="outline" className="text-xs">
              {lead.lead_source}
            </Badge>
          </div>
        </div>

        <Separator />

        {/* Intelligence Data */}
        {intelligence && (
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-foreground">Buyer/Seller Profile</h4>

            {intelligence.identified_interests?.length > 0 && (
              <div>
                <span className="text-xs text-muted-foreground">Interests:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {intelligence.identified_interests.map((interest: string) => (
                    <Badge key={interest} variant="secondary" className="text-xs">
                      {interest}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {intelligence.price_range && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1">
                  <DollarSign className="w-3 h-3" />
                  Price Range
                </span>
                <span className="font-medium text-foreground">{intelligence.price_range}</span>
              </div>
            )}

            {intelligence.property_type && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Home className="w-3 h-3" />
                  Property Type
                </span>
                <span className="font-medium text-foreground">{intelligence.property_type}</span>
              </div>
            )}

            {intelligence.timeline && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Timeline
                </span>
                <span className="font-medium text-foreground">{intelligence.timeline}</span>
              </div>
            )}
          </div>
        )}

        {/* Behavioral Signals */}
        {behavioralData && (
          <>
            <Separator />
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">Behavioral Signals</h4>

              {behavioralData.engagement_score !== undefined && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Engagement</span>
                  <Badge variant={behavioralData.engagement_score > 70 ? "default" : "secondary"}>
                    {behavioralData.engagement_score}%
                  </Badge>
                </div>
              )}

              {behavioralData.intent_signals?.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground">Intent Signals:</span>
                  <ul className="text-xs mt-1 space-y-1">
                    {behavioralData.intent_signals.map((signal: string, idx: number) => (
                      <li key={idx} className="flex items-center gap-1 text-foreground">
                        <TrendingUp className="w-3 h-3 text-green-600" />
                        {signal}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}

        {/* Quick Actions */}
        <Separator />
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">Recommended Actions</h4>
          <div className="space-y-1 text-xs">
            {lead.lead_temperature === "hot" && (
              <p className="text-green-600">✓ High priority - reach out immediately</p>
            )}
            {lead.lead_temperature === "cold" && <p className="text-orange-600">! Use email or print mail only</p>}
            {intelligence?.timeline === "immediate" && (
              <p className="text-blue-600">✓ Ready to move - schedule showing</p>
            )}
            {!lead.last_contacted_at && <p className="text-gray-600">• First contact - use introduction template</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
