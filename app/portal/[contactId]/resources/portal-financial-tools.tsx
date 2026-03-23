"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Truck, Calculator, Clock, ChevronDown, ChevronUp } from "lucide-react"
import { estimateMovingCosts, saveCalculatorResult } from "@/app/actions/calculators"
import { useToast } from "@/hooks/use-toast"

type HomeSize = "studio" | "1br" | "2br" | "3br" | "4br+" | "house"

const HOME_SIZE_LABELS: Record<HomeSize, string> = {
  studio: "Studio",
  "1br": "1 Bedroom",
  "2br": "2 Bedrooms",
  "3br": "3 Bedrooms",
  "4br+": "4+ Bedrooms",
  house: "Full House",
}

const DISTANCE_OPTIONS = [
  { label: "Local (under 50 miles)", value: 25 },
  { label: "Regional (50–200 miles)", value: 100 },
  { label: "Long Distance (200+ miles)", value: 400 },
]

interface CalculatorHistoryEntry {
  id: string
  calculator_type: string
  inputs: any
  results: any
  created_at: string
}

interface PortalFinancialToolsProps {
  contactId: string
  calcHistory: CalculatorHistoryEntry[]
}

export function PortalFinancialTools({ contactId, calcHistory }: PortalFinancialToolsProps) {
  const { toast } = useToast()

  // Moving cost estimator state
  const [movingResult, setMovingResult] = useState<any>(null)
  const [movingLoading, setMovingLoading] = useState(false)
  const [currentCity, setCurrentCity] = useState("")
  const [currentState, setCurrentState] = useState("")
  const [newCity, setNewCity] = useState("")
  const [newState, setNewState] = useState("")
  const [homeSize, setHomeSize] = useState<HomeSize>("2br")
  const [distanceMiles, setDistanceMiles] = useState<number>(25)
  const [moveDate, setMoveDate] = useState("")

  // History expand/collapse
  const [historyOpen, setHistoryOpen] = useState(false)

  async function handleEstimateMoving() {
    if (!currentCity || !currentState || !newCity || !newState) {
      toast.error("Please fill in origin and destination")
      return
    }
    setMovingLoading(true)
    try {
      const res = await estimateMovingCosts({
        currentCity,
        currentState,
        newCity,
        newState,
        homeSize,
        distance: distanceMiles,
        moveDate: moveDate || new Date().toISOString().split("T")[0],
      })
      if (res.success) {
        setMovingResult(res)
        toast({ title: "Moving cost estimate ready" })
        // contactId is the truth — passed as leadId because the action param name predates
        // the portal contact model, but the underlying column accepts any UUID identity
        await saveCalculatorResult({
          leadId: contactId,
          calculatorType: "moving_cost",
          inputs: { currentCity, currentState, newCity, newState, homeSize, distanceMiles, moveDate },
          results: res,
        })
      }
    } catch {
      toast({ title: "Estimate failed — please try again", variant: "destructive" })
    } finally {
      setMovingLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Moving Cost Estimator */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-blue-600" />
            <CardTitle>Moving Cost Estimator</CardTitle>
          </div>
          <CardDescription>
            Get a rough estimate of what your move might cost
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm">Current City</Label>
              <Input
                placeholder="e.g. Austin"
                value={currentCity}
                onChange={(e) => setCurrentCity(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Current State</Label>
              <Input
                placeholder="e.g. TX"
                maxLength={2}
                value={currentState}
                onChange={(e) => setCurrentState(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Destination City</Label>
              <Input
                placeholder="e.g. Dallas"
                value={newCity}
                onChange={(e) => setNewCity(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Destination State</Label>
              <Input
                placeholder="e.g. TX"
                maxLength={2}
                value={newState}
                onChange={(e) => setNewState(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-sm">Home Size</Label>
              <Select value={homeSize} onValueChange={(v) => setHomeSize(v as HomeSize)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(HOME_SIZE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Distance</Label>
              <Select
                value={String(distanceMiles)}
                onValueChange={(v) => setDistanceMiles(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-sm">Target Move Date (optional)</Label>
            <input
              type="date"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={moveDate}
              onChange={(e) => setMoveDate(e.target.value)}
            />
          </div>

          <Button onClick={handleEstimateMoving} disabled={movingLoading} className="w-full">
            {movingLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Calculator className="h-4 w-4 mr-2" />
            )}
            Estimate Moving Costs
          </Button>

          {/* Result */}
          {movingResult && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-blue-900">Total Estimated Cost</span>
                <span className="text-xl font-bold text-blue-700">
                  ${Number(movingResult.total_estimated_cost).toLocaleString()}
                </span>
              </div>
              <div className="space-y-1.5 pt-2 border-t border-blue-200">
                {Object.entries(movingResult.cost_breakdown as Record<string, number>).map(([key, val]) => (
                  <div key={key} className="flex items-center justify-between text-sm text-blue-800">
                    <span className="capitalize">{key.replace(/_/g, " ")}</span>
                    <span>${Number(val).toLocaleString()}</span>
                  </div>
                ))}
              </div>
              {movingResult.moving_timeline && (
                <div className="pt-2 border-t border-blue-200">
                  <p className="text-sm font-medium text-blue-900 mb-2">Moving Timeline</p>
                  <div className="space-y-1">
                    {Object.entries(movingResult.moving_timeline as Record<string, string[]>).map(([phase, tasks]) => (
                      <div key={phase} className="text-xs text-blue-800">
                        <span className="font-medium capitalize">{phase.replace(/_/g, " ")}: </span>
                        {(tasks as string[]).slice(0, 2).join(", ")}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Calculator History */}
      {calcHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <button
              className="flex items-center justify-between w-full text-left"
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-slate-500" />
                <CardTitle>Your Calculator History</CardTitle>
                <Badge variant="secondary" className="text-xs">{calcHistory.length}</Badge>
              </div>
              {historyOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            <CardDescription>Past calculations saved to your account</CardDescription>
          </CardHeader>
          {historyOpen && (
            <CardContent className="space-y-3">
              {calcHistory.map((entry) => (
                <div key={entry.id} className="p-3 rounded-lg border space-y-1">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="text-xs capitalize">
                      {entry.calculator_type.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {entry.results?.net_proceeds != null && (
                    <p className="text-sm font-medium">
                      Net Proceeds: ${Number(entry.results.net_proceeds).toLocaleString()}
                    </p>
                  )}
                  {entry.results?.total_estimated_cost != null && (
                    <p className="text-sm font-medium">
                      Moving Cost: ${Number(entry.results.total_estimated_cost).toLocaleString()}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}
    </div>
  )
}
