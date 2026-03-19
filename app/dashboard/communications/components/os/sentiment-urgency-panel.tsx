"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { 
  TrendingUp, 
  TrendingDown, 
  Minus,
  AlertTriangle,
  Heart,
  Frown,
  Meh,
  Smile,
  ArrowRight
} from "lucide-react"

interface SentimentItem {
  id: string
  contactName: string
  contactId: string
  sentiment: "very_positive" | "positive" | "neutral" | "negative" | "very_negative"
  urgency: "critical" | "high" | "medium" | "low"
  trend: "improving" | "stable" | "declining"
  lastMessage: string
  requiresAction: boolean
}

interface SentimentUrgencyPanelProps {
  items: SentimentItem[]
  onViewConversation: (contactId: string) => void
  onPrioritize: (contactId: string) => void
}

export function SentimentUrgencyPanel({
  items,
  onViewConversation,
  onPrioritize,
}: SentimentUrgencyPanelProps) {
  const getSentimentIcon = (sentiment: string) => {
    switch (sentiment) {
      case "very_positive": return <Heart className="h-4 w-4 text-green-600" />
      case "positive": return <Smile className="h-4 w-4 text-green-500" />
      case "neutral": return <Meh className="h-4 w-4 text-gray-500" />
      case "negative": return <Frown className="h-4 w-4 text-amber-500" />
      case "very_negative": return <AlertTriangle className="h-4 w-4 text-destructive" />
      default: return <Meh className="h-4 w-4" />
    }
  }

  const getTrendIcon = (trend: string) => {
    switch (trend) {
      case "improving": return <TrendingUp className="h-3 w-3 text-green-600" />
      case "declining": return <TrendingDown className="h-3 w-3 text-destructive" />
      default: return <Minus className="h-3 w-3 text-muted-foreground" />
    }
  }

  const getSentimentColor = (sentiment: string) => {
    switch (sentiment) {
      case "very_positive":
      case "positive": return "bg-green-500"
      case "neutral": return "bg-gray-400"
      case "negative": return "bg-amber-500"
      case "very_negative": return "bg-destructive"
      default: return "bg-gray-400"
    }
  }

  const getSentimentScore = (sentiment: string) => {
    switch (sentiment) {
      case "very_positive": return 100
      case "positive": return 75
      case "neutral": return 50
      case "negative": return 25
      case "very_negative": return 10
      default: return 50
    }
  }

  // Group by urgency
  const criticalItems = items.filter(i => i.urgency === "critical" || i.sentiment === "very_negative")
  const attentionItems = items.filter(i => i.requiresAction && !criticalItems.includes(i))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          Sentiment & Urgency
        </CardTitle>
        <CardDescription>Client emotional temperature and attention needs</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center p-2 bg-destructive/10 rounded-lg">
            <div className="text-2xl font-bold text-destructive">{criticalItems.length}</div>
            <div className="text-xs text-muted-foreground">Critical</div>
          </div>
          <div className="text-center p-2 bg-amber-500/10 rounded-lg">
            <div className="text-2xl font-bold text-amber-600">{attentionItems.length}</div>
            <div className="text-xs text-muted-foreground">Needs Attention</div>
          </div>
          <div className="text-center p-2 bg-green-500/10 rounded-lg">
            <div className="text-2xl font-bold text-green-600">
              {items.filter(i => i.sentiment === "positive" || i.sentiment === "very_positive").length}
            </div>
            <div className="text-xs text-muted-foreground">Positive</div>
          </div>
        </div>

        <ScrollArea className="h-[300px]">
          <div className="space-y-3">
            {items.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Smile className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No sentiment data available yet.</p>
              </div>
            ) : (
              items
                .sort((a, b) => {
                  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 }
                  return urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
                })
                .map((item) => (
                  <div
                    key={item.id}
                    className={`p-3 rounded-lg border ${
                      item.urgency === "critical" || item.sentiment === "very_negative" 
                        ? "border-destructive bg-destructive/5" 
                        : "bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {getSentimentIcon(item.sentiment)}
                        <span className="font-medium">{item.contactName}</span>
                        {getTrendIcon(item.trend)}
                      </div>
                      <Badge variant={item.urgency === "critical" ? "destructive" : "secondary"}>
                        {item.urgency}
                      </Badge>
                    </div>
                    
                    <div className="mb-2">
                      <Progress 
                        value={getSentimentScore(item.sentiment)} 
                        className="h-2"
                      />
                    </div>
                    
                    <p className="text-sm text-muted-foreground truncate mb-2">
                      {item.lastMessage}
                    </p>
                    
                    <div className="flex gap-2">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        onClick={() => onViewConversation(item.contactId)}
                        className="flex-1"
                      >
                        View
                        <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                      {item.requiresAction && (
                        <Button 
                          size="sm"
                          onClick={() => onPrioritize(item.contactId)}
                        >
                          Prioritize
                        </Button>
                      )}
                    </div>
                  </div>
                ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
