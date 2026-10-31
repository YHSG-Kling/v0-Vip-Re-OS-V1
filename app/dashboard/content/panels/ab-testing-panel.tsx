"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, FlaskConical } from "lucide-react"
import { toast } from "sonner"
import { createABTest, analyzeABTest, updateABTestResults } from "@/app/actions/ai-content-generation"
import { AB_TEST_VARIABLES } from "@/app/actions/ai-content-generation.utils"

export function AbTestingPanel({ drafts, onChanged }: { drafts: any[]; onChanged: () => void }) {
  const [isPending, startTransition] = useTransition()

  // create
  const [variantA, setVariantA] = useState("")
  const [variantB, setVariantB] = useState("")
  const [variable, setVariable] = useState<(typeof AB_TEST_VARIABLES)[number]>("subject_line")
  const [sampleSize, setSampleSize] = useState("100")
  const [createdTests, setCreatedTests] = useState<any[]>([])

  // analyse / record
  const [testId, setTestId] = useState("")
  const [analysis, setAnalysis] = useState<any>(null)
  const [rateA, setRateA] = useState("")
  const [rateB, setRateB] = useState("")
  const [manualWinner, setManualWinner] = useState<"A" | "B" | "none">("none")

  const handleCreate = () => {
    startTransition(async () => {
      const res = await createABTest({
        baseContentId: variantA,
        // Omitting variantBId makes the AI write the B side; supplying it
        // registers two pieces you already have.
        variantBId: variantB || undefined,
        testVariable: variable,
        sampleSize: Number(sampleSize) || 100,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Test created")
      setCreatedTests((prev) => [res.test, ...prev])
      setTestId(res.test.id)
      onChanged()
    })
  }

  const handleAnalyze = () => {
    startTransition(async () => {
      const res = await analyzeABTest(testId)
      if (!res.success) {
        setAnalysis(null)
        toast.error(res.error)
        return
      }
      setAnalysis(res.data)
      toast.success(`Variant ${res.data.winner} is ahead`)
      onChanged()
    })
  }

  const handleRecord = () => {
    startTransition(async () => {
      const res = await updateABTestResults(testId, {
        variantA: { engagement_rate: Number(rateA) || 0 },
        variantB: { engagement_rate: Number(rateB) || 0 },
        winner: manualWinner === "none" ? undefined : manualWinner,
      })
      if (!res.success) { toast.error(res.error); return }
      toast.success("Results recorded")
      onChanged()
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <FlaskConical className="h-4 w-4" /> New A/B test
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Variant A</Label>
              <Select value={variantA} onValueChange={setVariantA}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick the baseline" />
                </SelectTrigger>
                <SelectContent>
                  {drafts.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title || d.content_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Variant B (leave empty to let AI write it)</Label>
              <Select value={variantB || "__ai__"} onValueChange={(v) => setVariantB(v === "__ai__" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__ai__">Generate with AI</SelectItem>
                  {drafts
                    .filter((d) => d.id !== variantA)
                    .map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.title || d.content_type}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>What varies</Label>
              <Select value={variable} onValueChange={(v) => setVariable(v as typeof variable)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AB_TEST_VARIABLES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Sample size per variant</Label>
              <Input type="number" min={1} value={sampleSize} onChange={(e) => setSampleSize(e.target.value)} />
            </div>
          </div>
          <Button onClick={handleCreate} disabled={isPending || !variantA}>
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Create test
          </Button>

          {createdTests.length > 0 && (
            <div className="divide-y">
              {createdTests.map((t) => (
                <div key={t.id} className="py-2 flex items-center justify-between text-xs">
                  <span className="font-medium">{t.test_name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Read a test out</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Test ID</Label>
            <Input value={testId} onChange={(e) => setTestId(e.target.value)} placeholder="UUID of the test" />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Analyse derives the winner from tracked performance. Record results if you measured them elsewhere.
            </p>
            <Button variant="outline" onClick={handleAnalyze} disabled={isPending || !testId.trim()}>
              {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Analyse from tracked performance
            </Button>
          </div>

          {analysis && (
            <div className="rounded-md border p-3 space-y-1 text-xs">
              <p className="text-sm font-medium">
                Variant {analysis.winner} · {analysis.improvement} better · {analysis.confidence} confidence
              </p>
              <p className="text-muted-foreground">
                A: {analysis.variantARate.toFixed(2)} · B: {analysis.variantBRate.toFixed(2)}
              </p>
              <p>{analysis.recommendation}</p>
            </div>
          )}

          <div className="border-t pt-3 space-y-3">
            <Label className="text-xs">Or record results measured elsewhere</Label>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                type="number"
                step="0.01"
                placeholder="A engagement rate"
                value={rateA}
                onChange={(e) => setRateA(e.target.value)}
              />
              <Input
                type="number"
                step="0.01"
                placeholder="B engagement rate"
                value={rateB}
                onChange={(e) => setRateB(e.target.value)}
              />
              <Select value={manualWinner} onValueChange={(v) => setManualWinner(v as typeof manualWinner)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Still running</SelectItem>
                  <SelectItem value="A">A won</SelectItem>
                  <SelectItem value="B">B won</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={handleRecord} disabled={isPending || !testId.trim()}>
              Record results
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
