"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkles, AlertCircle, CheckCircle, Loader2 } from "lucide-react"
import { evaluateCompliance } from "@/app/actions/content-compliance"

interface Violation {
  rule_id: string
  rule_name: string
  severity: "critical" | "high" | "medium" | "low"
  message: string
}

interface ComplianceVerdict {
  status: "pass" | "fail" | "review_required"
  overall_score: number
  violations: Violation[]
  recommendations: string[]
}

export function AIComplianceReviewPanel() {
  const [content, setContent] = useState("")
  const [contentType, setContentType] = useState("email")
  const [channelIntent, setChannelIntent] = useState("marketing")
  const [verdict, setVerdict] = useState<ComplianceVerdict | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleEvaluate = () => {
    if (!content.trim()) return

    startTransition(async () => {
      const result = await evaluateCompliance({
        raw_content: content,
        content_type: contentType,
        channel_intent: channelIntent,
      })

      if (result.success && result.verdict) {
        setVerdict(result.verdict as unknown as ComplianceVerdict)
      }
    })
  }

  const severityColors = {
    critical: "bg-destructive text-destructive-foreground",
    high: "bg-orange-500 text-white",
    medium: "bg-yellow-500 text-yellow-950",
    low: "bg-blue-500 text-white",
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
          AI Compliance Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select value={contentType} onValueChange={setContentType}>
            <SelectTrigger>
              <SelectValue placeholder="Content Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
              <SelectItem value="social_post">Social Post</SelectItem>
              <SelectItem value="listing_description">Listing Description</SelectItem>
              <SelectItem value="marketing_flyer">Marketing Flyer</SelectItem>
            </SelectContent>
          </Select>
          <Select value={channelIntent} onValueChange={setChannelIntent}>
            <SelectTrigger>
              <SelectValue placeholder="Channel Intent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="marketing">Marketing</SelectItem>
              <SelectItem value="transactional">Transactional</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
              <SelectItem value="cold_outreach">Cold Outreach</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Textarea
          placeholder="Paste content to check for compliance issues..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[100px]"
        />

        <Button onClick={handleEvaluate} disabled={isPending || !content.trim()} className="w-full">
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Check Compliance
            </>
          )}
        </Button>

        {verdict && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {verdict.status === "pass" ? (
                  <CheckCircle className="h-5 w-5 text-green-600" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-destructive" />
                )}
                <span className="font-medium">
                  {verdict.status === "pass" ? "Content Approved" : verdict.status === "fail" ? "Issues Found" : "Review Required"}
                </span>
              </div>
              <Badge className={verdict.status === "pass" ? "bg-green-500 text-white" : "bg-destructive text-destructive-foreground"}>
                Score: {verdict.overall_score}/100
              </Badge>
            </div>

            {verdict.violations.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Issues Detected:</p>
                {verdict.violations.slice(0, 3).map((v, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Badge className={`${severityColors[v.severity]} text-[10px] shrink-0`}>
                      {v.severity}
                    </Badge>
                    <span className="text-muted-foreground">{v.message}</span>
                  </div>
                ))}
              </div>
            )}

            {verdict.recommendations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Recommendations:</p>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                  {verdict.recommendations.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
