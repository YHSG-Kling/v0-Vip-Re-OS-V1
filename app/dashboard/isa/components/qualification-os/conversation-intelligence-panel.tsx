"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  MessageSquare,
  AlertTriangle,
  Heart,
  Clock,
  DollarSign,
  ThumbsUp,
  Sparkles,
  ChevronRight,
  User,
} from "lucide-react"

interface ConversationSignal {
  type: "objection" | "motivation" | "urgency" | "financing" | "sentiment"
  text: string
  confidence: number
}

interface ConversationIntelligence {
  id: string
  contactId: string
  contactName: string
  transcriptSummary: string
  topObjections: string[]
  motivationSignals: string[]
  urgencyClues: string[]
  financingClues: string[]
  sentiment: "positive" | "neutral" | "negative"
  confidenceScore: number
  recommendedNextAction: string
  createdAt: string
}

interface ConversationIntelligencePanelProps {
  conversations: ConversationIntelligence[]
  onViewConversation?: (conversationId: string) => void
}

function getSentimentBadge(sentiment: string) {
  switch (sentiment) {
    case "positive":
      return <Badge className="bg-green-100 text-green-700 border-green-200">Positive</Badge>
    case "negative":
      return <Badge className="bg-red-100 text-red-700 border-red-200">Negative</Badge>
    default:
      return <Badge className="bg-gray-100 text-gray-700 border-gray-200">Neutral</Badge>
  }
}

export function ConversationIntelligencePanel({
  conversations,
  onViewConversation,
}: ConversationIntelligencePanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-indigo-600" />
          Conversation Intelligence
          {conversations.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {conversations.length} analyzed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageSquare className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No conversation data yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Intelligence builds as AI engages with leads
            </p>
          </div>
        ) : (
          <ScrollArea className="h-[320px]">
            <div className="space-y-3 pr-2">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className="border rounded-lg p-3 bg-card hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                        <User className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{conv.contactName}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(conv.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {getSentimentBadge(conv.sentiment)}
                      <Badge variant="outline" className="text-xs">
                        {conv.confidenceScore}%
                      </Badge>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                    {conv.transcriptSummary}
                  </p>

                  {expandedId === conv.id && (
                    <div className="mt-3 space-y-2 pt-3 border-t">
                      {conv.topObjections.length > 0 && (
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-amber-700">Top Objections</p>
                            <ul className="text-xs text-muted-foreground mt-0.5">
                              {conv.topObjections.slice(0, 3).map((obj, i) => (
                                <li key={i}>- {obj}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

                      {conv.motivationSignals.length > 0 && (
                        <div className="flex items-start gap-2">
                          <Heart className="h-3.5 w-3.5 text-pink-600 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-pink-700">Motivation Signals</p>
                            <ul className="text-xs text-muted-foreground mt-0.5">
                              {conv.motivationSignals.slice(0, 3).map((sig, i) => (
                                <li key={i}>+ {sig}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

                      {conv.urgencyClues.length > 0 && (
                        <div className="flex items-start gap-2">
                          <Clock className="h-3.5 w-3.5 text-orange-600 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-orange-700">Urgency/Timeline</p>
                            <ul className="text-xs text-muted-foreground mt-0.5">
                              {conv.urgencyClues.slice(0, 2).map((clue, i) => (
                                <li key={i}>{clue}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

                      {conv.financingClues.length > 0 && (
                        <div className="flex items-start gap-2">
                          <DollarSign className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs font-medium text-green-700">Financing Clues</p>
                            <ul className="text-xs text-muted-foreground mt-0.5">
                              {conv.financingClues.slice(0, 2).map((clue, i) => (
                                <li key={i}>{clue}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

                      <div className="flex items-start gap-2 pt-2 border-t mt-2">
                        <Sparkles className="h-3.5 w-3.5 text-indigo-600 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-indigo-700">Recommended Next Action</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {conv.recommendedNextAction}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setExpandedId(expandedId === conv.id ? null : conv.id)}
                    >
                      {expandedId === conv.id ? "Show Less" : "Show Details"}
                    </Button>
                    {onViewConversation && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => onViewConversation(conv.id)}
                      >
                        View Full
                        <ChevronRight className="h-3 w-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
