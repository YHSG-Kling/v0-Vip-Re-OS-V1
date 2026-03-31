// app/components/features/admin/overage-calculator.tsx
// Usage + overage display and projection

"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { AlertCircle } from "lucide-react"
import { calculateOverageExposureAction } from "@/app/actions/admin/billing"

interface OverageCalculatorProps {
  brokerageId: string
  projectionDays?: number
}

interface OverageMetrics {
  current: number
  limit: number
  projected: number
  overage: number
}

export function OverageCalculator({ brokerageId, projectionDays = 30 }: OverageCalculatorProps) {
  const [metrics, setMetrics] = useState<Record<string, OverageMetrics> | null>(null)
  const [totalExposure, setTotalExposure] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const result = await calculateOverageExposureAction({
          brokerageId,
          projectionDays,
        })

        if (!result.success) {
          throw new Error(result.error || "Failed to calculate overage")
        }

        setMetrics(result.metrics || {})
        setTotalExposure(result.totalExposureCents || 0)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error")
      } finally {
        setLoading(false)
      }
    }

    fetchMetrics()
  }, [brokerageId, projectionDays])

  if (loading) {
    return <div className="p-6 text-center text-gray-500">Calculating overage...</div>
  }

  if (error) {
    return (
      <div className="p-6 bg-red-50 rounded-lg border border-red-200">
        <AlertCircle className="w-5 h-5 text-red-600 mb-2" />
        <p className="text-red-800">Error: {error}</p>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage & Overage Projection ({projectionDays}d)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {metrics &&
          Object.entries(metrics).map(([metricName, data]) => (
            <div key={metricName} className="pb-4 border-b last:border-b-0">
              <div className="flex justify-between items-center mb-2">
                <p className="font-medium capitalize">{metricName}</p>
                {data.overage > 0 && (
                  <span className="text-sm font-semibold text-orange-600">
                    ${(data.overage / 100).toFixed(2)} overage
                  </span>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2 text-sm">
                <div className="bg-gray-50 px-2 py-1 rounded">
                  <p className="text-gray-600">Current</p>
                  <p className="font-mono font-semibold">{Math.round(data.current)}</p>
                </div>
                <div className="bg-gray-50 px-2 py-1 rounded">
                  <p className="text-gray-600">Limit</p>
                  <p className="font-mono font-semibold">{Math.round(data.limit)}</p>
                </div>
                <div className="bg-gray-50 px-2 py-1 rounded">
                  <p className="text-gray-600">Projected</p>
                  <p className="font-mono font-semibold">{Math.round(data.projected)}</p>
                </div>
                <div
                  className={`px-2 py-1 rounded ${data.overage > 0 ? "bg-orange-50" : "bg-green-50"}`}
                >
                  <p className={data.overage > 0 ? "text-orange-600" : "text-green-600"}>
                    Status
                  </p>
                  <p className="font-mono font-semibold">
                    {data.overage > 0 ? "Over" : "OK"}
                  </p>
                </div>
              </div>
            </div>
          ))}

        <div className="mt-4 pt-4 border-t-2 bg-gray-50 p-3 rounded">
          <div className="flex justify-between">
            <span className="font-semibold">Total 30-day Exposure</span>
            <span className="font-mono font-bold text-lg">
              ${(totalExposure / 100).toFixed(2)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
