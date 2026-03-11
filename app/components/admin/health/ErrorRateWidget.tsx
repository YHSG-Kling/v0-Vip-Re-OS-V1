"use client"

import { useState } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { type AutomationError } from "@/app/actions/system-health"

interface ErrorRateWidgetProps {
  data: {
    errors: AutomationError[]
    byWorkflow: Record<string, { count: number; severity: string }[]>
  }
}

const severityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#9ca3af",
}

export function ErrorRateWidget({ data }: ErrorRateWidgetProps) {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)

  // Transform data for chart
  const chartData = Object.entries(data.byWorkflow)
    .map(([workflow, severities]) => ({
      workflow: workflow.length > 20 ? workflow.slice(0, 20) + "..." : workflow,
      fullName: workflow,
      total: severities.reduce((sum, s) => sum + s.count, 0),
      critical: severities.find((s) => s.severity === "critical")?.count || 0,
      high: severities.find((s) => s.severity === "high")?.count || 0,
      medium: severities.find((s) => s.severity === "medium")?.count || 0,
      low: severities.find((s) => s.severity === "low")?.count || 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  const workflowErrors = selectedWorkflow
    ? data.errors.filter((e) => e.workflow_name === selectedWorkflow)
    : []

  if (chartData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No errors in the last 7 days
      </div>
    )
  }

  return (
    <>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ left: 0, right: 20 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} />
            <XAxis type="number" tick={{ fontSize: 12 }} />
            <YAxis
              type="category"
              dataKey="workflow"
              tick={{ fontSize: 11 }}
              width={120}
            />
            <Tooltip
              formatter={(value: number, name: string) => [value, name]}
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
              }}
            />
            <Bar
              dataKey="total"
              radius={[0, 4, 4, 0]}
              cursor="pointer"
              onClick={(data) => setSelectedWorkflow(data.fullName)}
            >
              {chartData.map((entry, index) => {
                // Color based on highest severity
                let color = severityColors.low
                if (entry.critical > 0) color = severityColors.critical
                else if (entry.high > 0) color = severityColors.high
                else if (entry.medium > 0) color = severityColors.medium
                return <Cell key={`cell-${index}`} fill={color} />
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <Sheet open={!!selectedWorkflow} onOpenChange={() => setSelectedWorkflow(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Errors: {selectedWorkflow}</SheetTitle>
            <SheetDescription>
              {workflowErrors.length} error{workflowErrors.length !== 1 ? "s" : ""} in the last 7 days
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            {workflowErrors.map((error) => (
              <div
                key={error.id}
                className="rounded border p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <Badge
                    variant={
                      error.severity === "critical" || error.severity === "high"
                        ? "destructive"
                        : "secondary"
                    }
                    style={{
                      backgroundColor:
                        error.severity === "critical"
                          ? "rgb(239 68 68 / 0.1)"
                          : error.severity === "high"
                            ? "rgb(249 115 22 / 0.1)"
                            : undefined,
                      color:
                        error.severity === "critical"
                          ? "#ef4444"
                          : error.severity === "high"
                            ? "#f97316"
                            : undefined,
                    }}
                  >
                    {error.severity}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(error.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm">{error.error_message}</p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Status: {error.status}</span>
                  {error.resolved_at && (
                    <span>Resolved: {new Date(error.resolved_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
