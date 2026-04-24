"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Shield, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { scanContentCompliance } from "@/app/actions/compliance-monitoring"

interface ScanResult {
  issues: Array<{ type: string; category: string; severity: string; found?: string; message?: string }>
  warnings: Array<{ type: string; severity: string; disclosureType?: string; message?: string }>
  fair_housing_risk?: number
}

export function FairHousingScanner() {
  const [text, setText] = useState("")
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleScan() {
    if (!text.trim()) return
    setError(null)
    setResult(null)
    startTransition(async () => {
      try {
        const res = await scanContentCompliance({
          contentBody: text,
          contentType: "communication",
          targetAudience: "general",
          distributionChannels: ["email"],
          agentState: "CA",
        })
        setResult(res as ScanResult)
      } catch (err: any) {
        setError(err?.message ?? "Scan failed")
      }
    })
  }

  const issueCount = result?.issues?.length ?? 0
  const warningCount = result?.warnings?.length ?? 0
  const isClean = result && issueCount === 0 && warningCount === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield className="h-4 w-4 text-blue-600" />
          Fair Housing Content Scanner
        </CardTitle>
        <CardDescription>
          Paste any marketing text, listing description, or communication to scan for potential Fair Housing Act violations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="scan-text" className="text-sm">Content to Analyze</Label>
          <Textarea
            id="scan-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste listing description, email, or marketing copy here…"
            className="mt-1.5 min-h-[140px] text-sm"
          />
        </div>

        <Button onClick={handleScan} disabled={isPending || !text.trim()} size="sm" className="gap-1.5">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
          {isPending ? "Scanning…" : "Scan for Violations"}
        </Button>

        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

        {result && (
          <div className="space-y-3">
            {isClean ? (
              <Alert className="border-green-300 bg-green-50">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-800">
                  No compliance issues detected. Content appears compliant with Fair Housing standards.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {issueCount > 0 && (
                  <Alert className="border-red-300 bg-red-50">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <AlertDescription>
                      <p className="font-medium text-red-800 mb-2">{issueCount} issue{issueCount !== 1 ? "s" : ""} found</p>
                      <ul className="space-y-1">
                        {result.issues.map((issue, i) => (
                          <li key={i} className="text-sm text-red-700 flex items-start gap-2">
                            <Badge variant="destructive" className="text-xs shrink-0 mt-0.5">{issue.severity}</Badge>
                            <span>{issue.message ?? (issue.found ? `Prohibited phrase: "${issue.found}"` : issue.category?.replace(/_/g, " "))}</span>
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                {warningCount > 0 && (
                  <Alert className="border-yellow-300 bg-yellow-50">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription>
                      <p className="font-medium text-yellow-800 mb-2">{warningCount} warning{warningCount !== 1 ? "s" : ""}</p>
                      <ul className="space-y-1">
                        {result.warnings.map((w, i) => (
                          <li key={i} className="text-sm text-yellow-700">
                            {w.message ?? `Missing required disclosure: ${w.disclosureType?.replace(/_/g, " ")}`}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
