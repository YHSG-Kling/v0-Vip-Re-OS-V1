"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TrendingUp, AlertCircle, CheckCircle } from "lucide-react"

export default function ThemFirstCoach({ score, message }: { score: number; message: string }) {
  const [liveScore, setLiveScore] = useState(score)
  const [analysis, setAnalysis] = useState<any>(null)

  useEffect(() => {
    if (message) {
      analyzeLiveMessage(message)
    }
  }, [message])

  const analyzeLiveMessage = (msg: string) => {
    const themFirstTerms = ["you deserve", "your goals", "your needs", "for you", "your situation"]
    const agentFirstTerms = ["I can", "I will", "my service", "my expertise", "hire me"]

    const msgLower = msg.toLowerCase()
    const themCount = themFirstTerms.filter((term) => msgLower.includes(term)).length
    const agentCount = agentFirstTerms.filter((term) => msgLower.includes(term)).length

    const newScore = Math.min(100, Math.max(0, 50 + themCount * 10 - agentCount * 15))

    setLiveScore(newScore)

    const suggestions: string[] = []
    if (agentCount > themCount) {
      suggestions.push('Try replacing "I can help" with "You deserve expert guidance"')
      suggestions.push("Focus on what the client gains, not what you provide")
    }
    if (msgLower.includes("my")) {
      suggestions.push('Replace "my services" with "the support you need"')
    }

    setAnalysis({ themCount, agentCount, suggestions })
  }

  const getScoreColor = (s: number) => {
    if (s >= 70) return "text-green-600"
    if (s >= 50) return "text-yellow-600"
    return "text-red-600"
  }

  const getScoreLabel = (s: number) => {
    if (s >= 70) return "Excellent"
    if (s >= 50) return "Good"
    return "Needs Improvement"
  }

  return (
    <Card className="bg-background border">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2 text-foreground">
          <TrendingUp className="w-4 h-4" />
          Them-First Coach
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current Score */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground">Current Message Score</span>
            <Badge variant={liveScore >= 70 ? "default" : liveScore >= 50 ? "secondary" : "destructive"}>
              {getScoreLabel(liveScore)}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <Progress value={liveScore} className="flex-1" />
            <span className={`text-2xl font-bold ${getScoreColor(liveScore)}`}>{liveScore}</span>
          </div>
        </div>

        {/* Analysis */}
        {analysis && message && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-green-50 p-2 rounded">
                <div className="flex items-center gap-1 text-green-700">
                  <CheckCircle className="w-3 h-3" />
                  <span className="font-medium">Them-First</span>
                </div>
                <div className="text-2xl font-bold text-green-600">{analysis.themCount}</div>
              </div>
              <div className="bg-red-50 p-2 rounded">
                <div className="flex items-center gap-1 text-red-700">
                  <AlertCircle className="w-3 h-3" />
                  <span className="font-medium">Agent-First</span>
                </div>
                <div className="text-2xl font-bold text-red-600">{analysis.agentCount}</div>
              </div>
            </div>

            {/* Suggestions */}
            {analysis.suggestions.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-foreground">Suggestions for Improvement:</h4>
                {analysis.suggestions.map((sug: string, idx: number) => (
                  <Alert key={idx}>
                    <TrendingUp className="h-4 w-4" />
                    <AlertDescription className="text-xs">{sug}</AlertDescription>
                  </Alert>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Session Average */}
        <div className="pt-3 border-t">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Session Average</span>
            <span className={`font-bold ${getScoreColor(score)}`}>{score}</span>
          </div>
        </div>

        {/* Tips */}
        <div className="bg-blue-50 p-3 rounded-lg">
          <h4 className="text-sm font-semibold mb-2 text-blue-900">Quick Tips:</h4>
          <ul className="text-xs space-y-1 text-blue-800">
            <li>• Replace "I can help" → "You deserve expert guidance"</li>
            <li>• Replace "My expertise" → "The support you need"</li>
            <li>• Replace "I will" → "You'll have access to"</li>
            <li>• Focus on client outcomes, not agent credentials</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
